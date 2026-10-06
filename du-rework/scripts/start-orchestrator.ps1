# ==============================================================================
# start-orchestrator.ps1 — Start Orchestrator Service (Port 3000)
# ==============================================================================

$Host.UI.RawUI.WindowTitle = "DUGate Orchestrator [Port 3000]"

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

$DistEntry = "$WorkspaceRoot\services\orchestrator\dist\main.js"
if (-not (Test-Path $DistEntry)) {
    Write-Host "Compiled binary not found. Running build-all.cjs..." -ForegroundColor Yellow
    node "$ScriptDir\build-all.cjs"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Starting DUGate Orchestrator Service (Port 3000)" -ForegroundColor Cyan
Write-Host "   Admin UI : http://localhost:3001/admin/web/" -ForegroundColor Green
Write-Host "   Health   : http://localhost:3000/health" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

node --env-file=$EnvFile "$DistEntry"

exit $LASTEXITCODE
