# Dispatch Turn 119 — Parallel Execution Across All Lanes
$ErrorActionPreference = 'Stop'
$orca = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'

Write-Host "=== Turn 119 Dispatch Initiated at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

# 1. Tester: T-CODEX-TEST-28
$termTester = "term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5"
$promptTester = @"
[PACKET T-CODEX-TEST-28 — Independent verification of Vault mock-harness and MM-05 queue integrity offline suites]

OBJECTIVE: Verify qwen_vault's fix for mock-vault-harness BINDING_DENIED and qwen_platform's fix for MM-05 queue integrity re-arm.

STEPS:
1. Run Vault offline test suites:
   pnpm --filter @du/contracts build
   pnpm --filter @du/orchestrator test -- tests/mock-vault-harness-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts
   Verify that all tests pass (0 BINDING_DENIED failures).
2. Run MM-05 queue integrity offline suites:
   pnpm --filter @du/orchestrator test -- tests/mm05-queue-integrity-sweep.test.ts tests/mm05-queue-integrity-offline.functional.test.ts
3. Capture raw output to: du-rework/coordination/reports/T-CODEX-TEST-28-vault-mm05-verify.log
4. Append clean receipt to du-rework/coordination/reports/tester.md under ## T-CODEX-TEST-28.

CONSTRAINTS:
- OFFLINE ONLY (no live DB window). Do NOT edit code, do NOT commit/push.
"@

# 2. qwen_platform: W-PLAT-MM10-CANCEL-1
$termPlatform = "term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33"
$promptPlatform = @"
[PACKET W-PLAT-MM10-CANCEL-1 — Refuse Heartbeat Lease Renewal for Cancelled Tasks]

OBJECTIVE: Address Reviewer finding FR24-06 / MM-10: Currently heartbeat and saveStep fence epoch, but if cancel was requested, heartbeat still renews lease and returns cancelRequested: false.

STEPS:
1. Examine services/orchestrator/src/modules/runtime/runtime.ts around heartbeatTask / claimTask.
2. In heartbeatTask, check if the task or operation has cancel_requested = true or state = CANCEL_REQUESTED.
3. If cancel is requested, refuse to extend lease_expires_at, return cancelRequested: true or appropriate 410 status.
4. Run offline unit tests:
   pnpm --filter @du/orchestrator test -- tests/p8-02-runtime-reliability.test.ts
5. Verify clean tsc --noEmit.
6. Append clean receipt to du-rework/coordination/reports/qwen-platform.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB window. Do NOT commit/push.
"@

# 3. qwen_vault: W-VAULT-POLICY-CANONICAL-1
$termVault = "term_a7757226-f4e4-45a0-ad54-dd9aa01436c4"
$promptVault = @"
[PACKET W-VAULT-POLICY-CANONICAL-1 — Canonical Path Enforcement and Traversal Rejection]

OBJECTIVE: Strengthen VAULT-01 / VAULT-02 path validation against traversal and foreign binding.

STEPS:
1. In packages/contracts/src/vault-policies.ts, verify that matchesVaultAccountPath rejects any path with '..' or traversal sequences.
2. Ensure canonical path structure matches: secret/data/du/tenants/<tenantId>/accounts/<accountId>/<rest>.
3. Add targeted unit tests in packages/contracts/tests/vault-policies.test.ts covering:
   - Path traversal attempts (../../).
   - Foreign tenant/account path mismatch.
   - Non-canonical alias normalization.
4. Run tests:
   pnpm --filter @du/contracts build
   pnpm --filter @du/contracts test -- tests/vault-policies.test.ts
5. Append clean receipt to du-rework/coordination/reports/qwen-vault.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB window. Do NOT commit/push.
"@

# 4. qwen_cost: W-COST02-PRICING-MODEL-1
$termCost = "term_4ed1695f-9152-40af-b6f2-2c3d984f0e43"
$promptCost = @"
[PACKET W-COST02-PRICING-MODEL-1 — Versioned Pricing Table and Cost Calculation Engine]

OBJECTIVE: Implement task COST-02 per du-rework/docs/admin-ops-monitoring-cost.md (versioned tariffs and cost estimation).

STEPS:
1. In packages/contracts/src/ or packages/observability/src/, define ModelPricingTier schema:
   - modelId (e.g., 'gpt-4o', 'claude-3-5-sonnet', 'qwen-max')
   - inputCostPerMillionTokensUsd
   - outputCostPerMillionTokensUsd
   - cachedInputCostPerMillionTokensUsd
2. Implement calculateOperationCost(usage: OperationUsageMetrics, pricing: ModelPricingTier): number function.
3. Add unit tests verifying exact cost calculations with integer micro-USD precision to avoid floating point drift.
4. Run tests and typecheck:
   pnpm --filter @du/contracts build
   pnpm --filter @du/observability test
5. Append clean receipt to du-rework/coordination/reports/qwen-cost.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB window. Do NOT touch Admin UI. Do NOT commit/push.
"@

# 5. qwen_admin: W-ADMUX03-TOOLBAR-CHIPS-1
$termAdmin = "term_bf93d438-9974-4c4e-88a8-90e6ea80d37c"
$promptAdmin = @"
[PACKET W-ADMUX03-TOOLBAR-CHIPS-1 — Operations List Filter Toolbar, Chips, and URL Sync]

OBJECTIVE: Implement ADM-UX-03 toolbar chips and clear-all controls for Operations list.

STEPS:
1. In services/orchestrator/src/app/admin/operation-section-renderer.ts:
   - Render active filter chips for state, tenant, and id when filtered.
   - Render 'Clear all' button (data-filter-clear-all) resetting to limit=20 without filter params.
   - Maintain deep link URL consistency.
2. Run targeted admin tests:
   pnpm --filter @du/orchestrator test -- tests/admin-operations-list-pagination.test.ts tests/admin-list-contract-conformance.test.ts
3. Verify clean tsc:
   pnpm --filter @du/orchestrator exec tsc --noEmit
4. Append clean receipt to du-rework/coordination/reports/qwen-admin.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB window. Do NOT commit/push.
"@

# 6. qwen_data: W-DATA04-STREAM-BOUNDS-1
$termData = "term_6df22fa3-e399-4e31-9400-364917d9bdc8"
$promptData = @"
[PACKET W-DATA04-STREAM-BOUNDS-1 — Worker Artifact Streaming Bounds and RSS Protection]

OBJECTIVE: Implement DATA-04 streaming limits in worker-sdk to prevent unbounded memory growth during artifact reads.

STEPS:
1. In packages/worker-sdk/src/artifact-streams.ts:
   - Ensure readStream enforces explicit highWaterMark and byte limit watchdogs.
   - Ensure abort signals propagate immediately to underlying fetch/stream.
2. Run targeted tests:
   pnpm --filter @du/worker-sdk test -- tests/artifact-streams.test.ts tests/artifact-multipart-rss.test.ts
3. Verify clean build:
   pnpm --filter @du/worker-sdk test
4. Append clean receipt to du-rework/coordination/reports/qwen-data.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB window. Do NOT commit/push.
"@

# 7. qwen_sec: W-SEC-COOKIE-CONFIG-1
$termSec = "term_3c201a29-7279-49c4-8dda-89bb6c18f48a"
$promptSec = @"
[PACKET W-SEC-COOKIE-CONFIG-1 — Wire du_admin Cookie Secure Flag via ShellRuntimeConfig]

OBJECTIVE: Resolve Δ27 / Δ33: ensure legacy du_admin cookie also honors the Secure cookie policy when running behind TLS reverse proxy.

STEPS:
1. In services/orchestrator/src/app/admin/shell-router.ts and shell-server.ts:
   - Use parseCookieSecurePolicy to determine secure flag for du_admin cookie minting.
2. Add offline test in tests/admin-shell-session-lifecycle.test.ts verifying du_admin cookie has Secure attribute when trust proxy protocol is active.
3. Run tests and typecheck:
   pnpm --filter @du/orchestrator test -- tests/admin-shell-session-lifecycle.test.ts
   pnpm --filter @du/orchestrator exec tsc --noEmit
4. Append clean receipt to du-rework/coordination/reports/qwen-sec.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB window. Do NOT commit/push.
"@

# 8. qwen_docs: D-EVID-A19
$termDocs = "term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e"
$promptDocs = @"
[PACKET D-EVID-A19 — Traceability Matrix Sync for Turn 118 Closures]

OBJECTIVE: Update docs/19-traceability-audit-matrix.md with closures from Turn 118 (MM-05 CAS re-arm, Vault mock binding, COST-01 schema, Δ14 S3 facade, Δ26 proxy cookie).

STEPS:
1. In docs/19-traceability-audit-matrix.md:
   - Add traceability entries linking MM-05, VAULT-01, COST-01, DATA-01, OIDC-04 to their Turn 118 receipts.
2. Run link check across all documentation files:
   Verify BROKEN=0.
3. Append clean receipt to du-rework/coordination/reports/qwen-docs.md.

CONSTRAINTS:
- Documentation only. Do NOT modify source code or tests. Do NOT commit/push.
"@

Write-Host "Dispatching packets to all 8 worker agents..."
& $orca terminal send --terminal $termTester --text $promptTester --enter --json | Out-Null
& $orca terminal send --terminal $termPlatform --text $promptPlatform --enter --json | Out-Null
& $orca terminal send --terminal $termVault --text $promptVault --enter --json | Out-Null
& $orca terminal send --terminal $termCost --text $promptCost --enter --json | Out-Null
& $orca terminal send --terminal $termAdmin --text $promptAdmin --enter --json | Out-Null
& $orca terminal send --terminal $termData --text $promptData --enter --json | Out-Null
& $orca terminal send --terminal $termSec --text $promptSec --enter --json | Out-Null
& $orca terminal send --terminal $termDocs --text $promptDocs --enter --json | Out-Null

Write-Host "=== Turn 119 Full Multi-Agent Dispatch Completed Successfully ==="
