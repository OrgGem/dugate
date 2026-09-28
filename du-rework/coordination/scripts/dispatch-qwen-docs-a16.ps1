$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET D-EVID-A16] Qwen-Docs (Evidence Ledger Sync for T-CODEX-TEST-21, 22, 23).
Doc du-rework/AGENTS.md, du-rework/docs/28-test-inventory.md, va du-rework/docs/35-acceptance-baseline.md.
Nhiem vu:
1. Cap nhat docs/28 va docs/35 voi 3 receipt song moi nhat tu tester.md:
   - T-CODEX-TEST-21: Live S3 MinIO DATA-02/04 pilot verification (5/5 x2 pass, PG:5433, Redis:6380, S3:9003).
   - T-CODEX-TEST-22: Admin browser harness Playwright matrix (82/82 pass, 158 axe-scans 0 critical/serious).
   - T-CODEX-TEST-23: Admin keyset query-plan multi-tenant live verification (6/6 pass, Index Scan verified, dong Delta23).
2. Nang Document Version len 1.25.0, header A5 -> A16.
3. Kiem tra line-ending CRLF va repoint anchors neu can.
4. Chay link check dam bao BROKEN=0.
5. Quy tac: docs-only, KHONG sua source/test, KHONG tick task row, KHONG commit/push git.
6. Ghi receipt vao coordination/reports/qwen-docs.md.
"@

& $orcaCli terminal send --terminal term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e --text $prompt --enter --json
Write-Host "Dispatched D-EVID-A16 to Qwen-Docs."
