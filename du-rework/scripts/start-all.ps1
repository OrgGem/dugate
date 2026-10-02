# ==============================================================================
# start-all.ps1 — Full Local Development Launcher for du-rework
# ==============================================================================

$Host.UI.RawUI.WindowTitle = "DUGate Control Manager"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = Split-Path -Parent $ScriptDir
Set-Location $WorkspaceRoot

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "                DUGate Rework — Local Dev Launcher                     " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Kiểm tra file cấu hình môi trường ──────────────────────────────────────
$EnvFile = ".env.local"
if (-not (Test-Path "$WorkspaceRoot\$EnvFile")) {
    if (Test-Path "$WorkspaceRoot\.env") {
        $EnvFile = ".env"
        Write-Host '[Env] Found existing .env file.' -ForegroundColor Green
    } else {
        Write-Host '[Env] .env.local not found. Creating from .env.local.sample...' -ForegroundColor Yellow
        Copy-Item "$WorkspaceRoot\.env.local.sample" "$WorkspaceRoot\.env.local"
        Write-Host '[Env] Created .env.local with default localhost settings.' -ForegroundColor Green
        Write-Host '      (Please verify your Postgres credentials in du-rework\.env.local)' -ForegroundColor DarkGray
    }
} else {
    Write-Host ('[Env] Using configuration: ' + $EnvFile) -ForegroundColor Green
}

# ── 2. Kiểm tra kết nối TCP Postgres & Redis ──────────────────────────────────
function Test-PortReady($HostName, $Port, $ServiceName) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($HostName, $Port, $null, $null)
        $wait = $iar.AsyncWaitHandle.WaitOne(1500, $false)
        if (-not $wait) {
            $tcp.Close()
            return $false
        }
        $tcp.EndConnect($iar)
        $tcp.Close()
        return $true
    } catch {
        return $false
    }
}

Write-Host "`n[Check] Verifying local services..." -ForegroundColor Cyan
$pgOk = (Test-PortReady "127.0.0.1" 5432 "PostgreSQL") -or (Test-PortReady "127.0.0.1" 5433 "PostgreSQL")
if ($pgOk) {
    Write-Host "  [OK] PostgreSQL detected on localhost" -ForegroundColor Green
} else {
    Write-Host "  [WARN] PostgreSQL not detected on localhost:5432 or 5433!" -ForegroundColor Red
    Write-Host "         Please make sure PostgreSQL server is started." -ForegroundColor Yellow
}

$redisOk = (Test-PortReady "127.0.0.1" 6379 "Redis") -or (Test-PortReady "127.0.0.1" 6380 "Redis")
if ($redisOk) {
    Write-Host "  [OK] Redis detected on localhost" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Redis not detected on localhost:6379 or 6380!" -ForegroundColor Red
    Write-Host "         Please make sure Redis server is started." -ForegroundColor Yellow
}

# ── 3. Kiểm tra Build ─────────────────────────────────────────────────────────
$OrchDist = "$WorkspaceRoot\services\orchestrator\dist\main.js"
$ConnDist = "$WorkspaceRoot\services\connector\dist\entrypoint.js"
$WorkDist = "$WorkspaceRoot\businesses\document-core\dist\main.js"

if (-not (Test-Path $OrchDist) -or -not (Test-Path $ConnDist) -or -not (Test-Path $WorkDist)) {
    Write-Host "`n[Build] Project has not been built yet. Building all services..." -ForegroundColor Yellow
    node "$ScriptDir\build-all.cjs"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[Build] Build failed. Aborting startup." -ForegroundColor Red
        pause
        exit 1
    }
} else {
    Write-Host "`n[Build] Pre-compiled binaries detected. (Run scripts\build-all.cjs anytime to rebuild)" -ForegroundColor DarkGray
}

# ── 4. Chạy Database Migrations ───────────────────────────────────────────────
Write-Host "`n[Database] Applying Orchestrator migrations..." -ForegroundColor Cyan
node "$ScriptDir\migrate-local.cjs"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[Database] Migration failed. Check your database connection." -ForegroundColor Red
    $choice = Read-Host "Do you want to continue anyway? (y/N)"
    if ($choice -ne "y" -and $choice -ne "Y") {
        exit 1
    }
}

# ── 5. Khởi động 3 Services trong 3 cửa sổ Terminal riêng ────────────────────
Write-Host "`n[Launch] Spawning background services..." -ForegroundColor Cyan

# 1. Orchestrator
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$ScriptDir\start-orchestrator.ps1`""
Start-Sleep -Seconds 2

# 2. Connector
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$ScriptDir\start-connector.ps1`""
Start-Sleep -Seconds 1

# 3. Document-Core Worker
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$ScriptDir\start-worker.ps1`""

# ── 6. Hiển thị Dashboard quản lý ─────────────────────────────────────────────
Write-Host "`n======================================================================" -ForegroundColor Green
Write-Host "            All services have been launched successfully!             " -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  1. Orchestrator API  : http://localhost:3000" -ForegroundColor White
Write-Host "     - Health Status   : http://localhost:3000/health" -ForegroundColor Cyan
Write-Host "     - Admin Web UI    : http://localhost:3001" -ForegroundColor Cyan
Write-Host "     - Admin JSON API  : http://localhost:3000/api/v1/admin/businesses" -ForegroundColor Cyan
Write-Host "  2. Connector Service : http://localhost:8088" -ForegroundColor White
Write-Host "     - Ready check     : http://localhost:8088/health/ready" -ForegroundColor Cyan
Write-Host "  3. Document-Core     : Connected via BullMQ to Redis" -ForegroundColor White
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "Tips: Check the individual terminal windows to view real-time logs." -ForegroundColor DarkGray
Write-Host "To stop the system, simply close the terminal windows.`n" -ForegroundColor DarkGray
