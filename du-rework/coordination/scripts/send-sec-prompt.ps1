$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = "Chay goi W-VAULT01-ORCH-BIND-1: Cap nhat services/orchestrator/src/modules/connector-credentials/connector-http-store.ts truyen tenantId va accountId doc lap. Chay offline tests: pnpm --filter @du/contracts build, pnpm --filter @du/connector typecheck, pnpm --filter @du/orchestrator lint, va pnpm --filter @du/orchestrator test -- tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts. Ghi raw logs va cap nhat receipt vao coordination/reports/codex6.md. Khong commit push."

& $orcaCli terminal send --terminal term_f190d102-3a5a-4827-a1bf-ea62dcbc720b --text $prompt --enter --json
