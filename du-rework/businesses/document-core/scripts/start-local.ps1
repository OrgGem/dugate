[CmdletBinding()]
param(
  [string]$EnvFile = $env:DU_ENV_FILE,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkspaceRoot = $ProjectDir
while ($WorkspaceRoot -and -not (Test-Path -LiteralPath (Join-Path $WorkspaceRoot 'pnpm-workspace.yaml'))) {
  $WorkspaceRoot = Split-Path -Parent $WorkspaceRoot
}
if (-not $WorkspaceRoot) { throw 'Could not find the du-rework workspace root.' }
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $EnvFile = Join-Path $WorkspaceRoot '.env.local'
} elseif (-not [IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile = Join-Path $WorkspaceRoot $EnvFile
}
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
  throw "Environment file not found: $EnvFile. Copy .env.local.sample to .env.local and configure it."
}
$EnvFile = (Resolve-Path -LiteralPath $EnvFile).Path

# Workers have no HTTP listener. PORT=0 prevents an inherited service port from being mistaken for one.
$env:PORT = '0'
$env:HOST = '127.0.0.1'
$env:ORCHESTRATOR_PORT = '3000'
$env:ORCHESTRATOR_HOST = '127.0.0.1'
$env:ORCHESTRATOR_INTERNAL_PORT = '3002'
$env:ORCHESTRATOR_INTERNAL_HOST = '127.0.0.1'
$env:ORCHESTRATOR_INTERNAL_BASE_URL = 'http://127.0.0.1:3002'
$env:ADMIN_SHELL_PORT = '3001'
$env:ADMIN_SHELL_HOST = '127.0.0.1'
$env:RUNTIME_URL = 'http://127.0.0.1:3002/api/runtime/v1'
$env:CONNECTOR_PORT = '8080'
$env:CONNECTOR_URL = 'http://127.0.0.1:8080'
$env:REDIS_URL = 'redis://127.0.0.1:6379'

if (-not ($SkipBuild -or $env:DU_SKIP_BUILD -eq '1')) {
  Push-Location $WorkspaceRoot
  try {
    & pnpm --filter '@du/document-core...' run build
    if ($LASTEXITCODE -ne 0) { throw "Document Core build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

Write-Host 'Document Core worker has no HTTP listener (PORT=0).'
Write-Host 'Runtime: http://127.0.0.1:3002/api/runtime/v1'
Write-Host 'Connector: http://127.0.0.1:8080'
Write-Host 'Redis: redis://127.0.0.1:6379'
$Bootstrap = @'
const path = require('node:path');
const helper = require(path.resolve(process.cwd(), '../../scripts/runtime-env.cjs'));
if (!process.env.CONNECTOR_SERVICE_TOKEN) process.env.CONNECTOR_SERVICE_TOKEN = helper.signedConnectorToken(process.env.SERVICE_IDENTITY_SECRET);
Object.assign(process.env, helper.serviceEnvironment(process.env, 'document-core'));
require(path.resolve(process.cwd(), 'dist/main.js'));
'@
Push-Location $ProjectDir
try {
  & node "--env-file=$EnvFile" -e $Bootstrap
  $ServiceExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $ServiceExitCode
