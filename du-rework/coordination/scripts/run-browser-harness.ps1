$ErrorActionPreference = 'Stop'
$repo = "D:\Git\dugate\du-rework"
$evidenceDir = "$repo\coordination\evidence\aweb-run"
$harnessJson = "$repo\coordination\evidence\harness.json"

if (!(Test-Path $evidenceDir)) { New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null }
if (Test-Path $harnessJson) { Remove-Item $harnessJson -Force }

Write-Host ">>> 1. Building admin-web bundle..." -ForegroundColor Cyan
pnpm --filter @du/admin-web build

Write-Host ">>> 2. Booting harness server..." -ForegroundColor Cyan
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "cmd.exe"
$pinfo.Arguments = "/c pnpm dlx tsx tests/browser/admin-web/harness.ts `"$harnessJson`""
$pinfo.WorkingDirectory = $repo
$pinfo.EnvironmentVariables["NODE_ENV"] = "test"
$pinfo.UseShellExecute = $false
$harnessProc = [System.Diagnostics.Process]::Start($pinfo)

try {
    $timeout = 25; $waited = 0
    while (!(Test-Path $harnessJson) -and $waited -lt $timeout) {
        Start-Sleep -Milliseconds 500
        $waited += 0.5
    }
    if (!(Test-Path $harnessJson)) { throw "Harness boot timed out!" }

    $h = Get-Content $harnessJson | ConvertFrom-Json
    Write-Host ">>> Harness Ready at $($h.url) (Stub: $($h.stubUrl))" -ForegroundColor Green

    $env:AWEB01B_URL      = $h.url
    $env:AWEB01B_TOKEN    = $h.token
    $env:AWEB01B_EVIDENCE = $evidenceDir
    $env:AWEB03B_STUB     = $h.stubUrl
    $env:AWEB03B_OPERATOR = $h.sessions.operator
    $env:AWEB03B_VIEWER   = $h.sessions.viewer
    $env:AWEB03B_TENANT   = $h.tenant

    Write-Host ">>> 3. Running Playwright browser test suite..." -ForegroundColor Cyan
    $testProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx playwright test --config admin-web/playwright.config.ts" -WorkingDirectory "$repo\tests\browser" -NoNewWindow -PassThru -Wait
    Write-Host ">>> Playwright Exit Code: $($testProc.ExitCode)" -ForegroundColor $(if ($testProc.ExitCode -eq 0) { "Green" } else { "Red" })
    exit $testProc.ExitCode
}
finally {
    Write-Host ">>> 4. Shutting down harness..." -ForegroundColor Cyan
    if ($harnessProc -and !$harnessProc.HasExited) {
        try {
            cmd.exe /c "taskkill /F /T /PID $($harnessProc.Id)" | Out-Null
        } catch {
            $harnessProc.Kill()
        }
        $harnessProc.WaitForExit(5000)
    }
}
