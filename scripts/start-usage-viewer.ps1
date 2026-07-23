param(
  [switch] $ServerOnly,
  [switch] $SkipLaunchRefresh,
  [string] $VerifyServerCommandLine
)

$ErrorActionPreference = "Stop"

$System32Dir = [IO.Path]::GetFullPath(
  (Join-Path $env:SystemRoot "System32")
)
$PowerShellPath = Join-Path $System32Dir "WindowsPowerShell\v1.0\powershell.exe"
$ComSpecPath = Join-Path $System32Dir "cmd.exe"
$NodePath = [IO.Path]::GetFullPath(
  (Join-Path $env:ProgramFiles "nodejs\node.exe")
)
if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $ComSpecPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "AI Usage Viewer requires the trusted Windows PowerShell, cmd.exe, and Program Files Node.js installation."
}

# Block inherited variables that can inject JavaScript or replace the command
# shell in otherwise absolute child launches. Provider credentials, proxy
# settings, profiles, and PATH remain available to the collectors.
foreach ($UnsafeEnvironmentName in @(
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NPM_CONFIG_NODE_OPTIONS",
  "NPM_CONFIG_SCRIPT_SHELL"
)) {
  [Environment]::SetEnvironmentVariable(
    $UnsafeEnvironmentName,
    $null,
    "Process"
  )
}
[Environment]::SetEnvironmentVariable("ComSpec", $ComSpecPath, "Process")
[Environment]::SetEnvironmentVariable(
  "PATHEXT",
  ".COM;.EXE;.BAT;.CMD",
  "Process"
)

# Some desktop hosts pass both `Path` and `PATH` in the process environment.
# Windows treats those names as equivalent, but Windows PowerShell's
# Start-Process rejects the duplicate environment block. Preserve the effective
# search path and publish one canonical entry before starting hidden children.
$EffectivePath = [Environment]::GetEnvironmentVariable("PATH", "Process")
if (-not [string]::IsNullOrWhiteSpace($EffectivePath)) {
  [Environment]::SetEnvironmentVariable("Path", $null, "Process")
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  [Environment]::SetEnvironmentVariable("Path", $EffectivePath, "Process")
}

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

function Start-HiddenProcess {
  param(
    [string] $FilePath,
    [string[]] $Arguments,
    [string] $LogName,
    [switch] $Wait
  )

  $StartParameters = @{
    FilePath = $FilePath
    ArgumentList = $Arguments
    WorkingDirectory = $RootDir
    WindowStyle = "Hidden"
    PassThru = $true
    RedirectStandardOutput = (Join-Path $LogDir "$LogName.log")
    RedirectStandardError = (Join-Path $LogDir "$LogName.err")
  }
  if ($Wait) {
    $StartParameters.Wait = $true
  }
  return Start-Process @StartParameters
}

function ConvertTo-WindowsProcessArgument {
  param([string] $Value)

  if ($Value.Contains('"') -or $Value.Contains("`0")) {
    throw "A child-process argument contains an unsupported character."
  }
  if ($Value -match '\s') {
    return "`"$Value`""
  }
  return $Value
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
  # The managed server has one canonical argv. Accepting "any trusted loader
  # somewhere before server.ts" lets an extra preload execute arbitrary code
  # while still passing identity verification.
  if ($arguments.Count -ne 6) {
    return $false
  }

  if ([string]$arguments[1] -cne "--require" -or
      [string]$arguments[3] -cne "--import") {
    return $false
  }

  $preflightPath = [System.IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\tsx\dist\preflight.cjs")
  ).TrimEnd("\")
  $loaderPath = [System.IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\tsx\dist\loader.mjs")
  ).TrimEnd("\")
  $serverEntry = [System.IO.Path]::GetFullPath(
    (Join-Path $RootDir "src\server.ts")
  ).TrimEnd("\")
  $actualPreflight = Resolve-ViewerCommandFileArgument `
    -Argument ([string]$arguments[2])
  $actualLoader = Resolve-ViewerCommandFileArgument `
    -Argument ([string]$arguments[4])
  $actualEntry = Resolve-ViewerCommandFileArgument `
    -Argument ([string]$arguments[5])

  return $actualPreflight -and
    $actualLoader -and
    $actualEntry -and
    $actualPreflight.Equals(
      $preflightPath,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    $actualLoader.Equals(
      $loaderPath,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    $actualEntry.Equals(
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
    if (-not $record) {
      return $null
    }
    $listenerExecutable = [System.IO.Path]::GetFullPath(
      [string]$record.ExecutablePath
    ).TrimEnd("\")
    if (-not $listenerExecutable.Equals(
          $NodePath.TrimEnd("\"),
          [System.StringComparison]::OrdinalIgnoreCase
        )) {
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
  $taskkillExitCode = $LASTEXITCODE

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Test-ViewerPortOpen)) {
    Start-Sleep -Milliseconds 250
  }
  $rootStillRunning = $false
  try {
    $remaining = Get-Process -Id $expectedPid -ErrorAction Stop
    $rootStillRunning =
      [Math]::Abs(
        ($remaining.StartTime.ToUniversalTime() -
          [DateTime]::Parse($expectedStart).ToUniversalTime()).TotalSeconds
      ) -le 5
  } catch {
    $rootStillRunning = $false
  }
  if ((Test-ViewerPortOpen) -or $rootStillRunning) {
    throw "The verified AI Usage Viewer server did not stop (taskkill exit $taskkillExitCode)."
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
    nodeExecutable = $NodePath
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

  $preflightPath = [IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\tsx\dist\preflight.cjs")
  )
  $loaderPath = [IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\tsx\dist\loader.mjs")
  )
  $serverPath = [IO.Path]::GetFullPath(
    (Join-Path $RootDir "src\server.ts")
  )
  foreach ($requiredPath in @($preflightPath, $loaderPath, $serverPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "AI Usage Viewer runtime files are missing. Run npm ci and try again."
    }
  }
  $loaderUri = [Uri]::new($loaderPath).AbsoluteUri
  $nodeArguments = @(
    "--require"
    "`"$preflightPath`""
    "--import"
    $loaderUri
    "`"$serverPath`""
  )

  $hadFingerprint = Test-Path Env:\USAGE_VIEWER_SOURCE_FINGERPRINT
  $previousFingerprint = $env:USAGE_VIEWER_SOURCE_FINGERPRINT
  try {
    $env:USAGE_VIEWER_SOURCE_FINGERPRINT = $BackendFingerprint
    return Start-HiddenProcess `
      -FilePath $NodePath `
      -Arguments $nodeArguments `
      -LogName "desktop-server"
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
  $verifiedListener = $null
  if ($identity) {
    $verifiedListener = Get-VerifiedViewerListenerProcess `
      -ExpectedProcessId ([int]$identity.pid) `
      -ExpectedStartedAtUtc ([string]$identity.processStartedAtUtc)
  }
  if (-not $identity -or
      [string]$identity.sourceFingerprint -ne $BackendFingerprint -or
      -not $verifiedListener -or
      -not (Test-HttpOk -Url $AppUrl -MustContain 'id="root"')) {
    return $null
  }
  return $identity
}

function Stop-FailedSpawnedServer {
  param([object] $LauncherProcess)

  $cleanupFailures = @()
  if ($LauncherProcess) {
    try {
      $LauncherProcess.Refresh()
      if (-not $LauncherProcess.HasExited) {
        # This is the exact process handle returned by Start-Process in this
        # launcher invocation, so its tree is safe to revoke on startup error.
        $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
        & $taskkillPath /pid ([int]$LauncherProcess.Id) /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) {
          $cleanupFailures += "the newly spawned Node process tree did not stop"
        }
      }
    } catch {
      $cleanupFailures += "the newly spawned npm process tree could not be inspected"
    }
  }

  # npm can exit after spawning Node. If a listener survived, terminate it only
  # after the same repository-command and listener-ownership proof used during
  # normal upgrades.
  $listener = Get-VerifiedViewerListenerProcess
  if ($listener) {
    try {
      Stop-VerifiedServerProcess -Process $listener
    } catch {
      $cleanupFailures += "the verified listener did not stop"
    }
  }
  Remove-Item -LiteralPath $ServerStatePath -Force -ErrorAction SilentlyContinue

  if ($cleanupFailures.Count -gt 0) {
    throw "Startup cleanup failed: $($cleanupFailures -join '; ')."
  }
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

  $buildScript = [IO.Path]::GetFullPath(
    (Join-Path $RootDir "scripts\build-agy-job-host.ps1")
  )
  $tscScript = [IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\typescript\bin\tsc")
  )
  $viteScript = [IO.Path]::GetFullPath(
    (Join-Path $RootDir "node_modules\vite\bin\vite.js")
  )
  foreach ($requiredPath in @($buildScript, $tscScript, $viteScript)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "AI Usage Viewer build dependencies are missing. Run npm ci and try again."
    }
  }

  $buildSteps = @(
    @{
      FilePath = $PowerShellPath
      Arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "`"$buildScript`""
      )
      LogName = "desktop-build-job-host"
    },
    @{
      FilePath = $NodePath
      Arguments = @("`"$tscScript`"", "-b")
      LogName = "desktop-build-typescript"
    },
    @{
      FilePath = $NodePath
      Arguments = @("`"$viteScript`"", "build")
      LogName = "desktop-build-vite"
    }
  )
  foreach ($step in $buildSteps) {
    $process = Start-HiddenProcess `
      -FilePath $step.FilePath `
      -Arguments $step.Arguments `
      -LogName $step.LogName `
      -Wait
    if ($process.ExitCode -ne 0) {
      throw "Could not build AI Usage Viewer. See data/logs/$($step.LogName).err."
    }
  }

  if (
      -not (Test-Path $indexPath) -or
      -not (Test-Path $jobHostPath) -or
      -not (Test-Path $jobHostStampPath)) {
    throw "AI Usage Viewer build completed without all required outputs."
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
$snapshotUrl = ([Uri]$refreshUrl).GetLeftPart([System.UriPartial]::Authority) + "/api/snapshot"
$successLog = [string]$payload.successLog
$errorLog = [string]$payload.errorLog
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  try {
    Invoke-RestMethod `
      -Uri ([Uri]$refreshUrl) `
      -Method Post `
      -TimeoutSec 10 | Out-Null
  } catch {
    $status = if ($null -ne $_.Exception.Response) {
      [int]$_.Exception.Response.StatusCode
    } else {
      0
    }
    if ($status -ne 409) {
      throw
    }
  }

  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $state = Invoke-RestMethod -Uri ([Uri]$snapshotUrl) -TimeoutSec 10
    if (-not [bool]$state.refreshing) {
      if ($state.error) {
        throw ([string]$state.error)
      }
      [System.IO.File]::WriteAllText(
        $successLog,
        "Refresh completed at $((Get-Date).ToString("s"))",
        $utf8
      )
      exit 0
    }
  }
  throw "Refresh verification timed out after 5 minutes."
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
  $jobHostPath = [IO.Path]::GetFullPath(
    (Join-Path $RootDir ".runtime\agy-job-host.exe")
  )
  if (-not $ServerProcess -or
      [int]$ServerProcess.Id -le 0 -or
      -not (Test-Path -LiteralPath $jobHostPath -PathType Leaf)) {
    throw "Could not establish the background refresh lifetime boundary."
  }
  $startInfo.FileName = $jobHostPath
  $refreshArguments = @(
    "--pipe",
    [string]$ServerProcess.Id,
    $PowerShellPath,
    $RootDir,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    $encodedScript
  ) | ForEach-Object { ConvertTo-WindowsProcessArgument $_ }
  $startInfo.Arguments = $refreshArguments -join " "
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
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft/Edge/Application/msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft/Edge/Application/msedge.exe"),
    (Join-Path $env:ProgramFiles "Google/Chrome/Application/chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google/Chrome/Application/chrome.exe")
  )

  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
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

if ($PSBoundParameters.ContainsKey("VerifyServerCommandLine")) {
  if (Test-ViewerServerCommand -CommandLine $VerifyServerCommandLine) {
    exit 0
  }
  exit 1
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
    $identityProcess = Get-VerifiedViewerListenerProcess `
      -ExpectedProcessId ([int]$identity.pid) `
      -ExpectedStartedAtUtc ([string]$identity.processStartedAtUtc)
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
    try {
      $stableIdentity = Wait-ForSpawnedServer `
        -LauncherProcess $ServerProcess `
        -BackendFingerprint $BackendFingerprint
    } catch {
      $startupError = $_
      try {
        Stop-FailedSpawnedServer -LauncherProcess $ServerProcess
      } catch {
        throw "AI Usage Viewer startup failed and its cleanup could not be confirmed. $($_.Exception.Message)"
      }
      throw $startupError
    }
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
