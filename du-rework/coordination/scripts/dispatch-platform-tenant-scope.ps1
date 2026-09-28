$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-ADMIN-APIKEY-TENANT-SCOPE-1] Qwen-Platform (Sua test 5 trong admin-base-routes.test.ts de truyen tenantId query parameter).
Doc du-rework/AGENTS.md, qwen-platform.md, va ket qua live Tester T-CODEX-TEST-30:
Boi canh finding:
Trong T-CODEX-TEST-30:
- admin-action-rbac-live.test.ts: 12/12 PASS LIVE (ExitCode 0).
- admin-audit.test.ts: 11/11 PASS LIVE (ExitCode 0).
- admin-base-routes.test.ts: 6/7 passed. Fail duy nhat o test 5: `foundKey` is undefined.
Nguyen nhan:
Trong server.ts:1926:
`const scope = authorizeAuditTenantRead(keysPrincipal, query.tenantId ?? '');`
`if (scope === '') return { status: 200, body: await buildApiKeyPage(ctx, keysPrincipal, [], query) };`
Khi goi `GET /api/v1/admin/api-keys` khong co query parameter `?tenantId=...`, server tra ve page rong voi `items: []`.
Chi khi co `?tenantId=${TEST_TENANT}` thi server moi tra ve cac key cua tenant do!

Nhiem vu:
1. File: services/orchestrator/tests/admin-base-routes.test.ts (test 5, dong 213-228):
   - Goi `const resList = await fetch(`${baseUrl}/api/v1/admin/api-keys?tenantId=${TEST_TENANT}`, { headers: adminHeaders() });`
   - Kiem tra foundKey se tim thay TEST_KEY_ID.
   - (Tuy chon): Kiem tra them mot request khong co tenantId `fetch(`${baseUrl}/api/v1/admin/api-keys`, ...)` de xac nhan tra ve empty items: `expect(emptyBody.items ?? []).toEqual([])`.
2. Kiem thu offline:
   - pnpm --filter @du/orchestrator exec tsc --noEmit exit 0.
   - pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts exit 0.
   - Negative control: doi tenantId thanh mot tenant khong khop de xac nhan fail hoac doi expectation roi restore byte-exact.
3. STRICT: Offline only, khong sua code san pham trong server.ts, khong dung DB window, khong commit/push.
4. Ghi receipt Muc 7 vao coordination/reports/qwen-platform.md.
"@

& $orcaCli terminal send --terminal term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33 --text $prompt --enter --json
Write-Host "Dispatched W-ADMIN-APIKEY-TENANT-SCOPE-1 to Qwen-Platform."
