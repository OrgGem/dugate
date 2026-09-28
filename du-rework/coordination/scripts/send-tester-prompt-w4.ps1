$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = "Chay goi T-CODEX-TEST-4: Kiem thu doc lap Document-Core streaming acquisition va package builds: 1. pnpm --filter @du/document-core test -- tests/parser-budgets.test.ts tests/read-stream-acquisition.test.ts 2. pnpm --filter @du/contracts build 3. pnpm --filter @du/connector typecheck Luu raw logs vao coordination/reports/T-CODEX-TEST-4-*.log va ghi receipt vao coordination/reports/tester.md. Offline only, khong DB window, khong commit push."

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $prompt --enter --json
Write-Host "Dispatched T-CODEX-TEST-4 to Tester."
