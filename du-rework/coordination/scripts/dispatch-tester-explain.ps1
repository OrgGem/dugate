$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET T-ADM-LIVE-EXPLAIN-1] Tester Codex (Admin Keyset Query-Plan Multi-Tenant Live Verification).
CWD: D:\Git\dugate\du-rework.
Nhiem vu:
1. CLAIM_DB_WINDOW tren PostgreSQL localhost:5433/du_orchestrator_test va Redis localhost:6380.
2. Chay dung 1 suite kiem thu live query-plan da tenant (Δ23 / Turn 103 Resized Order):
   `pnpm --filter @du/orchestrator test -- tests/admin-keyset-explain.test.ts`
   (voi moi truong DU_LIVE_INFRA=1).
3. Luu log tho ra `du-rework/coordination/reports/T-CODEX-TEST-23-keyset-explain-live.log`.
4. Ghi receipt vao `du-rework/coordination/reports/tester.md` (Muc T-CODEX-TEST-23, timestamp, CLAIM/RELEASE, exit code, so luong test pass, chi tiet query plan Index Scan vs Seq Scan).
5. RELEASE_DB_WINDOW ngay sau khi hoan tat. Khong sua source code, khong commit/push git.
"@

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $prompt --enter --json
Write-Host "Dispatched T-ADM-LIVE-EXPLAIN-1 to Tester."
