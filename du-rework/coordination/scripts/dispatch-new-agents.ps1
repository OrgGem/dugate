# Dispatch tasks to 3 new agents
$ErrorActionPreference = 'Stop'
$orca = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'

Write-Host "=== Dispatching to 3 New Agents at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

# Agent 1: Platform Core Coder (term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33)
$termPlatform = "term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33"
$promptPlatform = @"
[PACKET W-PLAT-MM05-REARM-1 — Queue Integrity & Re-arm Task/Operation CAS Condition]

ROLE: Platform Core Coder (Orchestrator runtime, queue dispatcher, lease recovery)

OBJECTIVE: Resolve Reviewer finding on MM-05 queue integrity re-arm CAS condition. Currently re-arm CAS only checks outbox stamp/attempt, but does not re-verify that the task and operation are still eligible/runnable (not cancelled) after Redis check.

STEPS:
1. Examine services/orchestrator/src/modules/queue/ and services/orchestrator/src/modules/runtime/runtime.ts around sweepQueueIntegrity / re-arm queries.
2. In the UPDATE query that re-arms the queue, add the condition that task state is still RUNNABLE/READY and operation is not terminal (CANCELLED/FAILED/SUCCEEDED).
3. Run Orchestrator typecheck:
   pnpm --filter @du/orchestrator exec tsc --noEmit
4. Run targeted offline test suites:
   pnpm --filter @du/orchestrator test -- tests/admin-queue-integrity.test.ts tests/p8-02-runtime-reliability.test.ts
5. Create and append clean receipt to du-rework/coordination/reports/qwen-platform.md with command, exit code, test counts.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB/Redis window. Do NOT commit/push.
"@

Write-Host "Sending packet to qwen_platform ($termPlatform)..."
& $orca terminal send --terminal $termPlatform --text $promptPlatform --enter --json | Out-Null
Write-Host "qwen_platform dispatched."

# Agent 2: Security & Vault Implementer (term_a7757226-f4e4-45a0-ad54-dd9aa01436c4)
$termVault = "term_a7757226-f4e4-45a0-ad54-dd9aa01436c4"
$promptVault = @"
[PACKET W-VAULT-BINDING-FIX-1 — Fix mock-vault-harness BINDING_DENIED and ownership validation]

ROLE: Security & Vault Implementer (VAULT-01..06, SecretResolver, ownership binding)

OBJECTIVE: Fix the 7 failures in mock-vault-harness-offline.functional.test.ts where the workflow returns BINDING_DENIED due to unavailable connector ownership binding.

STEPS:
1. Examine services/orchestrator/tests/mock-vault-harness-offline.functional.test.ts, services/orchestrator/src/modules/connector-credentials/, and packages/contracts/src/vault-policies.ts.
2. Ensure the mock harness / test setup and connector credential resolver provide valid tenantId and accountId bindings that satisfy matchesVaultAccountPath.
3. Verify contracts build:
   pnpm --filter @du/contracts build
4. Run targeted offline test suites:
   pnpm --filter @du/orchestrator test -- tests/mock-vault-harness-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts
   All tests must PASS clean (ExitCode 0).
5. Create and append clean receipt to du-rework/coordination/reports/qwen-vault.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB/Redis window. Do NOT touch Admin UI HTML/CSS. Do NOT commit/push.
"@

Write-Host "Sending packet to qwen_vault ($termVault)..."
& $orca terminal send --terminal $termVault --text $promptVault --enter --json | Out-Null
Write-Host "qwen_vault dispatched."

# Agent 3: Cost & Observability Implementer (term_4ed1695f-9152-40af-b6f2-2c3d984f0e43)
$termCost = "term_4ed1695f-9152-40af-b6f2-2c3d984f0e43"
$promptCost = @"
[PACKET W-COST-SCHEMA-LEDGER-1 — COST-01 Token & Usage Ledger Contract and View Models]

ROLE: Cost & Observability Implementer (COST-01..04, token ledger, pricing models, LOG-01..02)

OBJECTIVE: Lay the groundwork for COST-01 token and cost tracking per du-rework/docs/admin-ops-monitoring-cost.md.

STEPS:
1. Review du-rework/docs/admin-ops-monitoring-cost.md and packages/observability/.
2. In packages/contracts/src/ or packages/observability/src/, define OperationUsageMetrics schema (prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost_estimate_usd, duration_ms).
3. Ensure usage records strictly redact any sensitive prompts or secrets (only token counts and sanitized metadata).
4. Run contracts build and observability tests:
   pnpm --filter @du/contracts build
   pnpm --filter @du/observability test
   pnpm --filter @du/contracts test
5. Create and append clean receipt to du-rework/coordination/reports/qwen-cost.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB/Redis window. Do NOT touch Admin UI layout. Do NOT commit/push.
"@

Write-Host "Sending packet to qwen_cost ($termCost)..."
& $orca terminal send --terminal $termCost --text $promptCost --enter --json | Out-Null
Write-Host "qwen_cost dispatched."

Write-Host "=== All 3 New Agents Dispatched Successfully ==="
