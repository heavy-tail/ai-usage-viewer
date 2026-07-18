param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SourcePath = Join-Path $PSScriptRoot "AgyJobHost.cs"
$RuntimeDirectory = [IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot "..\.runtime")
)
$OutputPath = Join-Path $RuntimeDirectory "agy-job-host.exe"
$StampPath = Join-Path $RuntimeDirectory "agy-job-host.source.sha256"
$TemporaryDirectory = Join-Path `
  $RuntimeDirectory `
  ".agy-job-host.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
# Keep the compiler output's leaf name stable so its assembly identity remains
# `agy-job-host` regardless of the temporary directory used for an atomic build.
$TemporaryOutput = Join-Path $TemporaryDirectory "agy-job-host.exe"
$TemporaryStamp = Join-Path $TemporaryDirectory "agy-job-host.source.sha256"

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
  throw "AGY job-host source is missing."
}

$FrameworkRoot = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319")
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319")
) | Where-Object {
  (Test-Path -LiteralPath (Join-Path $_ "csc.exe") -PathType Leaf) -and
  (Test-Path -LiteralPath (Join-Path $_ "System.dll") -PathType Leaf)
} | Select-Object -First 1
if (-not $FrameworkRoot) {
  throw "The built-in .NET Framework C# compiler is unavailable."
}
$CompilerPath = Join-Path $FrameworkRoot "csc.exe"
$SystemAssembly = Join-Path $FrameworkRoot "System.dll"

$SourceFileHash = (
  Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256
).Hash.ToLowerInvariant()
$BuildScriptHash = (
  Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256
).Hash.ToLowerInvariant()
$HashBytes = [Text.Encoding]::UTF8.GetBytes(
  "$SourceFileHash`n$BuildScriptHash`nframework64-csc-v1`n"
)
$Hasher = [Security.Cryptography.SHA256]::Create()
try {
  $SourceHash = ([BitConverter]::ToString(
    $Hasher.ComputeHash($HashBytes)
  )).Replace("-", "").ToLowerInvariant()
} finally {
  $Hasher.Dispose()
}

if ((Test-Path -LiteralPath $OutputPath -PathType Leaf) -and
    (Test-Path -LiteralPath $StampPath -PathType Leaf)) {
  $ExistingStamp = (Get-Content -LiteralPath $StampPath -Raw).Trim()
  if ($ExistingStamp -ceq $SourceHash) {
    Write-Output "AGY job host is up to date ($SourceHash)"
    return
  }
}

New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null

$CompilerArguments = @(
  "/nologo"
  "/noconfig"
  "/target:exe"
  "/platform:anycpu"
  "/optimize+"
  "/debug-"
  "/warnaserror+"
  "/reference:$SystemAssembly"
  "/out:$TemporaryOutput"
  $SourcePath
)

try {
  & $CompilerPath @CompilerArguments
  if ($LASTEXITCODE -ne 0 -or
      -not (Test-Path -LiteralPath $TemporaryOutput -PathType Leaf)) {
    throw "The AGY job host compiler failed with exit code $LASTEXITCODE."
  }

  $Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText(
    $TemporaryStamp,
    "$SourceHash`n",
    $Utf8WithoutBom
  )

  # Publish only complete compiler output. A failed build never replaces the
  # last usable helper or its matching source-hash stamp.
  Move-Item -LiteralPath $TemporaryOutput -Destination $OutputPath -Force
  Move-Item -LiteralPath $TemporaryStamp -Destination $StampPath -Force
} finally {
  Remove-Item `
    -LiteralPath $TemporaryDirectory `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue
}

$OutputItem = Get-Item -LiteralPath $OutputPath
if ($OutputItem.Length -le 0) {
  throw "The AGY job host compiler produced an empty executable."
}

Write-Output "Built .runtime/agy-job-host.exe ($SourceHash)"
