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
    Get-Item (Join-Path $RootDir "scripts/AgyJobHost.cs")
    Get-Item (Join-Path $RootDir "scripts/build-agy-job-host.ps1")
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

function ConvertFrom-WindowsCommandLine {
  param([string] $CommandLine)

  if (-not ("UsageViewer.LauncherCommandLine" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace UsageViewer {
  public static class LauncherCommandLine {
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string[] Split(string commandLine) {
      int count;
      IntPtr arguments = CommandLineToArgvW(commandLine, out count);
      if (arguments == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      try {
        string[] result = new string[count];
        for (int index = 0; index < count; index++) {
          IntPtr value = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
          result[index] = Marshal.PtrToStringUni(value);
        }
        return result;
      } finally {
        LocalFree(arguments);
      }
    }
  }
}
'@ | Out-Null
  }

  return [UsageViewer.LauncherCommandLine]::Split($CommandLine)
}

function Resolve-ViewerCommandFileArgument {
  param([string] $Argument)

  if ([string]::IsNullOrWhiteSpace($Argument)) {
    return $null
  }

  try {
    $candidate = $Argument
    if ($Argument.StartsWith("file:", [System.StringComparison]::OrdinalIgnoreCase)) {
      $uri = [Uri]$Argument
      if (-not $uri.IsAbsoluteUri -or
          -not $uri.IsFile -or
          $uri.Query.Length -gt 0 -or
          $uri.Fragment.Length -gt 0) {
        return $null
      }
      $candidate = $uri.LocalPath
    } elseif ($Argument -match '^[a-zA-Z][a-zA-Z0-9+.-]*:' -and
              $Argument -notmatch '^[a-zA-Z]:[\\/]') {
      # Reject non-file URI schemes rather than treating them as relative paths.
      return $null
    }

    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
      $candidate = Join-Path $RootDir $candidate
    }
    return [System.IO.Path]::GetFullPath($candidate).TrimEnd("\")
  } catch {
    return $null
  }
}

function Test-ViewerServerCommand {
  param([string] $CommandLine)

  $arguments = @(ConvertFrom-WindowsCommandLine -CommandLine $CommandLine)
  if ($arguments.Count -lt 2) {
    return $false
  }

  $serverEntry = [System.IO.Path]::GetFullPath(
    (Join-Path $RootDir "src\server.ts")
  ).TrimEnd("\")
  $runtimeRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\tsx\dist")
  ).TrimEnd("\")
  $runtimePrefix = "$runtimeRoot\"
  $entryPoint = $null
  $hasRepoRuntimeLoader = $false

  for ($index = 1; $index -lt $arguments.Count; $index++) {
    $argument = [string]$arguments[$index]

    # Only a value attached to Node's actual loader switches can prove that
    # this checkout's tsx runtime is active. A path supplied as an arbitrary
    # application argument is not authority to terminate the listener.
    $loaderArgument = $null
    if ($argument -match '^(?i)--(?:import|require)=(.+)$') {
      $loaderArgument = $Matches[1]
    } elseif ($argument -in @("--import", "--require", "-r")) {
      if ($index + 1 -ge $arguments.Count) {
        return $false
      }
      $index++
      $loaderArgument = [string]$arguments[$index]
    }

    if ($loaderArgument) {
      $canonicalLoader = Resolve-ViewerCommandFileArgument `
        -Argument $loaderArgument
      if ($canonicalLoader -and $canonicalLoader.StartsWith(
            $runtimePrefix,
            [System.StringComparison]::OrdinalIgnoreCase
          )) {
        $hasRepoRuntimeLoader = $true
      }
      continue
    }

    # Fail closed when Node is running code through an alternate execution
    # mode. In those modes a later server.ts token can be only an argument,
    # not the program that owns the listener.
    if ($argument -match '^(?i)(?:-e(?:$|=|[^-])|--eval(?:$|=)|-p(?:$|=|[^-])|--print(?:$|=)|-c$|--check$|--run(?:$|=)|--test(?:$|=|-))') {
      return $false
    }

    # A lone dash executes JavaScript from stdin. After Node's end-of-options
    # marker, the very next token is the entry point even when it starts with
    # a dash; never interpret later tokens as Node loader switches.
    if ($argument -eq "-") {
      return $false
    }
    if ($argument -eq "--") {
      if ($index + 1 -ge $arguments.Count) {
        return $false
      }
      $index++
      $entryPoint = Resolve-ViewerCommandFileArgument `
        -Argument ([string]$arguments[$index])
      break
    }

    # Remaining dash-prefixed values are Node flags. The first non-option
    # token is Node's actual application entry point; ignore all later
    # application arguments so decoy paths cannot satisfy this proof.
    if ($argument.StartsWith("-", [System.StringComparison]::Ordinal)) {
      continue
    }
    $entryPoint = Resolve-ViewerCommandFileArgument -Argument $argument
    break
  }

  return $hasRepoRuntimeLoader -and
    $entryPoint -and
    $entryPoint.Equals(
      $serverEntry,
      [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-VerifiedViewerListenerProcess {
  param(
    [int] $ExpectedProcessId = 0,
    [string] $ExpectedStartedAtUtc
  )

  # A PID, state file, or HTTP response is never sufficient authority to stop
  # a process. Prove that the PID owns the exact loopback listener and that its
  # command uses this checkout's tsx runtime to run this checkout's server.
  try {
    $ownerPids = @()
    try {
      $ownerPids = @(
        Get-NetTCPConnection `
          -LocalAddress "127.0.0.1" `
          -LocalPort 4317 `
          -State Listen `
          -ErrorAction Stop |
          ForEach-Object { [int]$_.OwningProcess }
      )
    } catch {
      # Some standard-user policies deny the NetTCPConnection CIM provider.
      # netstat still reports the kernel's listener/PID mapping without
      # requiring elevation; accept only one exact IPv4 LISTENING row.
      $netstatPath = Join-Path $env:SystemRoot "System32\netstat.exe"
      $netstatOutput = @(& $netstatPath -ano -p tcp 2>$null)
      if ($LASTEXITCODE -ne 0) {
        return $null
      }
      $ownerPids = @(
        $netstatOutput | ForEach-Object {
          if ($_ -match '^\s*TCP\s+127\.0\.0\.1:4317\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            [int]$Matches[1]
          }
        }
      )
    }

    $ownerPids = @($ownerPids | Select-Object -Unique)
    if ($ownerPids.Count -ne 1) {
      return $null
    }

    $ownerPid = [int]$ownerPids[0]
    if ($ExpectedProcessId -gt 0 -and $ownerPid -ne $ExpectedProcessId) {
      return $null
    }

    $record = Get-CimInstance `
      Win32_Process `
      -Filter "ProcessId = $ownerPid" `
      -ErrorAction Stop
    if (-not $record -or
        [System.IO.Path]::GetFileName([string]$record.ExecutablePath) -ine "node.exe") {
      return $null
    }

    if (-not (Test-ViewerServerCommand -CommandLine ([string]$record.CommandLine))) {
      return $null
    }

    $listenerProcess = Get-Process -Id $ownerPid -ErrorAction Stop
    if ($ExpectedStartedAtUtc) {
      $expectedStart = [DateTime]::Parse($ExpectedStartedAtUtc).ToUniversalTime()
      $actualStart = $listenerProcess.StartTime.ToUniversalTime()
      if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 5) {
        return $null
      }
    }

    return $listenerProcess
  } catch {
    # Listener/process inspection can be unavailable under a locked-down
    # policy. Failing closed leaves the unknown process untouched.
    return $null
  }
}

function Get-VerifiedLegacyListenerProcess {
  # Legacy servers have no identity endpoint, so only actual listener ownership
  # plus the repository-specific command can authorize a migration restart.
  return Get-VerifiedViewerListenerProcess
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

  $expectedPid = [int]$Process.Id
  $expectedStart = $Process.StartTime.ToUniversalTime().ToString("o")

  # Verify twice here, independently of the caller. The final check is
  # deliberately adjacent to taskkill to narrow the unavoidable PID-reuse
  # race between Windows process inspection and tree termination.
  $verified = Get-VerifiedViewerListenerProcess `
    -ExpectedProcessId $expectedPid `
    -ExpectedStartedAtUtc $expectedStart
  if (-not $verified) {
    throw "The verified AI Usage Viewer process changed before restart, so it was left untouched."
  }

  $verified = Get-VerifiedViewerListenerProcess `
    -ExpectedProcessId $expectedPid `
    -ExpectedStartedAtUtc $expectedStart
  if (-not $verified) {
    throw "The verified AI Usage Viewer process changed before restart, so it was left untouched."
  }

  $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
  & $taskkillPath /pid $expectedPid /T /F | Out-Null
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
  $jobHostPath = Join-Path $RootDir ".runtime/agy-job-host.exe"
  $jobHostStampPath = Join-Path $RootDir ".runtime/agy-job-host.source.sha256"
  $buildRequired =
    -not (Test-Path $indexPath) -or
    -not (Test-Path $jobHostPath) -or
    -not (Test-Path $jobHostStampPath)
  if (-not $buildRequired) {
    $dashboardBuiltAt = (Get-Item $indexPath).LastWriteTimeUtc
    $dashboardInputs = @(
      Get-ChildItem (Join-Path $RootDir "src"), (Join-Path $RootDir "public") -Recurse -File
      Get-Item (Join-Path $RootDir "index.html"), (Join-Path $RootDir "package-lock.json"), (Join-Path $RootDir "vite.config.ts")
    )
    $jobHostBuiltAt = (Get-Item $jobHostStampPath).LastWriteTimeUtc
    $jobHostInputs = @(
      Get-Item (Join-Path $RootDir "scripts/AgyJobHost.cs"), (Join-Path $RootDir "scripts/build-agy-job-host.ps1")
    )
    $dashboardStale = $null -ne ($dashboardInputs |
      Where-Object { $_.LastWriteTimeUtc -gt $dashboardBuiltAt } |
      Select-Object -First 1)
    $jobHostStale = $null -ne ($jobHostInputs |
      Where-Object { $_.LastWriteTimeUtc -gt $jobHostBuiltAt } |
      Select-Object -First 1)
    $buildRequired = $dashboardStale -or $jobHostStale
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

  if ($process.ExitCode -ne 0 -or
      -not (Test-Path $indexPath) -or
      -not (Test-Path $jobHostPath) -or
      -not (Test-Path $jobHostStampPath)) {
    throw "Could not build the dashboard. See data/logs/desktop-build.err."
  }
}

function Start-LaunchRefresh {
  # The child script is fixed source: install paths and URLs are structured
  # JSON data on stdin, never interpolated into executable code.
  $refreshScript = @'
$ErrorActionPreference = "Stop"
$payloadJson = [System.Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String([Console]::In.ReadToEnd())
)
$payload = $payloadJson | ConvertFrom-Json
$refreshUrl = [string]$payload.refreshUrl
$successLog = [string]$payload.successLog
$errorLog = [string]$payload.errorLog
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  Invoke-RestMethod -Uri ([Uri]$refreshUrl) -Method Post | Out-Null
  [System.IO.File]::WriteAllText(
    $successLog,
    "Refresh completed at $((Get-Date).ToString("s"))",
    $utf8
  )
} catch {
  [System.IO.File]::WriteAllText($errorLog, $_.Exception.Message, $utf8)
}
'@

  $encodedScript = [Convert]::ToBase64String(
    [System.Text.Encoding]::Unicode.GetBytes($refreshScript)
  )
  $payloadJson = @{
    refreshUrl = $RefreshUrl
    successLog = (Join-Path $LogDir "desktop-refresh.log")
    errorLog = (Join-Path $LogDir "desktop-refresh.err")
  } | ConvertTo-Json -Compress
  $encodedPayload = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes($payloadJson)
  )
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = Join-Path `
    $env:SystemRoot `
    "System32\WindowsPowerShell\v1.0\powershell.exe"
  $startInfo.Arguments =
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedScript"
  $startInfo.WorkingDirectory = $RootDir
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  $refreshProcess = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $refreshProcess) {
    throw "Could not start the background usage refresh."
  }
  $refreshProcess.StandardInput.Write($encodedPayload)
  $refreshProcess.StandardInput.Close()
  $refreshProcess.Dispose()
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
      $restartProcess = Get-VerifiedViewerListenerProcess `
        -ExpectedProcessId ([int]$identity.pid) `
        -ExpectedStartedAtUtc ([string]$identity.processStartedAtUtc)
      if (-not $restartProcess) {
        throw "AI Usage Viewer needs a restart, but its listener and repository command could not be verified. It was left untouched."
      }
      Stop-VerifiedServerProcess -Process $restartProcess
    }
  } elseif (Test-LegacyUsageApi) {
    # Servers from before the identity endpoint can still be migrated, but only
    # when the actual listener runs this exact repo. A state-file PID is never
    # authority to terminate a process.
    $legacyProcess = Get-VerifiedLegacyListenerProcess
    if (-not $legacyProcess) {
      throw "A legacy API is using port 4317, but its listener could not be verified as this repository's server. It was left untouched."
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
