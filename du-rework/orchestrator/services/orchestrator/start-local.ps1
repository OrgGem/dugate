[CmdletBinding()]
param(
  [string]$EnvFile = '.env.orchestrator.local',
  [ValidateRange(1, 65535)]
  [int]$ConnectorPort = $(if ($env:CONNECTOR_PORT) { [int]$env:CONNECTOR_PORT } else { 8080 }),
  [string]$ConnectorUrl = $env:CONNECTOR_URL
)

$ErrorActionPreference = 'Stop'
$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$ResolvedEnvFile = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $WorkspaceRoot $EnvFile }
if (-not (Test-Path -LiteralPath $ResolvedEnvFile -PathType Leaf)) {
  throw "Local env file not found: $ResolvedEnvFile. Create it with node scripts/init-orchestrator-local.cjs --output=.env.orchestrator.local."
}

$HadConnectorPort = Test-Path Env:CONNECTOR_PORT
$PreviousConnectorPort = $env:CONNECTOR_PORT
$HadConnectorUrl = Test-Path Env:CONNECTOR_URL
$PreviousConnectorUrl = $env:CONNECTOR_URL
$ExitCode = 1
Push-Location $WorkspaceRoot
try {
  $env:CONNECTOR_PORT = [string]$ConnectorPort
  if ([string]::IsNullOrWhiteSpace($ConnectorUrl)) {
    $env:CONNECTOR_URL = "http://127.0.0.1:$ConnectorPort"
  } else {
    $env:CONNECTOR_URL = $ConnectorUrl
  }
  Get-Command node -ErrorAction Stop | Out-Null
  & node scripts/dev.cjs "--env-file=$ResolvedEnvFile" '--services=orchestrator' '--workers=none' '--skip-build' '--skip-migrate'
  $ExitCode = $LASTEXITCODE
} finally {
  Pop-Location
  if ($HadConnectorPort) { $env:CONNECTOR_PORT = $PreviousConnectorPort } else { Remove-Item Env:CONNECTOR_PORT -ErrorAction SilentlyContinue }
  if ($HadConnectorUrl) { $env:CONNECTOR_URL = $PreviousConnectorUrl } else { Remove-Item Env:CONNECTOR_URL -ErrorAction SilentlyContinue }
}
exit $ExitCode
