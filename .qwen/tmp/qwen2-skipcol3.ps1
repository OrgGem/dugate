# W43-Q17 pass 3 (correct): restore-clean then insert Skipped via cell-split
$f = 'D:\Git\dugate\du-rework\docs\35-acceptance-baseline.md'
$bak = 'D:\Git\dugate\.qwen\tmp\35-backup-w43q17.md'
Copy-Item $bak $f -Force
$lines = Get-Content $f -Encoding UTF8
$out = New-Object System.Collections.Generic.List[string]
$row = 0; $hdr = 0
foreach ($line in $lines) {
  if ($line -match '^\|\s*#\s*\|') {
    $cells = $line -split '\|'
    # find header cell 'Literal Test Summary'
    $idx = -1
    for ($i = 0; $i -lt $cells.Count; $i++) { if ($cells[$i] -match 'Literal Test Summary') { $idx = $i; break } }
    if ($idx -ge 0 -and $cells[$idx+1] -notmatch 'Skipped') {
      $new = @(); $new += $cells[0..$idx]; $new += ' Skipped '; if ($idx+1 -lt $cells.Count) { $new += $cells[($idx+1)..($cells.Count-1)] }
      $out.Add(($new -join '|')); $hdr++
    } else { $out.Add($line) }
    continue
  }
  $cells = $line -split '\|'
  if ($cells.Count -ge 6 -and $cells[1] -match '^\s*\d+\s*$' -and $cells[4].Trim().StartsWith('`Tests:')) {
    $lit = $cells[4].Trim()
    $passed = 0; $failed = 0; $skipped = -1; $total = 0
    if ($lit -match '(\d+)\s+passed') { $passed = [int]$Matches[1] }
    if ($lit -match '(\d+)\s+failed') { $failed = [int]$Matches[1] }
    if ($lit -match '(\d+)\s+skipped') { $skipped = [int]$Matches[1] }
    if ($lit -match '(\d+)\s+total')  { $total  = [int]$Matches[1] }
    if ($skipped -lt 0) { $skipped = [Math]::Max(0, $total - $passed - $failed) }
    $new = @(); $new += $cells[0..4]; $new += (' ' + $skipped + ' '); $new += $cells[5..($cells.Count-1)]
    $out.Add(($new -join '|')); $row++
  } else { $out.Add($line) }
}
[System.IO.File]::WriteAllLines($f, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('headers: ' + $hdr + ' | data rows: ' + $row)
