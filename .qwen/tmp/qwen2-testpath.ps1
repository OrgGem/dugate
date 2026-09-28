# Qwen-2 re-Test-Path verification for docs/29,31,32,36 takeover (W43-Q2)
# Resolved from repo root D:\Git\dugate\du-rework. Output: True/False + path.
$root = 'D:\Git\dugate\du-rework'
$paths = @(
  # --- docs/29 run-request queue: commands + targets + cwd ---
  'tools/openapi/validate_openapi.py',
  'services/orchestrator/tests/runtime.test.ts',
  'services/orchestrator/tests/blob-wire-binary.test.ts',
  'services/orchestrator/tests/ingress-bounded.test.ts',
  'services/orchestrator/tests/usage-summary.test.ts',
  'services/orchestrator/tests/admin-profile-view-model.test.ts',
  'services/orchestrator/tests/admin-connector-view-model.test.ts',
  'services/orchestrator/tests/admin-api-key-view-model.test.ts',
  'services/orchestrator/tests/admin-operation-view-model.test.ts',
  'tests/integration/p4-05-artifact-streams.integration.test.ts',
  'tests/integration/p4-08-sdk-consumer.integration.test.ts',
  'tests/integration/p8-02-fault-recovery.integration.test.ts',
  'tests/integration/artifacts-grants.integration.test.ts',
  'tests/integration/artifact-retention.integration.test.ts',
  'tests/integration/version-drain.integration.test.ts',
  'businesses/example-review/tests/version-drain.integration.test.ts',
  'tests/integration/operator-routes.integration.test.ts',
  'businesses/example-review/tests/p7-03-registry-live.integration.test.ts',
  'businesses/example-review/tests/p7-04-profile-assignment.integration.test.ts',
  'services/connector/tests/p8-03-convergence.test.ts',
  'tests/isolation',
  'packages/worker-sdk',
  'packages/connector-client',
  'services/orchestrator',
  # --- docs/31 MM-status evidence files ---
  'packages/worker-sdk/src/connector-invoker.ts',
  'services/connector/src/entrypoint.ts',
  'services/connector/src/http/server.ts',
  'services/orchestrator/src/server.ts',
  'services/orchestrator/src/modules/operations/submission.ts',
  'services/orchestrator/src/modules/operations/facade.ts',
  'services/orchestrator/src/modules/queue/dispatcher.ts',
  'services/orchestrator/src/modules/runtime/runtime.ts',
  'services/connector/src/invoke.ts',
  'services/connector/src/services.ts',
  'services/orchestrator/src/modules/artifacts/artifacts.ts',
  'services/orchestrator/src/modules/registry/registry.ts',
  'services/orchestrator/package.json',
  'services/orchestrator/dist/server.js',
  'services/orchestrator/worker.ts',
  'worker.ts',
  'tests/isolation/namespace.ts',
  'tests/isolation/concurrent-runner.ps1',
  'tests/isolation/concurrent-interference.test.ts',
  'tests/isolation/verify-baseline-counts.ps1',
  'docs/28-test-inventory.md',
  'docs/30-tick-evidence-map.md',
  'docs/35-acceptance-baseline.md',
  'docs/34-p4-08-type-drift-spec.md',
  'docs/25-mm-status-crosscheck.md',
  'docs/23-mm-11-tenant-decision.md',
  'docs/22-p0-06-capacity-targets.md',
  'docs/19-traceability-audit-matrix.md',
  'docs/32-p0-01-acceptance-spec.md',
  'docs/29-run-request-queue.md',
  'docs/31-mm-status-refresh.md',
  'docs/36-evidence-table-reconciliation.md',
  'businesses/document-core/docs/workload-assumptions.md',
  'tasks/PLAN-MISMATCH-FIXES-2026-09-23.md',
  'tasks/P0-business-specs.md',
  'tasks/P1-foundation-contracts.md',
  'tasks/P2-orchestrator.md',
  'tasks/P3-connector.md',
  'tasks/P4-worker-sdk.md',
  'tasks/P5-document-core.md',
  'tasks/P6-admin.md',
  'tasks/P7-extension-proof.md',
  'tasks/P8-release-readiness.md',
  # --- docs/32 Gap files ---
  'businesses/example-review/tests/version-coexistence.test.ts',
  # --- docs/36 phantom/quarantined + real ---
  'tests/integration/blob-wire-binary.integration.test.ts',
  'tests/integration/connector-e2e.integration.test.ts',
  'tests/integration/connector-real-service.integration.test.ts',
  'tests/integration/continuation-resume.integration.test.ts',
  'tests/integration/cross-service-boundary.integration.test.ts',
  'tests/integration/full-system-e2e.integration.test.ts',
  'tests/integration/p7-03-extension-deployment.integration.test.ts',
  'tests/integration/p7-04-generic-admin-profile.integration.test.ts',
  'tests/integration/bullmq-task-queue.integration.test.ts',
  'packages/connector-client/tests/real-service.test.ts',
  'businesses/document-core/tests/bullmq-smoke.test.ts',
  # --- document-core offline suites (my functional-test scope) ---
  'businesses/document-core/tests/ingest.test.ts',
  'businesses/document-core/tests/extract.test.ts',
  'businesses/document-core/tests/analyze.test.ts',
  'businesses/document-core/tests/transform.test.ts',
  'businesses/document-core/tests/generate.test.ts',
  'businesses/document-core/tests/compare.test.ts',
  'businesses/document-core/tests/all-variants-e2e.test.ts',
  'businesses/document-core/tests/bounded-input.test.ts',
  'businesses/document-core/tests/profile-binding-fixture.test.ts',
  'businesses/document-core/tests/provider-backed-variant.test.ts',
  'businesses/document-core/tests/traceability.test.ts',
  'businesses/document-core/tests/manifest.test.ts',
  'businesses/document-core/tests/checkpoint-replay.test.ts',
  'businesses/document-core/tests/output-validation.test.ts'
)
$total = $paths.Count
$trueCount = 0
$falseList = @()
foreach ($p in $paths) {
  $full = Join-Path $root $p
  $ok = Test-Path $full
  if ($ok) { $trueCount++ } else { $falseList += $p }
  Write-Output (('{0}' -f $ok).PadRight(6) + ' ' + $p)
}
Write-Output ('---')
Write-Output ('Total: ' + $total + ' | Test-Path True: ' + $trueCount + ' | False: ' + $falseList.Count)
if ($falseList.Count -gt 0) { Write-Output 'MISSING:'; $falseList | ForEach-Object { Write-Output ('  ' + $_) } }