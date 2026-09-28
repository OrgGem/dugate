# W47-Q2-4: reconcile disk test files vs ledger (docs/28 + docs/35). ASCII only.
$root = 'D:\Git\dugate\du-rework'
$outFile = 'D:\Git\dugate\.qwen\tmp\w47q24-report.txt'

$disk = Get-ChildItem -Path $root -Recurse -File -Include '*.test.ts','*.spec.ts','*.test.tsx','*.test.ts' |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\playwright-report\\|\\test-results\\|\\.qwen\\' } |
  ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\','/').ToLower() } | Sort-Object -Unique

$ledger = @{}
foreach ($doc in @("$root\docs\28-test-inventory.md", "$root\docs\35-acceptance-baseline.md")) {
  foreach ($line in (Get-Content $doc -Encoding UTF8)) {
    foreach ($m in [regex]::Matches($line, '([A-Za-z0-9_./\\-]+\.(?:test|spec)\.ts)')) {
      $tok = $m.Groups[1].Value.Replace('\','/').ToLower() -replace '^du-rework/',''
      if (-not $ledger.ContainsKey($tok)) { $ledger[$tok] = @() }
      $leaf = Split-Path $doc -Leaf
      if ($ledger[$tok] -notcontains $leaf) { $ledger[$tok] += $leaf }
    }
  }
}

$diskArr = @($disk)
$ledgerArr = @($ledger.Keys | Sort-Object)
# suffix matching: a ledger token matches a disk file if one path ends with the other (handles cwd-relative citations)
function Resolve-Disk([string]$tok, [string[]]$disks) {
  if ($disks -contains $tok) { return $tok }
  $hits = @($disks | Where-Object { $_.EndsWith($tok) -or $tok.EndsWith($_) })
  if ($hits.Count -ge 1) { return $hits[0] }
  return $null
}
$ledgerResolved = @{}
foreach ($t in $ledgerArr) { $r = Resolve-Disk $t $diskArr; if ($r) { $ledgerResolved[$t] = $r } }
$ledgerOnly = @($ledgerArr | Where-Object { -not $ledgerResolved.ContainsKey($_) })
$matchedDisk = @($ledgerResolved.Values | Sort-Object -Unique)
$diskOnly = @($diskArr | Where-Object { $matchedDisk -notcontains $_ })
$both = @($matchedDisk)

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("W47-Q2-4 reconcile report - " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zz00'))
[void]$sb.AppendLine("DISK test files total: " + $diskArr.Count)
[void]$sb.AppendLine("LEDGER distinct path tokens (docs/28+docs/35): " + $ledgerArr.Count)
[void]$sb.AppendLine("BOTH: " + $both.Count + " | DISK-ONLY: " + $diskOnly.Count + " | LEDGER-ONLY: " + $ledgerOnly.Count)
[void]$sb.AppendLine('')
[void]$sb.AppendLine('=== A. DISK-ONLY (on disk, missing from ledger) ===')
foreach ($f in $diskOnly) { [void]$sb.AppendLine('  ' + $f) }
[void]$sb.AppendLine('')
[void]$sb.AppendLine('=== B. LEDGER-ONLY (with Test-Path) ===')
foreach ($f in $ledgerOnly) {
  $p = Join-Path $root $f
  $tp = Test-Path $p
  [void]$sb.AppendLine('  ' + $f + '  Test-Path=' + $tp + '  cited:' + ($ledger[$f] -join ','))
}
[void]$sb.AppendLine('')
[void]$sb.AppendLine('=== C. BOTH (match) grouped by top-2 segments ===')
$groups = $both | ForEach-Object { $parts = ($_ -split '/'); if ($parts.Count -ge 2) { ($parts[0..1] -join '/') } else { $_ } } | Group-Object | Sort-Object Name
foreach ($g in $groups) { [void]$sb.AppendLine(('  {0,-50} {1}' -f $g.Name, $g.Count)) }
[System.IO.File]::WriteAllText($outFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("report: " + $outFile)
Write-Output ("DISK=" + $diskArr.Count + " LEDGER=" + $ledgerArr.Count + " BOTH=" + $both.Count + " DISKONLY=" + $diskOnly.Count + " LEDGERONLY=" + $ledgerOnly.Count)
