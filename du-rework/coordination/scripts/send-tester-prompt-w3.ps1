$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = "Chay goi T-CODEX-TEST-3: Kiem thu doc lap SEC-00 role-action-tenant matrix va Worker-SDK acquisition: 1. pnpm --filter @du/orchestrator test -- tests/oidc03-role-action-tenant-offline.test.ts tests/admin-action-dispatcher.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/admin-audit-scope.test.ts 2. pnpm --filter @du/worker-sdk test -- tests/source-acquisition.test.ts Luu raw logs vao coordination/reports/T-CODEX-TEST-3-*.log va ghi receipt vao coordination/reports/tester.md. Offline only, khong DB window, khong commit push."

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $prompt --enter --json
Write-Host "Dispatched to Tester."
