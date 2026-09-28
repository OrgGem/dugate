# Qwen-2 W43-Q9 cross-check: every path cited in docs/29,31,32,35,36 (my docs)
# Resolved against D:\Git\dugate\du-rework (fallback: repo root). Output grouped.
$reworkRoot = 'D:\Git\dugate\du-rework'
$repoRoot   = 'D:\Git\dugate'
$docs = @(
  'D:\Git\dugate\du-rework\docs\29-run-request-queue.md',
  'D:\Git\dugate\du-rework\docs\31-mm-status-refresh.md',
  'D:\Git\dugate\du-rework\docs\32-p0-01-acceptance-spec.md',
  'D:\Git\dugate\du-rework\docs\35-acceptance-baseline.md',
  'D:\Git\dugate\du-rework\docs\36-evidence-table-reconciliation.md'
)
$knownTops = '^(services|packages|businesses|tests|docs|tools|tasks|architecture|coordination|src|app|utils|worker\.ts|modules|lib|components|mock-service|drizzle)'
$pathRe = [regex]'([A-Za-z0-9_]+/(?:[A-Za-z0-9_.\-]+/)*[A-Za-z0-9_.\-]+)'
$results = @{}
foreach ($docPath in $docs) {
  $doc = Get-Item $docPath
  $lines = Get-Content $docPath
  $docName = $doc.Name
  foreach ($line in $lines) {
    if ($line -match '^\s*(#|\||>)') { } # still scan tables/headings
    $ms = $pathRe.Matches($line)
    foreach ($m in $ms) {
      $tok = $m.Groups[1].Value
      # strip trailing punctuation and :line refs
      $tok = $tok -replace '[:~]\d+(-\d+)?$', ''
      $tok = $tok -replace '[.,;)\]}]$', ''
      if ($tok -match '^(https?://|artifact://)') { continue }
      if ($tok -notmatch $knownTops) {
        # bare filename shorthand (server.ts, facade.ts, registry-tool.ts) -> ambiguous base
        if ($tok -match '/') { continue }
        $key = "SHORTHAND::$docName::$tok"
        if (-not $results.ContainsKey($key)) { $results[$key] = $true }
        continue
      }
      $tok = $tok -replace '^du-rework/', ''
      if ($tok -eq '') { continue }
      if (-not $results.ContainsKey($tok)) { $results[$tok] = $docName }
    }
  }
}
Write-Output '=== UNIQUE PATH TOKENS FOUND & TEST RESULT ==='
$trueCount = 0; $falseList = @(); $shortList = @()
foreach ($tok in ($results.Keys | Sort-Object)) {
  if ($tok -like 'SHORTHAND::*') { $shortList += $tok; continue }
  $p1 = Join-Path $reworkRoot $tok
  $p2 = Join-Path $repoRoot $tok
  $ok = (Test-Path $p1) -or (Test-Path $p2)
  if ($ok) { $trueCount++ } else { $falseList += $tok }
}
Write-Output ('TRUE (exist under du-rework or repo root): ' + $trueCount)
Write-Output ('FALSE (does not exist): ' + $falseList.Count)
Write-Output '--- FALSE LIST (token | cited in) ---'
foreach ($tok in $falseList) { Write-Output ($tok + ' | ' + $results[$tok]) }
Write-Output '--- BARE-FILENAME SHORTHANDS (base ambiguous, needs manual resolve) ---'
foreach ($s in $shortList) { Write-Output $s }