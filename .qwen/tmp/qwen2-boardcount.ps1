# Qwen-2 W43-Q10: count actual table rows in P0..P9 + SEC + DEPLOY boards
$root = 'D:\Git\dugate\du-rework\tasks'
$files = Get-ChildItem -Path $root -Filter 'P*.md' | Sort-Object { if ($_.Name -match '^P(\d+)-') { [int]$matches[1] } else { 99 } }
$rowRe = '^\|\s*(P\d+-\d+)\s*\|.*\[\s*\]'
$tildeRe = '^\|\s*(P\d+-\d+)\s*\|.*\[~\]'
$xRe = '^\|\s*(P\d+-\d+)\s*\|.*\[x\]'
$anyRe = '^\|\s*(P\d+-\d+)\s*\|'
Write-Output '=== P0..P9 boards (actual table rows) ==='
$sum = @{ total = 0; open = 0; tilde = 0; x = 0; other = 0 }
foreach ($f in $files) {
  $total=0; $open=0; $tilde=0; $x=0; $other=0; $rows=@()
  foreach ($line in (Get-Content $f.FullName)) {
    $m = [regex]::Match($line, $anyRe)
    if ($m.Success) {
      $total++
      $id = $m.Groups[1].Value
      if ($line -match '\[\s*\]') { $open++ }
      elseif ($line -match '\[~\]') { $tilde++ }
      elseif ($line -match '\[x\]') { $x++ }
      else { $other++; $rows += $id }
    }
  }
  $sum.total += $total; $sum.open += $open; $sum.tilde += $tilde; $sum.x += $x; $sum.other += $other
  Write-Output ($f.Name.PadRight(28) + ' rows=' + $total + ' [ ]=' + $open + ' [~]=' + $tilde + ' [x]=' + $x + ' other=' + $other)
  if ($rows.Count) { Write-Output ('    other-ids: ' + ($rows -join ',')) }
}
Write-Output ('TOTAL P0..P9: rows=' + $sum.total + ' [ ]=' + $sum.open + ' [~]=' + $sum.tilde + ' [x]=' + $sum.x + ' other=' + $sum.other)

Write-Output '=== SEC-OIDC-VAULT-2026-09-24.md ==='
$sec = Get-Content (Join-Path $root 'SEC-OIDC-VAULT-2026-09-24.md')
$secCount = 0; $secOpen=0; $secTilde=0; $secX=0; $secOther=0; $secIds=@()
foreach ($line in $sec) {
  $m = [regex]::Match($line, '^\|\s*(SEC-\d+|ADM-BASE-\d+|OIDC-\d+|VAULT-\d+|SEC-INT-\d+)\s*\|')
  if ($m.Success) {
    $secCount++; $secIds += $m.Groups[1].Value
    if ($line -match '\[\s*\]') { $secOpen++ } elseif ($line -match '\[~\]') { $secTilde++ } elseif ($line -match '\[x\]') { $secX++ } else { $secOther++ }
  }
}
Write-Output ('rows=' + $secCount + ' [ ]=' + $secOpen + ' [~]=' + $secTilde + ' [x]=' + $secX + ' other=' + $secOther)
Write-Output ('ids: ' + ($secIds -join ','))

Write-Output '=== DEPLOY-STORAGE-LOGGING-2026-09-24.md ==='
$dep = Get-Content (Join-Path $root 'DEPLOY-STORAGE-LOGGING-2026-09-24.md')
$depCount=0; $depOpen=0; $depOther=0; $depIds=@()
foreach ($line in $dep) {
  $m = [regex]::Match($line, '^\|\s*(DATA-\d+|LOG-\d+|DEP-\d+)\s*\|')
  if ($m.Success) {
    $depCount++; $depIds += $m.Groups[1].Value
    if ($line -match '\[\s*\]') { $depOpen++ } else { $depOther++ }
  }
}
Write-Output ('rows=' + $depCount + ' [ ]=' + $depOpen + ' other=' + $depOther)
Write-Output ('ids: ' + ($depIds -join ','))