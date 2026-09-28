$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'

# Dispatch to Tester
$testerPacket = @"
[PACKET T-CODEX-TEST-2] Dedicated Tester (Codex).
Read du-rework/AGENTS.md and coordination/reports/tester.md.
Nhiệm vụ: Offline validation and regression verification of newly landed code from Codex-Security (VAULT-01 revision binding) and full Orchestrator aggregate suite.
1. Run contracts tests:
   pnpm --filter @du/contracts test -- --runTestsByPath tests/vault-ref.test.ts
2. Run connector revision binding and vault isolation tests:
   pnpm --filter @du/connector test:unit --runTestsByPath tests/revision-binding.db.test.ts tests/revision-binding.schema.test.ts tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts
3. Run full Orchestrator aggregate unit suite:
   From cwd: D:\Git\dugate\du-rework\services\orchestrator
   npx jest --runInBand --config jest.unit.config.cjs
4. STRICT: Offline only. DO NOT claim DB window. Do not connect PostgreSQL :5433 or Redis :6380.
5. Capture raw output to coordination/reports/T-CODEX-TEST-2-*.log, record full literal receipt in coordination/reports/tester.md. Do not commit or push.
"@

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $testerPacket --enter --json
Write-Host "Dispatched to Tester."

# Dispatch to Qwen-Admin
$adminPacket = @"
[PACKET W-ADMUX-03-FILTER-1] Admin UI & UX Operator (Qwen-Admin).
Doc du-rework/AGENTS.md va tasks/ADMIN-OPS-UX-2026-09-24.md (ADM-UX-03 / ADM-UX-01).
Nhiem vu: Search/filter toolbar va deep links thong nhat cho Operations list.
1. Scope file sua:
   services/orchestrator/src/app/admin/operation-section-renderer.ts
   services/orchestrator/src/app/admin/shell-render.ts
   services/orchestrator/src/app/admin/operation-section-data.ts
2. Tinh nang can them:
   - Bo loc operations: state filter dropdown/chips (ALL, RUNNING, COMPLETED, FAILED, TIMED_OUT), tenant filter, ID search input.
   - Nut clear-all filters, hien thi badge/chip bo loc dang ap dung.
   - Giu query params trong deep link (URLSearchParams) khi refresh/back.
   - An toan: debounce/cancel request cu, khong ghi nhan raw secret/token/prompt vao DOM/URL.
3. Kiem thu:
   - Them test cases vao services/orchestrator/tests/admin-operations-list-pagination.test.ts hoac admin-shell-render.test.ts.
   - Typecheck tsc --noEmit pass (exit 0).
   - Jest targeted unit tests pass x3 lien tiep (exit 0).
4. STRICT: Offline only. Khong dung vao DB window, khong commit/push.
5. Ghi receipt va ledger vao du-rework/coordination/reports/qwen-admin.md.
"@

& $orcaCli terminal send --terminal term_bf93d438-9974-4c4e-88a8-90e6ea80d37c --text $adminPacket --enter --json
Write-Host "Dispatched to Qwen-Admin."
