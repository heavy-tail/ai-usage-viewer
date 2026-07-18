param(
  [switch] $ServerOnly,
  [switch] $SkipLaunchRefresh
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ApiUrl = "http://127.0.0.1:4317/api/snapshot"
$IdentityUrl = "http://127.0.0.1:4317/api/identity"
$RefreshUrl = "http://127.0.0.1:4317/api/refresh"
$AppUrl = "http://127.0.0.1:4317/"
$LogDir = Join-Path $RootDir "data/logs"
$ServerStatePath = Join-Path $LogDir "desktop-server-state.json"
$ServerStarted = $false
$ServerProcess = $null

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-HttpOk {
  param(
    [string] $Url,
    [string] $MustContain
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    # Require a real 200, not just "any non-5xx". A stray local process bound to
    # the same port that answers 404 must NOT count as our service being up.
    if ($response.StatusCode -ne 200) {
      return $false
    }
    # And require an identifying token so we don't latch onto an unrelated app.
    if ($MustContain -and ($response.Content -notlike "*$MustContain*")) {
      return $false
    }
    return $true
  } catch {
    return $false
  }
}

function Wait-HttpOk {
  param(
    [string] $Url,
    [int] $TimeoutSeconds = 20,
    [string] $MustContain
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk -Url $Url -MustContain $MustContain) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }

  return $false
}

function Start-HiddenNpm {
  param(
    [string[]] $Arguments,
    [string] $LogName
  )

  return Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList $Arguments `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "$LogName.log") `
    -RedirectStandardError (Join-Path $LogDir "$LogName.err")
}

function Get-BackendFingerprint {
  $files = @(
    Get-ChildItem (Join-Path $RootDir "src") -Recurse -File |
      Where-Object { $_.Extension -in @(".ts", ".tsx") }
    Get-Item (Join-Path $RootDir "package.json")
    Get-Item (Join-Path $RootDir "package-lock.json")
    Get-Item (Join-Path $RootDir "tsconfig.json")
  ) | Sort-Object FullName

  $manifest = ($files | ForEach-Object {
    $relative = $_.FullName.Substring($RootDir.Length)
    $hash = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash
    "$relative|$hash"
  }) -join "`n"

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($manifest)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-ManagedServerState {
  if (-not (Test-Path $ServerStatePath)) {
    return $null
  }
  try {
    return Get-Content -Raw $ServerStatePath | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-VerifiedStateProcess {
  param([object] $State)

  if (-not $State -or
      [string]$State.backendFingerprint -notmatch '^[a-fA-F0-9]{64}$') {
    return $null
  }
  try {
    $managedProcess = Get-Process -Id ([int]$State.pid) -ErrorAction Stop
    $recordedStart = [DateTime]::Parse([string]$State.processStartedAtUtc).ToUniversalTime()
    $actualStart = $managedProcess.StartTime.ToUniversalTime()
    if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 5) {
      return $null
    }
    return $managedProcess
  } catch {
    return $null
  }
}

function Get-ServerIdentity {
  try {
    $identity = Invoke-RestMethod -Uri $IdentityUrl -TimeoutSec 2
    if ([string]$identity.service -ne "ai-usage-viewer" -or
        [int]$identity.version -ne 1 -or
        [int]$identity.pid -le 0) {
      return $null
    }

    $fingerprint = $null
    if ($null -ne $identity.sourceFingerprint) {
      $fingerprint = ([string]$identity.sourceFingerprint).ToLowerInvariant()
      if ($fingerprint -notmatch '^[a-f0-9]{64}$') {
        return $null
      }
    }

    $startedAt = [DateTime]::Parse([string]$identity.processStartedAtUtc).ToUniversalTime()
    return [pscustomobject]@{
      service = "ai-usage-viewer"
      version = 1
      sourceFingerprint = $fingerprint
      pid = [int]$identity.pid
      processStartedAtUtc = $startedAt.ToString("o")
    }
  } catch {
    return $null
  }
}

function Get-VerifiedIdentityProcess {
  param([object] $Identity)

  if (-not $Identity) {
    return $null
  }
  try {
    $serverProcess = Get-Process -Id ([int]$Identity.pid) -ErrorAction Stop
    $reportedStart = [DateTime]::Parse([string]$Identity.processStartedAtUtc).ToUniversalTime()
    $actualStart = $serverProcess.StartTime.ToUniversalTime()
    if ([Math]::Abs(($actualStart - $reportedStart).TotalSeconds) -gt 5) {
      return $null
    }
    return $serverProcess
  } catch {
    return $null
  }
}

function Test-LegacyUsageApi {
  try {
    $body = Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 2
    if ($null -eq $body.PSObject.Properties["snapshot"]) {
      return $false
    }
    $snapshot = $body.snapshot
    if ($null -eq $snapshot -or
        $null -eq $snapshot.PSObject.Properties["generatedAt"] -or
        $null -eq $snapshot.PSObject.Properties["collectors"] -or
        $null -eq $snapshot.PSObject.Properties["limits"]) {
      return $false
    }
    foreach ($collector in @($snapshot.collectors)) {
      if ([string]$collector.provider -notin @("claude", "codex", "agy", "grok")) {
        return $false
      }
    }
    return $true
  } catch {
    return $false
  }
}

function Get-VerifiedLegacyListenerProcess {
  # A pre-identity server may have no usable state file. In that case, prove
  # ownership from the actual loopback listener and its command line. The
  # legacy npm script always ran this repo's tsx loader with src/server.ts; both
  # the absolute loader path and entrypoint must match before it can be stopped.
  try {
    $listeners = @(
      Get-NetTCPConnection `
        -LocalAddress "127.0.0.1" `
        -LocalPort 4317 `
        -State Listen `
        -ErrorAction Stop
    )
    if ($listeners.Count -ne 1) {
      return $null
    }

    $ownerPid = [int]$listeners[0].OwningProcess
    $record = Get-CimInstance `
      Win32_Process `
      -Filter "ProcessId = $ownerPid" `
      -ErrorAction Stop
    if (-not $record -or
        [System.IO.Path]::GetFileName([string]$record.ExecutablePath) -ine "node.exe") {
      return $null
    }

    $commandLine = [string]$record.CommandLine
    $expectedRuntime = Join-Path $RootDir "node_modules\tsx\dist"
    if ($commandLine.IndexOf(
          $expectedRuntime,
          [System.StringComparison]::OrdinalIgnoreCase
        ) -lt 0 -or
        $commandLine -notmatch '(?i)(?:^|[\s"])src[\\/]server\.ts(?:[\s"]|$)') {
      return $null
    }

    return Get-Process -Id $ownerPid -ErrorAction Stop
  } catch {
    # Listener/process inspection can be unavailable under a locked-down
    # policy. Failing closed leaves the unknown process untouched.
    return $null
  }
}

function Test-ViewerPortOpen {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.ConnectAsync("127.0.0.1", 4317)
    return $connect.Wait(300) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Stop-VerifiedServerProcess {
  param([object] $Process)

  try {
    $current = Get-Process -Id ([int]$Process.Id) -ErrorAction Stop
    if ([Math]::Abs(
          ($current.StartTime.ToUniversalTime() -
           $Process.StartTime.ToUniversalTime()).TotalSeconds
        ) -gt 2) {
      throw "PID was reused."
    }
  } catch {
    throw "The verified AI Usage Viewer process changed before restart, so it was left untouched."
  }

  & taskkill.exe /pid $Process.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restart the verified AI Usage Viewer server."
  }

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Test-ViewerPortOpen)) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-ViewerPortOpen) {
    throw "The verified AI Usage Viewer server did not release port 4317."
  }
  Remove-Item -LiteralPath $ServerStatePath -Force -ErrorAction SilentlyContinue
}

function Save-ManagedServerState {
  param(
    [object] $Identity,
    [string] $BackendFingerprint
  )

  $state = @{
    service = "ai-usage-viewer"
    identityVersion = 1
    pid = [int]$Identity.pid
    processStartedAtUtc = [string]$Identity.processStartedAtUtc
    backendFingerprint = $BackendFingerprint
  }
  $json = $state | ConvertTo-Json -Compress
  $tempPath = "$ServerStatePath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $backupPath = "$ServerStatePath.$PID.$([Guid]::NewGuid().ToString('N')).bak"
  try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempPath, $json, $utf8)
    if (Test-Path $ServerStatePath) {
      # Windows PowerShell 5/.NET Framework rejects a null backup path even
      # though newer runtimes accept it. A same-directory backup keeps the
      # replacement atomic across both runtimes and is removed immediately.
      [System.IO.File]::Replace($tempPath, $ServerStatePath, $backupPath, $true)
    } else {
      [System.IO.File]::Move($tempPath, $ServerStatePath)
    }
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
}

function Start-ManagedServer {
  param([string] $BackendFingerprint)

  $hadFingerprint = Test-Path Env:\USAGE_VIEWER_SOURCE_FINGERPRINT
  $previousFingerprint = $env:USAGE_VIEWER_SOURCE_FINGERPRINT
  try {
    $env:USAGE_VIEWER_SOURCE_FINGERPRINT = $BackendFingerprint
    return Start-HiddenNpm -Arguments @("start") -LogName "desktop-server"
  } finally {
    if ($hadFingerprint) {
      $env:USAGE_VIEWER_SOURCE_FINGERPRINT = $previousFingerprint
    } else {
      Remove-Item Env:\USAGE_VIEWER_SOURCE_FINGERPRINT -ErrorAction SilentlyContinue
    }
  }
}

function Get-HealthyManagedIdentity {
  param([string] $BackendFingerprint)

  $identity = Get-ServerIdentity
  if (-not $identity -or
      [string]$identity.sourceFingerprint -ne $BackendFingerprint -or
      -not (Get-VerifiedIdentityProcess -Identity $identity) -or
      -not (Test-HttpOk -Url $AppUrl -MustContain 'id="root"')) {
    return $null
  }
  return $identity
}

function Wait-ForSpawnedServer {
  param(
    [object] $LauncherProcess,
    [string] $BackendFingerprint,
    [int] $TimeoutSeconds = 25
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $identity = $null
  while ((Get-Date) -lt $deadline) {
    $LauncherProcess.Refresh()
    if ($LauncherProcess.HasExited) {
      throw "AI Usage Viewer exited during startup. See data/logs/desktop-server.err."
    }
    $identity = Get-HealthyManagedIdentity -BackendFingerprint $BackendFingerprint
    if ($identity) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $identity) {
    throw "AI Usage Viewer did not start. See data/logs/desktop-server.err."
  }

  # Do not persist a PID from a process that only became healthy briefly and
  # then crashed. Re-check both the npm parent and the identified server after
  # a small stability window.
  Start-Sleep -Milliseconds 750
  $LauncherProcess.Refresh()
  $stableIdentity = Get-HealthyManagedIdentity -BackendFingerprint $BackendFingerprint
  if ($LauncherProcess.HasExited -or
      -not $stableIdentity -or
      [int]$stableIdentity.pid -ne [int]$identity.pid) {
    throw "AI Usage Viewer did not remain healthy after startup. See data/logs/desktop-server.err."
  }
  return $stableIdentity
}

function Ensure-ProductionBuild {
  $indexPath = Join-Path $RootDir "dist/index.html"
  $buildRequired = -not (Test-Path $indexPath)
  if (-not $buildRequired) {
    $builtAt = (Get-Item $indexPath).LastWriteTimeUtc
    $inputs = @(
      Get-ChildItem (Join-Path $RootDir "src"), (Join-Path $RootDir "public") -Recurse -File
      Get-Item (Join-Path $RootDir "index.html"), (Join-Path $RootDir "package-lock.json"), (Join-Path $RootDir "vite.config.ts")
    )
    $buildRequired = $null -ne ($inputs | Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1)
  }

  if (-not $buildRequired) {
    return
  }

  $process = Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", "build") `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -Wait `
    -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "desktop-build.log") `
    -RedirectStandardError (Join-Path $LogDir "desktop-build.err")

  if ($process.ExitCode -ne 0 -or -not (Test-Path $indexPath)) {
    throw "Could not build the dashboard. See data/logs/desktop-build.err."
  }
}

function Start-LaunchRefresh {
  $script = @"
`$ErrorActionPreference = "Stop"
try {
  Invoke-RestMethod -Uri "$RefreshUrl" -Method Post | Out-Null
  "Refresh completed at `$((Get-Date).ToString("s"))" | Set-Content -Path "$((Join-Path $LogDir "desktop-refresh.log"))"
} catch {
  `$_.Exception.Message | Set-Content -Path "$((Join-Path $LogDir "desktop-refresh.err"))"
}
"@

  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", $script) `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden | Out-Null
}

function Find-AppBrowser {
  $candidates = @(
    (Get-Command "msedge.exe" -ErrorAction SilentlyContinue).Source,
    (Get-Command "chrome.exe" -ErrorAction SilentlyContinue).Source,
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft/Edge/Application/msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft/Edge/Application/msedge.exe"),
    (Join-Path $env:ProgramFiles "Google/Chrome/Application/chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google/Chrome/Application/chrome.exe")
  )

  return $candidates |
    Where-Object { $_ -and (Test-Path $_) } |
    Select-Object -First 1
}

function Open-AppWindow {
  param([string] $Url)

  $browser = Find-AppBrowser
  if ($browser) {
    Start-Process -FilePath $browser -ArgumentList @("--app=$Url") | Out-Null
    return
  }

  Start-Process $Url
}

$LauncherMutex = [System.Threading.Mutex]::new(
  $false,
  "Local\AIUsageViewerDesktopLauncher-4317"
)
$MutexAcquired = $false
try {
  try {
    $MutexAcquired = $LauncherMutex.WaitOne([TimeSpan]::FromSeconds(120))
  } catch [System.Threading.AbandonedMutexException] {
    # The previous launcher exited without releasing the mutex; this process
    # nevertheless owns it now and can safely recover the managed server.
    $MutexAcquired = $true
  }
  if (-not $MutexAcquired) {
    throw "Another AI Usage Viewer launcher is still starting the app."
  }

  $BackendFingerprint = Get-BackendFingerprint
  Ensure-ProductionBuild
  $ServerAvailable = $false
  $identity = Get-ServerIdentity

  if ($identity) {
    $identityProcess = Get-VerifiedIdentityProcess -Identity $identity
    if (-not $identityProcess) {
      throw "Port 4317 claimed to be AI Usage Viewer, but its process identity could not be verified. It was left untouched."
    }

    if ([string]$identity.sourceFingerprint -eq $BackendFingerprint -and
        (Test-HttpOk -Url $AppUrl -MustContain 'id="root"')) {
      # A missing or corrupt state file is harmless when the live identity is
      # verifiable. Repair it atomically so future upgrades remain manageable.
      Save-ManagedServerState -Identity $identity -BackendFingerprint $BackendFingerprint
      $ServerAvailable = $true
    } else {
      # This is definitely our server, but it is an older source build or an
      # API-only instance. Replace it without exposing migration work to users.
      Stop-VerifiedServerProcess -Process $identityProcess
    }
  } elseif (Test-LegacyUsageApi) {
    # Servers from before the identity endpoint can still be migrated. Prefer
    # proving the actual listener runs this exact repo; retain verified legacy
    # PID/start state as a fallback for systems that restrict listener queries.
    $legacyProcess = Get-VerifiedLegacyListenerProcess
    if (-not $legacyProcess) {
      $legacyProcess = Get-VerifiedStateProcess -State (Read-ManagedServerState)
    }
    if (-not $legacyProcess) {
      throw "A legacy API is using port 4317, but its listener and managed state could not be verified. It was left untouched."
    }
    Stop-VerifiedServerProcess -Process $legacyProcess
  } elseif (Test-ViewerPortOpen) {
    throw "Port 4317 belongs to an unverified process. It was left untouched."
  }

  if (-not $ServerAvailable) {
    $ServerProcess = Start-ManagedServer -BackendFingerprint $BackendFingerprint
    $stableIdentity = Wait-ForSpawnedServer `
      -LauncherProcess $ServerProcess `
      -BackendFingerprint $BackendFingerprint
    Save-ManagedServerState `
      -Identity $stableIdentity `
      -BackendFingerprint $BackendFingerprint
    $ServerStarted = $true
  }

  if ($ServerStarted -and -not $SkipLaunchRefresh) {
    Start-LaunchRefresh
    Start-Sleep -Milliseconds 700
  }

  if (-not $ServerOnly) {
    Open-AppWindow $AppUrl
  }
} finally {
  if ($MutexAcquired) {
    $LauncherMutex.ReleaseMutex()
  }
  $LauncherMutex.Dispose()
}
