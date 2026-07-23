param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $PayloadBase64
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
  $json = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($PayloadBase64)
  )
  $payload = $json | ConvertFrom-Json
  $command = [string] $payload.command
  $arguments = @($payload.args | ForEach-Object { [string] $_ })
  if (-not $command) {
    throw "Command path is missing."
  }

  & $command @arguments
  if ($null -ne $LASTEXITCODE) {
    exit ([int] $LASTEXITCODE)
  }
} catch {
  [Console]::Error.WriteLine("Windows command wrapper failed.")
  exit 1
}
