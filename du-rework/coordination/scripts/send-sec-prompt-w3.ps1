$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = "Thuc hien W-VAULT01-TRUST-ORIGIN-1: Giai quyet finding T20-V1 cua Reviewer Turn 20. Trong services/orchestrator/src/modules/admin-actions/dispatcher.ts va workflow.ts, resolve tenantId va accountId tu authenticated principal / connector ownership truoc khi writeCas, khong lay tu user input ref. Re-run offline tests: pnpm --filter @du/contracts build, pnpm --filter @du/connector typecheck, pnpm --filter @du/orchestrator lint, va pnpm --filter @du/orchestrator test -- tests/admin-actions-vault04-offline.functional.test.ts tests/connector-credentials-offline.functional.test.ts. Ghi raw logs va cap nhat receipt vao coordination/reports/codex6.md. Khong commit push."

& $orcaCli terminal send --terminal term_f190d102-3a5a-4827-a1bf-ea62dcbc720b --text $prompt --enter --json
Write-Host "Dispatched to Codex-Security."
