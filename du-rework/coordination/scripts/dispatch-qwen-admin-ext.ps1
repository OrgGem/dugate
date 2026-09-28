$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-ADMUX02-EXT-1] Qwen-Admin (Remaining ADM-UX-02 API Query Contracts: Audit & API Keys).
Doc du-rework/AGENTS.md, tasks/ADMIN-OPS-UX-2026-09-24.md (ADM-UX-02), va Reviewer Turn 103 Resized Order.
Nhiem vu:
1. Pham vi sua: services/orchestrator/src/server.ts (hoac cac file view model / query tuong ung trong admin BFF).
2. Yeu cau:
   - Theo danh gia cua Reviewer: Operations list contract da duoc ACCEPTED theo W-ADMUX02-SRV-1. Phan con lai cua ADM-UX-02 can bo sung:
     (a) Audit list query: Chuan hoa reader tenant-scoped hien co (/api/v1/admin/audit) de ho tro limit, keyset/offset cursor, va tra ve envelope chuan {items, nextCursor, prevCursor, total, limit}.
     (b) API keys list query: Chuan hoa /api/v1/admin/api-keys de ho tro phan trang co limit/cursor (thay vi load all roi filter trong JS).
     (c) Dam bao tenant fencing, field allowlist loc an toan, khong dung raw secret/key lam search param.
3. Kiem thu:
   - Chay typecheck va admin view-model / router unit tests offline:
     npx tsc --noEmit
     pnpm --filter @du/orchestrator test -- tests/admin-audit-scope.test.ts tests/admin-api-key-view-model.test.ts
4. Quy tac: STRICT offline only. Khong mo DB window, khong commit/push git.
5. Ghi receipt vao coordination/reports/qwen-admin.md (Muc tieu, diff tom tat, command, exit code, tests pass).
"@

& $orcaCli terminal send --terminal term_bf93d438-9974-4c4e-88a8-90e6ea80d37c --text $prompt --enter --json
Write-Host "Dispatched W-ADMUX02-EXT-1 to Qwen-Admin."
