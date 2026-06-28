param(
  [switch] $ServerOnly,
  [switch] $SkipLaunchRefresh
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ApiUrl = "http://127.0.0.1:4317/api/snapshot"
$RefreshUrl = "http://127.0.0.1:4317/api/refresh"
$AppUrl = "http://127.0.0.1:5174/"
$LogDir = Join-Path $RootDir "data/logs"
$ApiStarted = $false

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

  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList $Arguments `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "$LogName.log") `
    -RedirectStandardError (Join-Path $LogDir "$LogName.err") | Out-Null
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

if (-not (Test-HttpOk -Url $ApiUrl -MustContain '"snapshot"')) {
  Start-HiddenNpm -Arguments @("run", "api") -LogName "desktop-api"
  $ApiStarted = Wait-HttpOk -Url $ApiUrl -TimeoutSeconds 15 -MustContain '"snapshot"'
}

if (-not (Test-HttpOk -Url $AppUrl -MustContain 'id="root"')) {
  Start-HiddenNpm `
    -Arguments @("run", "dev", "--", "--host", "127.0.0.1", "--port", "5174") `
    -LogName "desktop-vite"
  Wait-HttpOk -Url $AppUrl -TimeoutSeconds 25 -MustContain 'id="root"' | Out-Null
}

if ($ApiStarted -and -not $SkipLaunchRefresh) {
  Start-LaunchRefresh
  Start-Sleep -Milliseconds 700
}

if (-not $ServerOnly) {
  Open-AppWindow $AppUrl
}
