$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET T-CODEX-TEST-29] Dedicated Tester (Live DB Window for T130-A1 & Delta 12 Re-validation).
Doc du-rework/AGENTS.md Section 5, review.md L809 (Turn 130 finding T130-A1), va qwen-platform.md Muc 4 & Muc 5.
Nhiem vu:
1. CLAIM DB WINDOW:
   - Target PostgreSQL 127.0.0.1:5433/du_orchestrator_test va Redis 127.0.0.1:6380.
   - Ghi CLAIM_DB_WINDOW timestamp ro rang.
2. Preflight migrations:
   - pnpm --filter @du/orchestrator run migrate
   - pnpm --filter @du/orchestrator run migrate:verify
3. Chay cac live suites (DU_LIVE_INFRA=1):
   - pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts
   - pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts
   - pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts
4. RELEASE DB WINDOW ngay sau khi chay xong (ghi ro RELEASE_DB_WINDOW timestamp).
5. STRICT: Khong sua product source, khong commit/push.
6. Luu raw output vao coordination/reports/T-CODEX-TEST-29-live-audit.log va ghi receipt vao coordination/reports/tester.md.
"@

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $prompt --enter --json
Write-Host "Dispatched T-CODEX-TEST-29 to Dedicated Tester Codex."
