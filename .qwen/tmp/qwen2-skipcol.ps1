# W43-Q17: insert 'Skipped' column into docs/35 tables (3.1/3.2/3.4)
$f = 'D:\Git\dugate\du-rework\docs\35-acceptance-baseline.md'
$lines = Get-Content $f -Encoding UTF8
$out = New-Object System.Collections.Generic.List[string]
$hdr = 0; $row = 0
foreach ($line in $lines) {
  if ($line -match '^\|\s*#\s*\|\s*Suite Path\s*\|\s*Status\s*\|\s*Literal Test Summary\s*\|') {
    $out.Add(($line -replace '(Literal Test Summary\s*\|)', '$1 Skipped |'))
    $hdr++
  }
  elseif ($line -match '^(\|\s*\d+\s*\|[^|]*\|[^|]*\|)(`Tests:[^`]*`)(\s*\|.*)$') {
    $lit = $matches[2]
    $passed = 0; $failed = 0; $skipped = -1; $total = 0
    if ($lit -match '(\d+)\s+passed') { $passed = [int]$Matches[1] }
    if ($lit -match '(\d+)\s+failed') { $failed = [int]$Matches[1] }
    if ($lit -match '(\d+)\s+skipped') { $skipped = [int]$Matches[1] }
    if ($lit -match '(\d+)\s+total')  { $total  = [int]$Matches[1] }
    if ($skipped -lt 0) { $skipped = $total - $passed - $failed }
    if ($skipped -lt 0) { $skipped = 0 }
    $out.Add($Matches[1] + $lit + ' | ' + $skipped + $Matches[3])
    $row++
  }
  else { $out.Add($line) }
}
[System.IO.File]::WriteAllLines($f, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('headers updated: ' + $hdr + ' | data rows updated: ' + $row)
