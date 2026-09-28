$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-ADMUX02-SRV-1] Qwen-Admin (Server List API & Pagination).
Doc du-rework/AGENTS.md, tasks/ADMIN-OPS-UX-2026-09-24.md (ADM-UX-02), va Reviewer finding T20-A1 trong coordination/reports/review.md.
Nhiem vu: Hoan thien server-side query & cursor contract cho GET /api/v1/operations trong Orchestrator:
1. File can sua:
   services/orchestrator/src/server.ts (dong 1176-1207)
   services/orchestrator/src/app/admin/operation-section-data.ts
2. Yeu cau:
   - Trong server.ts tai GET /api/v1/operations: ho tro cac query params: state, tenant, cursor, limit (mac dinh 20, toi da 100).
   - Thay vi tra ve total = rows.length va nextCursor: null, hay tinh toan nextCursor on dinh (id-based hoac timestamp-based) va tra ve dung shape { items, nextCursor, total }.
   - Khong cho phep query injection, sanitize cac tham so allowlist.
   - Ket noi UI fetcher trong operation-section-data.ts de truyen cac filter nay len server.
3. Kiem thu:
   - Them test cases offline vao tests/admin-operations-list-pagination.test.ts.
   - tsc --noEmit exit 0.
   - Jest targeted suites pass x3 exit 0.
4. STRICT: Offline only. Khong dung DB window, khong commit/push.
5. Ghi receipt va ledger vao du-rework/coordination/reports/qwen-admin.md.
"@

& $orcaCli terminal send --terminal term_bf93d438-9974-4c4e-88a8-90e6ea80d37c --text $prompt --enter --json
Write-Host "Dispatched W-ADMUX02-SRV-1 to Qwen-Admin."
