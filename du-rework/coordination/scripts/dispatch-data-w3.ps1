$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-DATA04-STREAM-1] Qwen-DATA (Artifact Streaming & Small-File Bounds).
Doc du-rework/AGENTS.md, tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md (DATA-04), va Reviewer finding T20-D1 trong coordination/reports/review.md.
Nhiem vu: Hoan thien streaming bounds va thu hep khoang trong tap tin 1 MiB - 64 MiB:
1. File can sua:
   businesses/document-core/src/pipelines/parser-budget.ts
   packages/worker-sdk/src/artifact-multipart.ts (hoac artifact-streams.ts)
2. Yeu cau:
   - Xu ly streaming doc/ghi artifact co gioi han RSS, khong buffer toan bo file vao bo nho truoc khi parse.
   - Ho tro co che binary streaming cho cac file nho va vua (1 MiB - 64 MiB) ngoai multipart de dong khoang trong ma Reviewer da neu trong T20-D1.
   - Ap dung quiet-band ports de tranh ETIMEDOUT / flake tren Windows.
3. Kiem thu:
   - Chay unit tests trong businesses/document-core va packages/worker-sdk.
   - pnpm --filter @du/worker-sdk test:unit (hoac test)
   - pnpm --filter @du/worker-sdk lint (tsc --noEmit) exit 0
4. STRICT: Offline only. Khong dung DB window, khong commit/push.
5. Ghi receipt va ledger vao du-rework/coordination/reports/qwen-data.md.
"@

& $orcaCli terminal send --terminal term_6df22fa3-e399-4e31-9400-364917d9bdc8 --text $prompt --enter --json
Write-Host "Dispatched W-DATA04-STREAM-1 to Qwen-DATA."
