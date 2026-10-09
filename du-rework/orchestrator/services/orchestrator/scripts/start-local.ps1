[CmdletBinding()]
param(
  [string]$EnvFile = $env:DU_ENV_FILE,
  [switch]$SkipBuild,
  [switch]$SkipMigrate
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

# Match the host-process ports from Compose while keeping listeners local-only.
$env:PORT = '3000'
$env:ORCHESTRATOR_PORT = '3000'
$env:ORCHESTRATOR_HOST = '127.0.0.1'
$env:ORCHESTRATOR_INTERNAL_PORT = '3002'
$env:ORCHESTRATOR_INTERNAL_HOST = '127.0.0.1'
$env:ORCHESTRATOR_INTERNAL_BASE_URL = 'http://127.0.0.1:3002'
$env:ADMIN_SHELL_PORT = '3001'
$env:ADMIN_SHELL_HOST = '127.0.0.1'
$env:CONNECTOR_PORT = '8080'
$env:CONNECTOR_URL = 'http://127.0.0.1:8080'
$env:RUNTIME_URL = 'http://127.0.0.1:3002/api/runtime/v1'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
$env:DU_ADMIN_WEB = '1'
# The process starts with the package as its working directory.
$env:DU_ADMIN_WEB_DIST = '../../apps/admin-web/dist'
$env:AUTO_MIGRATE = 'false'

$DoBuild = -not ($SkipBuild -or $env:DU_SKIP_BUILD -eq '1')
$DoMigrate = -not ($SkipMigrate -or $env:DU_SKIP_MIGRATE -eq '1')
if ($DoBuild) {
  Push-Location $WorkspaceRoot
  try {
    & pnpm --filter '@du/orchestrator...' run build
    if ($LASTEXITCODE -ne 0) { throw "Orchestrator build failed with exit code $LASTEXITCODE." }
    & pnpm --filter '@du/admin-web...' run build
    if ($LASTEXITCODE -ne 0) { throw "Admin Web build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

if ($DoMigrate) {
  Push-Location $ProjectDir
  try {
    & node "--env-file=$EnvFile" (Join-Path $ProjectDir 'dist/migrate-cli.js') 'migrate'
    if ($LASTEXITCODE -ne 0) { throw "Orchestrator migration failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

Write-Host 'Orchestrator Public:   http://127.0.0.1:3000'
Write-Host 'Orchestrator Admin:    http://127.0.0.1:3001/admin/'
Write-Host 'Orchestrator Internal: http://127.0.0.1:3002'
Write-Host 'Connector:             http://127.0.0.1:8080'
Write-Host 'Redis:                 redis://127.0.0.1:6379'
Push-Location $ProjectDir
try {
  & node "--env-file=$EnvFile" (Join-Path $ProjectDir 'dist/main.js')
  $ServiceExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $ServiceExitCode
