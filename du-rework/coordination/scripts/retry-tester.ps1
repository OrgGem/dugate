$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$testerPacket = @"
Tiếp tục thực hiện [PACKET T-CODEX-TEST-2]:
Hãy tự động chạy lần lượt 3 lệnh kiểm thử offline sau trong PowerShell mà không cần hỏi xác nhận:
1. pnpm --filter @du/contracts test -- --runTestsByPath tests/vault-ref.test.ts
2. pnpm --filter @du/connector test:unit --runTestsByPath tests/revision-binding.db.test.ts tests/revision-binding.schema.test.ts tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts
3. Tại thư mục D:\Git\dugate\du-rework\services\orchestrator chạy:
   npx jest --runInBand --config jest.unit.config.cjs
Lưu raw logs vào coordination/reports/T-CODEX-TEST-2-*.log và ghi receipt đầy đủ vào coordination/reports/tester.md. Không commit hay push.
"@

& $orcaCli terminal send --terminal term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5 --text $testerPacket --enter --retry-request 6354e4c3-da58-44c7-b4a5-253058cfa2e0 --wait-submit 10 --json
