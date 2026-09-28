# Dispatch Turn 115 — Coordinated Multi-Agent Task Distribution
$ErrorActionPreference = 'Stop'
$orca = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'

Write-Host "=== Turn 115 Dispatch Initiated at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

# 1. Dispatch T-CODEX-TEST-27 to Tester Codex
$testerTerm = "term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5"
$testerPrompt = @"
[PACKET T-CODEX-TEST-27 — Post-splice Orchestrator typecheck and admin list contract offline verification]

OBJECTIVE: Verify that Qwen-Admin's W-ADMUX02-EXT-1 splice to server.ts resolves all compile errors (including previous hasPageAbove) and passes new admin list contract conformance tests offline.

STEPS:
1. Build contracts:
   pnpm --filter @du/contracts build
2. Run Orchestrator typecheck (clean exit code 0 required):
   pnpm --filter @du/orchestrator exec tsc --noEmit
3. Run the new Admin list contract conformance and pagination suites:
   pnpm --filter @du/orchestrator test -- tests/admin-list-contract-conformance.test.ts tests/admin-operations-list-pagination.test.ts tests/admin-actions-dispatch-offline.test.ts
4. Record raw logs to: du-rework/coordination/reports/T-CODEX-TEST-27-admin-conformance.log
5. Record clean receipt in du-rework/coordination/reports/tester.md under ## T-CODEX-TEST-27 — Post-splice Orchestrator typecheck and admin list contract offline verification.

CONSTRAINTS:
- OFFLINE ONLY (do NOT claim DB/Redis window, do NOT modify code, do NOT commit/push).
"@

Write-Host "Dispatching T-CODEX-TEST-27 to Tester..."
& $orca terminal send --terminal $testerTerm --text $testerPrompt --enter --json | Out-Null
Write-Host "Tester dispatched."

# 2. Dispatch D-EVID-A18 to Qwen-Docs
$docsTerm = "term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e"
$docsPrompt = @"
[PACKET D-EVID-A18 — Evidence Ledger Sync & Document Version Bump v1.27.0]

TASK 1 — Synchronize evidence inventory docs/28 and docs/35:
Integrate receipts from recent cycles:
1. T-CODEX-TEST-24 (Admin list contract verification offline — 3 suites passed, 1 skipped)
2. T-CODEX-TEST-25 (Live audit red findings — 5 passed, 6 failed on 401 unknown-bearer contract and transient compile error)
3. T-CODEX-TEST-26 (Vault offline test inventory — Contracts 2 suites / 81 pass; Connector 3 suites / 38 pass; Orchestrator 2 pass / 1 fail with 7 failures in mock-vault-harness due to missing connector ownership binding)
4. Qwen-SEC W-OIDC04-SESSION-FLOW (receipt §8 in qwen-sec.md — 42/42 pass, HTTPS Secure/HttpOnly/SameSite=Lax verified offline, Δ26/Δ27 recorded)
5. Qwen-Admin W-ADMUX02-EXT-1 (receipt §12 in qwen-admin.md — audit + api-keys list contracts with 23 new tests, targeted 439/439 x3 pass, Δ37–Δ41 recorded)

TASK 2 — Link check & version bump:
1. Bump document version to v1.27.0.
2. Run link check across all documentation targets (assert BROKEN=0).
3. Append clean receipt to du-rework/coordination/reports/qwen-docs.md.

CONSTRAINTS:
- Documentation only. Do NOT modify source code or tests, do NOT commit/push.
"@

Write-Host "Dispatching D-EVID-A18 to Qwen-Docs..."
& $orca terminal send --terminal $docsTerm --text $docsPrompt --enter --json | Out-Null
Write-Host "Qwen-Docs dispatched."

# 3. Dispatch W-DATA01-S3-FACADE-1 to Qwen-DATA
$dataTerm = "term_6df22fa3-e399-4e31-9400-364917d9bdc8"
$dataPrompt = @"
[PACKET W-DATA01-S3-FACADE-1 — Resolve Ingestion Source Contract Mismatch Δ14 and S3 wire facade]

OBJECTIVE: Address Δ14 identified in cycle 5 regarding markIngestionReady storing __source in operations.input_ref vs tasks.payload_ref, and align source resolution contracts.

STEPS:
1. Examine packages/contracts/src/ and businesses/document-core/src/actions/ingest/ to verify where IngestAction.prepareSources reads input sources.
2. Ensure markIngestionReady and payload envelope schema provide consistent artifact reference resolution without failing on missing __source or unhandled input document.
3. Verify immutable version pin and SHA-256 integrity on artifact inputs.
4. Run targeted tests:
   pnpm --filter @du/contracts test
   pnpm --filter @du/worker-sdk test -- tests/source-acquisition.test.ts tests/artifact-read-metadata.test.ts
5. Verify clean tsc / lint (ExitCode 0).
6. Record clean receipt in du-rework/coordination/reports/qwen-data.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB/Redis window. Do NOT touch Admin or OIDC files. Do NOT commit/push.
"@

Write-Host "Dispatching W-DATA01-S3-FACADE-1 to Qwen-DATA..."
& $orca terminal send --terminal $dataTerm --text $dataPrompt --enter --json | Out-Null
Write-Host "Qwen-DATA dispatched."

# 4. Dispatch W-SEC-OIDC04-PROXY-1 to Qwen-SEC
$secTerm = "term_3c201a29-7279-49c4-8dda-89bb6c18f48a"
$secPrompt = @"
[PACKET W-SEC-OIDC04-PROXY-1 — Secure cookie reverse-proxy trust and session rotation defense]

OBJECTIVE: Address findings Δ26 (Secure flag protocol check behind reverse proxies) and Δ27 (legacy cookie secure flags) from cycle 8.

STEPS:
1. Examine services/orchestrator/src/app/admin/oidc-boot.ts and shell-router.ts regarding cookie options.
2. In contracts or oidc-boot, introduce explicit configuration / contract checks so that when running in production or behind TLS termination (X-Forwarded-Proto: https), Secure flag is strictly enforced.
3. Add offline unit/handler tests verifying:
   - Request with X-Forwarded-Proto: https enforces Secure session cookie.
   - Forged headers or mixed protocols fail closed without exposing non-secure session cookies.
4. Run targeted offline test chain:
   pnpm --filter @du/orchestrator test -- tests/admin-shell-session-lifecycle.test.ts tests/oidc03-role-action-tenant-offline.test.ts
5. Ensure clean tsc --noEmit.
6. Record clean receipt in du-rework/coordination/reports/qwen-sec.md.

CONSTRAINTS:
- OFFLINE ONLY. Do NOT claim DB/Redis window. Do NOT modify Admin layout/CSS files. Do NOT commit/push.
"@

Write-Host "Dispatching W-SEC-OIDC04-PROXY-1 to Qwen-SEC..."
& $orca terminal send --terminal $secTerm --text $secPrompt --enter --json | Out-Null
Write-Host "Qwen-SEC dispatched."

Write-Host "=== Turn 115 Dispatch Completed Successfully ==="
