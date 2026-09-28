$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'

# 1. Dispatch qwen_platform: W-ADMIN-APIKEY-ALIGN-1
$platformPrompt = @"
[PACKET W-ADMIN-APIKEY-ALIGN-1] Qwen-Platform (Dong bo API-Key List Envelope o 2 file test: admin-base-routes.test.ts va admin-action-rbac-live.test.ts).
Doc du-rework/AGENTS.md, coordination/reports/qwen-platform.md, va ket qua live Tester T-CODEX-TEST-29:
Boi canh:
Trong T-CODEX-TEST-29, test 5 cua admin-base-routes.test.ts va test M4 cua admin-action-rbac-live.test.ts bi fail vi van expect `body.rows`. Nhung trong server.ts (buildApiKeyPage) da tra ve base = listPage({ items, nextCursor, prevCursor, total, limit }) voi property wire la `items`.

Nhiem vu:
1. File 1: services/orchestrator/tests/admin-base-routes.test.ts:
   - Tai test 5 (dong 216-225):
     Cap nhat bodyList cast de co ca `items` hoac `(list.body.items ?? list.body.rows)`.
     Gia tri kiem tra `expect(Array.isArray(keyItems)).toBe(true)` voi `keyItems = bodyList.items ?? bodyList.rows ?? []`.
     foundKey tim tu `keyItems`.
     Tai dong 235: `expect(bodyItem.items ?? bodyItem.rows).toHaveLength(1)`.
2. File 2: services/orchestrator/tests/admin-action-rbac-live.test.ts:
   - Tai cell M4 (dong 347):
     Sua `const rows = (list.body.items ?? list.body.rows) as { tenantId: string }[];`
3. Kiem thu offline:
   - pnpm --filter @du/orchestrator exec tsc --noEmit exit 0.
   - pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts exit 0.
   - pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts exit 0 (compile cleanly).
   - Negative control: doi items thanh mot field khong ton tai de xac nhan fail/type error roi restore byte-exact.
4. STRICT: Offline only, khong dung DB/Redis window, khong sua code san pham trong server.ts, khong commit/push.
5. Ghi receipt Muc 6 vao coordination/reports/qwen-platform.md.
"@

# 2. Dispatch qwen_admin: W-ADMUX02-SORT-CURSOR-BIND-1
$adminPrompt = @"
[PACKET W-ADMUX02-SORT-CURSOR-BIND-1] Qwen-Admin (Giai quyet Reviewer finding T140-A1: Bind sort param to keyset cursor for /api/v1/operations).
Doc du-rework/AGENTS.md, coordination/reports/review.md (finding T140-A1), va server.ts:
Boi canh finding T140-A1:
Reviewer audit Turn 140 phat hien: "Pagination cursor is not bound to chosen sort (a cursor from created_at can be replayed with deadline_at sort)". Keyset cursor hien tai chi ma hoa ts|id[|p] ma chua mang sort key hoac chua reject neu cursor duoc dung voi mot sort field khac.

Nhiem vu:
1. Trong services/orchestrator/src/server.ts:
   - Cap nhat encodeOperationsListCursor / decodeOperationsListCursor (hoac parseOperationsListQuery) sao cho cursor chua thong tin sort field / direction hoac cursor duoc validate tuong thich voi query `sort` dang yeu cau.
   - Neu cursor khong khop sort field/direction da chi dinh trong request, tra ve 400 hoac 422 Bad Request / INVALID_CURSOR (hoac co che invalidate cursor ro rang, tranh doc sai tap ban ghi keyset).
   - Bao dam backward compatibility cho cac cursor default (created_at:desc).
2. Kiem thu:
   - pnpm --filter @du/contracts test (385/385 tests pass exit 0).
   - pnpm --filter @du/orchestrator test (cac tests lien quan den operations listing).
   - Viet bo test rieng kiem chung T140-A1: replaying a created_at cursor against deadline_at sort must be rejected or invalid.
3. STRICT: Offline only, khong DB/Redis window, khong commit/push.
4. Ghi receipt Muc 15 vao coordination/reports/qwen-admin.md.
"@

# 3. Dispatch qwen_docs: D-EVID-A22
$docsPrompt = @"
[PACKET D-EVID-A22] Qwen-Docs (Giai quyet Reviewer finding T140-D1 & Dong bo Audit Turn 140 vao Documentation & OpenAPI).
Doc du-rework/AGENTS.md, coordination/reports/review.md (finding T140-D1), va coordination/reports/qwen-admin.md:
Boi canh finding T140-D1:
Reviewer Turn 140 ghi nhan tai lieu va OpenAPI chua dong bo tham so `sort` moi cua GET /api/v1/operations (created_at, updated_at, deadline_at kem asc/desc) va can cap nhat bang chung Turn 140 audit.

Nhiem vu:
1. Cap nhat cac file tai lieu:
   - docs/06-operations-api.md (hoac file tuong duong mo ta operations list API): mo ta day du query parameter `sort` voi 6 gia tri allowlist: created_at:asc, created_at:desc, updated_at:asc, updated_at:desc, deadline_at:asc, deadline_at:desc.
   - docs/19-audit-log-reference.md: cap nhat audit log va envelope 5 truong {items, nextCursor, prevCursor, total, limit}.
   - docs/20-openapi-spec.md (hoac schema tuong ung): them tham so `sort` vao GET /api/v1/operations.
   - docs/28-test-inventory.md va docs/35-acceptance-baseline.md: dong bo ket qua T-CODEX-TEST-29 (admin-audit pass 11/11 live) va Reviewer Turn 140 audit findings.
2. Bump Document Version len 1.30.0.
3. Chay link check S0 va S1 dam bao BROKEN=0.
4. STRICT: Offline only, khong commit/push.
5. Ghi receipt Muc 15 vao coordination/reports/qwen-docs.md.
"@

Write-Host "Dispatching packets to Qwen-Platform, Qwen-Admin, Qwen-Docs..."
& $orcaCli terminal send --terminal term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33 --text $platformPrompt --enter --json
Write-Host "Dispatched W-ADMIN-APIKEY-ALIGN-1 to Qwen-Platform."

& $orcaCli terminal send --terminal term_bf93d438-9974-4c4e-88a8-90e6ea80d37c --text $adminPrompt --enter --json
Write-Host "Dispatched W-ADMUX02-SORT-CURSOR-BIND-1 to Qwen-Admin."

& $orcaCli terminal send --terminal term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e --text $docsPrompt --enter --json
Write-Host "Dispatched D-EVID-A22 to Qwen-Docs."
