$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-ADMIN-BASE-AUDIT-ALIGN-1] Qwen-Platform (Dong bo Audit Envelope o tests/admin-base-routes.test.ts, giai quyet dut diem Delta 12).
Doc du-rework/AGENTS.md, coordination/reports/qwen-platform.md Muc 4 (Delta 12):
Nhiem vu:
1. File can sua: services/orchestrator/tests/admin-base-routes.test.ts (dong 248-260, test 6)
2. Cap nhat test 6:
   - Thay the cast { tenantId: string; events: unknown[] } bang { items: Array<{ tenantId: string }>; nextCursor: string | null; prevCursor: string | null; total: number; limit: number }.
   - Assert Array.isArray(body.items) === true.
   - Assert moi item trong body.items deu co e.tenantId === TEST_TENANT.
   - Assert body.limit >= 1 va body.total >= 0.
3. Kiem thu:
   - pnpm --filter @du/orchestrator exec tsc --noEmit exit 0.
   - pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts exit 0.
   - Negative control: doi items thanh events de chung minh test bat loi compile hoac runtime, sau do restore byte-exact.
4. STRICT: Offline only, khong dung DB/Redis window, khong sua code san pham trong server.ts hay modules, khong commit/push.
5. Ghi receipt Muc 5 vao coordination/reports/qwen-platform.md.
"@

& $orcaCli terminal send --terminal term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33 --text $prompt --enter --json
Write-Host "Dispatched W-ADMIN-BASE-AUDIT-ALIGN-1 to Qwen-Platform."
