$reportPath = "D:\Git\dugate\du-rework\coordination\reports\antigravity-6.md"
$passLines = Get-Content $reportPath | Where-Object { $_ -match "^\[PASS\]" }

$totalPassed = 0
$totalTests = 0
$mismatches = @()

foreach ($line in $passLines) {
    if ($line -match "Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total") {
        $p = [int]$matches[1]
        $t = [int]$matches[2]
        $totalPassed += $p
        $totalTests += $t
        if ($p -ne $t) {
            $mismatches += $line
        }
    } else {
        $mismatches += "UNMATCHED FORMAT: $line"
    }
}

Write-Host "Total Suites Analyzed: $($passLines.Count)"
Write-Host "Total Tests Passed   : $totalPassed"
Write-Host "Total Tests Expected : $totalTests"
Write-Host "Mismatches Count     : $($mismatches.Count)"
if ($mismatches.Count -gt 0) {
    Write-Host "Mismatches:"
    $mismatches | ForEach-Object { Write-Host "  $_" }
}
