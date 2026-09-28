$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET D-EVID-A11] Qwen-Docs (Evidence Inventory & Reviewer Sync).
Doc du-rework/AGENTS.md, docs/28-test-inventory.md, docs/35-acceptance-baseline.md, va Turn 20 Reviewer audit trong coordination/reports/review.md.
Nhiem vu: Cap nhat inventory voi cac bang chung thuc te moi nhat va ghi nhan qualification cua Reviewer:
1. File can sua:
   du-rework/docs/28-test-inventory.md
   du-rework/docs/35-acceptance-baseline.md
2. Noi dung:
   - Cap nhat T-ANTIG-2: Full Connector offline package (19 suites passed, 2 live-gated skipped suites; 219 tests passed, 7 skipped, ExitCode 0) tu coordination/reports/tester-antigravity.md.
   - Cap nhat T-CODEX-TEST-2: Full Orchestrator aggregate suite (57 suites passed, 1342 passed, 15 skipped, ExitCode 0) va Contracts vault-ref (59 passed) tu coordination/reports/tester.md.
   - Ghi nhan qualification tu Reviewer Turn 20 (T20-V1): VAULT-01 writer path can trusted tenant/account origin tu principal, chua dong gate acceptance.
   - Khong chèn dong trong lam dut gay bang markdown.
3. Kiem thu:
   - Chay link check script kiem tra markdown links, dam bao BROKEN=0.
4. STRICT: Chi sua 2 file docs tren va bao cao receipt vao du-rework/coordination/reports/qwen-docs.md. Khong commit/push.
"@

& $orcaCli terminal send --terminal term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e --text $prompt --enter --json
Write-Host "Dispatched D-EVID-A11 to Qwen-Docs."
