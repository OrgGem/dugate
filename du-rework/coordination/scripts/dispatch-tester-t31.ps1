$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET T-CODEX-TEST-31] Dedicated Tester (Live DB Window Re-validation for admin-base-routes.test.ts 7/7).
Doc du-rework/AGENTS.md Section 5, tester.md (T-CODEX-TEST-30), va qwen-platform.md Muc 7 (W-ADMIN-APIKEY-TENANT-SCOPE-1):
Boi canh:
Qwen-Platform da hoan tat W-ADMIN-APIKEY-TENANT-SCOPE-1: cap nhat test 5 trong admin-base-routes.test.ts de truyen ?tenantId=`${TEST_TENANT}` (dong thoi assert probe khong co tenantId tra ve empty items).
Cac test da pass compile va ts-jest offline.

Nhiem vu:
1. CLAIM DB WINDOW:
   - Target PostgreSQL 127.0.0.1:5433/du_orchestrator_test va Redis 127.0.0.1:6380.
   - Ghi ro CLAIM_DB_WINDOW timestamp.
2. Preflight migrations:
   - pnpm --filter @du/orchestrator run migrate
   - pnpm --filter @du/orchestrator run migrate:verify
3. Chay live suite (DU_LIVE_INFRA=1):
   - pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts (Muc tieu: 7/7 passed, ExitCode 0)
4. RELEASE DB WINDOW ngay sau khi hoan tat (ghi ro RELEASE_DB_WINDOW timestamp).
5. STRICT: Khong sua product source, khong commit/push.
6. Luu raw output vao coordination/reports/T-CODEX-TEST-31-live-base-routes.log va ghi receipt vao coordination/reports/tester.md.
"@

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $prompt --enter --json
Write-Host "Dispatched T-CODEX-TEST-31 to Dedicated Tester Codex."

# Also compress qwen_platform context
& $orcaCli terminal send --terminal term_40f7f60f-d12b-4c60-88e9-9fecd6a87f33 --text "/compress" --enter --json
Write-Host "Sent /compress to Qwen-Platform."
