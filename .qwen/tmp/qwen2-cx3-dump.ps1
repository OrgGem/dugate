# W43-Q11: dump cited file:line ranges from codex3.md (verify existence + content)
$root = 'D:\Git\dugate\du-rework'
$items = @(
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='11-27' ; n='SEC backlog table (16 IDs)' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='32-36' ; n='SEC-00/INT dependency region' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='65-67' ; n='OIDC-03 operator mutation region' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='77-86' ; n='VAULT-05/SEC-05 dependency region' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='83-86' ; n='VAULT-05 dep claim region' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='90-92' ; n='SEC-06 tenant/revoke region' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='94-98' ; n='SEC-07 gate region' },
  @{ f='tasks/SEC-OIDC-VAULT-2026-09-24.md'; r='97-98' ; n='SEC-07 G-SEC/' },
  @{ f='tasks/P2-orchestrator.md'; r='8-16' ; n='P2 row table' },
  @{ f='tasks/P3-connector.md'; r='8-11' ; n='P3 row table' },
  @{ f='tasks/P6-admin.md'; r='11-17' ; n='P6 row table' },
  @{ f='tasks/P8-release-readiness.md'; r='11-18' ; n='P8 row table' },
  @{ f='services/orchestrator/src/app/admin/operation-view-models.ts'; r='360-394' ; n='cancel/resume view model' },
  @{ f='services/orchestrator/src/server.ts'; r='208-220' ; n='server error boundary A' },
  @{ f='services/orchestrator/src/server.ts'; r='259-269' ; n='server error boundary B' },
  @{ f='packages/observability/src/redaction.ts'; r='33-39' ; n='redaction patterns' },
  @{ f='services/orchestrator/src/app/admin/shell-router.ts'; r='346-359' ; n='POST->handleSectionGet seam' },
  @{ f='services/orchestrator/src/app/admin/shell-router.ts'; r='899-921' ; n='POST->handleSectionGet seam B' },
  @{ f='services/orchestrator/src/modules/webhooks/webhooks.ts'; r='176-195' ; n='webhook last_error' },
  @{ f='packages/observability/src/metrics.ts'; r='45-55' ; n='metric labels' },
  @{ f='services/orchestrator/src/app/admin/operation-section-renderer.ts'; r='84-95' ; n='artifact filename render' },
  @{ f='services/orchestrator/src/modules/operations/submission.ts'; r='150-180' ; n='submission input persist' },
  @{ f='services/orchestrator/src/app/admin/shell-server.ts'; r='170-177' ; n='shell error boundary' },
  @{ f='services/orchestrator/src/app/admin/connector-section-data.ts'; r='400-404' ; n='connector section error' },
  @{ f='services/orchestrator/src/modules/usage/usage.ts'; r='82-84' ; n='usage payload' },
  @{ f='services/connector/src/db/repository.ts'; r='71-84' ; n='connector persistence A' },
  @{ f='coordination/reports/openclaude.md'; r='1138-1159' ; n='six PLATFORM REQUEST groups' }
)
foreach ($it in $items) {
  $p = Join-Path $root $it.f
  $exists = Test-Path $p
  Write-Output ('### ' + $it.f + ' :' + $it.r + ' [' + $it.n + ']  Test-Path=' + $exists)
  if ($exists) {
    $lines = Get-Content $p
    $range = $it.r -split '-'
    $start = [int]$range[0]; $end = [int]$range[1]
    if ($end -gt $lines.Count) { $end = $lines.Count }
    for ($i = $start; $i -le $end; $i++) {
      Write-Output (('{0,4}: ' -f $i) + $lines[$i-1])
    }
  } else {
    Write-Output '  !! FILE MISSING'
  }
  Write-Output ''
}