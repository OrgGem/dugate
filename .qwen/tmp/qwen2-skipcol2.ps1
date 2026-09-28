# W43-Q17 pass 2: insert 'Skipped' cell into data rows (idempotent)
$f = 'D:\Git\dugate\du-rework\docs\35-acceptance-baseline.md'
$lines = Get-Content $f -Encoding UTF8
$out = New-Object System.Collections.Generic.List[string]
$hdr = 0; $row = 0; $skipAlready = 0
foreach ($line in $lines) {
  if ($line -match '^\|\s*#\s*\|\s*Suite Path\s*\|\s*Status\s*\|\s*Literal Test Summary\s*\|') {
    if ($line -match '\|\s*Skipped\s*\|') { $out.Add($line) }
    else { $out.Add(($line -replace '(Literal Test Summary\s*\|)', '$1 Skipped |')); $hdr++ }
  }
  elseif ($line -match '^(\|\s*\d+\s*\|[^|]*\|[^|]*\|\s*)(`Tests:[^`]*`)(\s*\|.*)$') {
    $pre = $Matches[1]; $lit = $Matches[2]; $post = $Matches[3]
    if ($post -match '^\s*\|\s*\d+\s*\|') { $row2 = $true; $out.Add($line); $skipAlready++ }
    else {
      $passed = 0; $failed = 0; $skipped = -1; $total = 0
      if ($lit -match '(\d+)\s+passed') { $passed = [int]$Matches[1] }
      if ($lit -match '(\d+)\s+failed') { $failed = [int]$Matches[1] }
      if ($lit -match '(\d+)\s+skipped') { $skipped = [int]$Matches[1] }
      if ($lit -match '(\d+)\s+total')  { $total  = [int]$Matches[1] }
      if ($skipped -lt 0) { $skipped = $total - $passed - $failed }
      if ($skipped -lt 0) { $skipped = 0 }
      $out.Add($pre + $lit + ' | ' + $skipped + $post)
      $row++
    }
  }
  else { $out.Add($line) }
}
[System.IO.File]::WriteAllLines($f, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('headers added: ' + $hdr + ' | data rows added: ' + $row + ' | rows already had col: ' + $skipAlready)
