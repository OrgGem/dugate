# ==============================================================================
# start-connector.ps1 — Start Connector Service (local default Port 8088)
# ==============================================================================

$Host.UI.RawUI.WindowTitle = "DUGate Connector [Port 8080]"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = Split-Path -Parent $ScriptDir
Set-Location $WorkspaceRoot

$EnvFile = ".env.local"
if (-not (Test-Path "$WorkspaceRoot\$EnvFile")) {
    if (Test-Path "$WorkspaceRoot\.env") {
        $EnvFile = ".env"
    } else {
        Write-Host "Error: No .env.local or .env file found in $WorkspaceRoot" -ForegroundColor Red
        Write-Host "Please copy .env.local.sample to .env.local first." -ForegroundColor Yellow
        pause
        exit 1
    }
}

$DistEntry = "$WorkspaceRoot\services\connector\dist\entrypoint.js"
if (-not (Test-Path $DistEntry)) {
    Write-Host "Compiled binary not found. Running build-all.cjs..." -ForegroundColor Yellow
    node "$ScriptDir\build-all.cjs"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Ensure SQL migration files exist in dist/db/migrations
$SrcMigrations = "$WorkspaceRoot\services\connector\src\db\migrations"
$DistMigrations = "$WorkspaceRoot\services\connector\dist\db\migrations"
if (-not (Test-Path $DistMigrations)) {
    New-Item -ItemType Directory -Path $DistMigrations -Force | Out-Null
    Copy-Item "$SrcMigrations\*.sql" -Destination $DistMigrations -Force
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Starting DUGate Connector Service (local default Port 8088)" -ForegroundColor Cyan
Write-Host "   Ready check : http://localhost:8088/health/ready" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

node --env-file=$EnvFile "$DistEntry"

exit $LASTEXITCODE
