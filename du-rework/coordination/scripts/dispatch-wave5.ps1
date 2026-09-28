$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'

# 1. Dispatch qwen_admin: W-ADMUX03-SHELL-SORT-1
$adminPrompt = @'
[PACKET W-ADMUX03-SHELL-SORT-1] Qwen-Admin (Wire sort parameter into Admin Shell operation-section-data.ts).
Doc du-rework/AGENTS.md, coordination/reports/review.md (Turn 150 finding 4), va server.ts:
Boi canh:
Reviewer Turn 150 nhan xet: "The Admin shell has no sort control and does not pass a manually entered sort through its parser/fetcher. Wire sort into the shell, complete the other Admin lists/filters, and run C1–C5 seeded browser acceptance."
Trong Mục 15, route server.ts da ho tro day du 6 sort values va keyset cursor bound voi sort. Bay gio can tich hop sort vao Admin Shell.

Nhiem vu:
1. File: services/orchestrator/src/app/admin/operation-section-data.ts:
   - Import OPERATIONS_LIST_SORT_FIELDS, OPERATIONS_LIST_SORT_DIRECTIONS, OPERATIONS_LIST_SORT_DEFAULT_FIELD, OPERATIONS_LIST_SORT_DEFAULT_DIRECTION tu @du/contracts.
   - Cap nhat parser/fetcher: ho tro tham so sort trong query state cua Shell.
   - Khi sort thay doi, reset cursor (cursor = null) de dam bao khong bi 422 mismatch voi cursor cu (tuan thu T140-A1).
2. Kiem thu offline:
   - pnpm --filter @du/orchestrator exec tsc --noEmit exit 0.
   - pnpm --filter @du/orchestrator test -- tests/admin-operation-view-model.test.ts (hoac tests/admin-operations-list-pagination.test.ts) exit 0.
   - Viet bo test unit nho kiem chung sort duoc chuyen vao fetcher va cursor bi reset khi doi sort.
3. STRICT: Offline only, khong dung DB/Redis window, khong commit/push.
4. Ghi receipt Muc 16 vao coordination/reports/qwen-admin.md.
'@

# 2. Dispatch qwen_cost: W-COST05-SERVICE-RECON-1
$costPrompt = @'
[PACKET W-COST05-SERVICE-RECON-1] Qwen-Cost (Tich hop Contracts Reconciliation & Budget vao UsageService).
Doc du-rework/AGENTS.md, coordination/reports/qwen-cost.md Muc 4, va services/orchestrator/src/modules/usage/usage.ts:
Boi canh:
Trong cac cycle 1-4, ban da hoan tat 100% contracts offline (usage-metrics, pricing, usage-reconciliation, usage-budget) voi BigInt floor math va zero-drift. Bay gio la luc tich hop cac contracts nay vao UsageService cua Orchestrator.

Nhiem vu:
1. File: services/orchestrator/src/modules/usage/usage.ts:
   - Su dung cac ham tu @du/contracts (aggregateUsageEvents, evaluateBudgetStatus, calculateTieredCost) trong phuong thuc getUsageSummary hoac ham ho tro.
   - Dam bao khong gay loi kieu (type-safe) voi schema hien tai cua DB payload.
2. Kiem thu:
   - pnpm --filter @du/contracts test exit 0 (385/385 tests).
   - pnpm --filter @du/orchestrator test -- tests/usage-summary.test.ts (hoac cac tests lien quan den usage).
   - pnpm --filter @du/orchestrator exec tsc --noEmit exit 0.
3. STRICT: Offline only, khong dung DB/Redis window, khong commit/push.
4. Ghi receipt Muc 5 vao coordination/reports/qwen-cost.md.
'@

# 3. Dispatch qwen_docs: D-EVID-A24
$docsPrompt = @'
[PACKET D-EVID-A24] Qwen-Docs (Dong bo ket qua T-CODEX-TEST-31, T130-A1 CLOSED va W-ADMUX02-SORT vao Baseline).
Doc du-rework/AGENTS.md, coordination/reports/tester.md (T-CODEX-TEST-31), review.md (Turn 150 audit), va qwen-admin.md Muc 15:
Boi canh:
Turn 150-153 da ghi nhan cac moc rat quan trong:
1. T130-A1 da chinh thuc CLOSED boi Reviewer Turn 150.
2. T-CODEX-TEST-31 da dat 7/7 PASSED live ExitCode 0 tren admin-base-routes.test.ts (tong bo 3 live suites: 30/30 passed).
3. W-ADMUX02-SORT-CURSOR-BIND-1 da hoan thanh voi 54 unit tests pass (giai quyet T140-A1).

Nhiem vu:
1. Cap nhat cac file tai lieu:
   - docs/28-test-inventory.md: bo sung muc 8.20 ghi nhan T-CODEX-TEST-31 (7/7 live pass), dong toan bo Admin base routes live gate, va 54 tests cua sort-cursor binding.
   - docs/35-acceptance-baseline.md: cap nhat muc 12.23 ghi nhan T130-A1 da CLOSED, cap nhat trang thai cua ADM-UX-02 va bang chung live.
   - docs/19-traceability-audit-matrix.md: cap nhat ma tran theo doi Turn 150-153.
2. Bump Document Version len 1.31.0.
3. Chay link check S0 va S1 dam bao BROKEN=0.
4. STRICT: Offline only, khong commit/push.
5. Ghi receipt Muc 17 vao coordination/reports/qwen-docs.md.
'@

Write-Host "Dispatching Wave 5 to Qwen-Admin, Qwen-Cost, Qwen-Docs..."
& $orcaCli terminal send --terminal term_bf93d438-9974-4c4e-88a8-90e6ea80d37c --text $adminPrompt --enter --json
Write-Host "Dispatched W-ADMUX03-SHELL-SORT-1 to Qwen-Admin."

& $orcaCli terminal send --terminal term_4ed1695f-9152-40af-b6f2-2c3d984f0e43 --text $costPrompt --enter --json
Write-Host "Dispatched W-COST05-SERVICE-RECON-1 to Qwen-Cost."

& $orcaCli terminal send --terminal term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e --text $docsPrompt --enter --json
Write-Host "Dispatched D-EVID-A24 to Qwen-Docs."
