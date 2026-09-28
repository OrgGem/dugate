$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = "Chay offline test suite T-CODEX-TEST-2: npx jest --runInBand --config jest.unit.config.cjs trong services/orchestrator va pnpm --filter @du/contracts test -- --runTestsByPath tests/vault-ref.test.ts. Luu log vao coordination/reports/T-CODEX-TEST-2-*.log va ghi receipt vao coordination/reports/tester.md. Khong commit push."

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $prompt --enter --json
