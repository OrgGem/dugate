# verify-baseline-counts.ps1
# Deterministic verification of test counts in du-rework/docs/35-acceptance-baseline.md
# Strips thousand separators (-replace ',','') before casting to [int]

$baselinePath = Join-Path $PSScriptRoot "..\..\docs\35-acceptance-baseline.md"
if (-not (Test-Path $baselinePath)) {
    Write-Error "File not found: $baselinePath"
    exit 1
}

$content = Get-Content $baselinePath

$offRows = 0; $offPassed = 0; $offTotal = 0
$liveRows = 0; $livePassRows = 0; $livePassPassed = 0; $livePassTotal = 0
$greenRows = 0; $greenPassed = 0; $greenTotal = 0
$failRows = 0; $failPassed = 0; $failFailed = 0; $failTotal = 0

$currentSection = "None"

foreach ($line in $content) {
    if ($line -match '^### 3\.1\. 82 Suites OFFLINE') {
        $currentSection = "Offline"
        continue
    } elseif ($line -match '^### 3\.2\. 22 Suites LIVE_INFRA') {
        $currentSection = "Live"
        continue
    } elseif ($line -match '^### 3\.3\.' -or $line -match '^## 4\.') {
        $currentSection = "Other"
        continue
    }

    if ($currentSection -eq "Offline" -and ($line -match '^\s*\|\s*\d+\s*\|.*`Tests:\s*([^`]+)`')) {
        $s = $matches[1]
        $p = 0; $t = 0
        if ($s -match '(\d[\d,]*)\s+passed') { $p = [int]($matches[1] -replace ',','') }
        if ($s -match '(\d[\d,]*)\s+total')  { $t = [int]($matches[1] -replace ',','') }
        $offRows++
        $offPassed += $p
        $offTotal  += $t
    } elseif ($currentSection -eq "Live" -and ($line -match '^\s*\|\s*\d+\s*\|.*`Tests:\s*([^`]+)`')) {
        $s = $matches[1]
        $p = 0; $f = 0; $t = 0
        if ($s -match '(\d[\d,]*)\s+passed') { $p = [int]($matches[1] -replace ',','') }
        if ($s -match '(\d[\d,]*)\s+failed') { $f = [int]($matches[1] -replace ',','') }
        if ($s -match '(\d[\d,]*)\s+total')  { $t = [int]($matches[1] -replace ',','') }
        
        $liveRows++
        if ($line -match '\*\*\[PASS\]\*\*') {
            $livePassRows++
            $livePassPassed += $p
            $livePassTotal  += $t
        } elseif ($line -match '\*\*\[GREEN-EXIT1\]\*\*') {
            $greenRows++
            $greenPassed += $p
            $greenTotal  += $t
        } elseif ($line -match '\*\*\[FAIL\]\*\*') {
            $failRows++
            $failPassed += $p
            $failFailed += $f
            $failTotal  += $t
        }
    }
}

$totalPassed = $offPassed + $livePassPassed + $greenPassed + $failPassed
$totalFailed = $failFailed
$grandTotal  = $totalPassed + $totalFailed

Write-Host "====================================================="
Write-Host "EXACT FLEET ACCEPTANCE BASELINE ARITHMETIC PROOF"
Write-Host "Source: docs/35-acceptance-baseline.md"
Write-Host "====================================================="
Write-Host ("Total Suite Rows Parsed:    " + ($offRows + $liveRows))
Write-Host ("1. OFFLINE (Table 3.1):     " + $offRows + " suites | Passed: " + $offPassed + " | Total: " + $offTotal)
Write-Host ("2. LIVE_INFRA (Table 3.2): " + $liveRows + " suites")
Write-Host ("   - [PASS] (Exit 0):       " + $livePassRows + " suites | Passed: " + $livePassPassed + " | Total: " + $livePassTotal)
Write-Host ("   - [GREEN-EXIT1] (Exit 1): " + $greenRows + " suites | Passed: " + $greenPassed + " | Total: " + $greenTotal)
Write-Host ("   - [FAIL] (Functional):    " + $failRows + " suites | Passed: " + $failPassed + " | Failed: " + $failFailed + " | Total: " + $failTotal)
Write-Host "-----------------------------------------------------"
Write-Host ("FLEET SUM OF PASSED TESTS: " + $totalPassed)
Write-Host ("FLEET SUM OF FAILED TESTS: " + $totalFailed)
Write-Host ("FLEET GRAND TOTAL TESTS:   " + $grandTotal)
Write-Host ("CHECK Passed + Failed == Total: " + ($grandTotal -eq ($offTotal + $livePassTotal + $greenTotal + $failTotal)))
Write-Host "====================================================="

exit 0
