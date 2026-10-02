# ==============================================================================
# start-worker.ps1 — Start Document-Core Worker Service
# ==============================================================================

$Host.UI.RawUI.WindowTitle = "DUGate Document-Core Worker"

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

$DistEntry = "$WorkspaceRoot\businesses\document-core\dist\main.js"
if (-not (Test-Path $DistEntry)) {
    Write-Host "Compiled binary not found. Running build-all.cjs..." -ForegroundColor Yellow
    node "$ScriptDir\build-all.cjs"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Starting DUGate Document-Core Worker" -ForegroundColor Cyan
Write-Host "   Actions: Ingest, Extract, Analyze, Transform, Generate, Compare" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

node --env-file=$EnvFile "$DistEntry"
