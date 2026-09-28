$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-DATA03-ACQ-1] Qwen-DATA (URL Bounded Acquisition Worker Flow).
Doc du-rework/AGENTS.md va tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md muc DATA-03.
Nhiem vu:
1. Pham vi sua: worker-sdk / document-core URL acquisition flow (packages/worker-sdk, businesses/document-core/src/acquisition hoac tuong duong).
2. Yeu cau:
   - 202 URL submission tao ingestion task; business task chi duoc danh dau runnable khi source artifact trang thai READY.
   - Luong download HTTPS URL fixture co bound timeout/byte limits, chan private IP/link-local/metadata/redirect/rebinding (SSRF protection).
   - Tich hop upload stream vao private S3 storage (hoac S3 mock fixture offline), SHA-256 va byte count pin bat bien.
   - Retry download khong lam thay doi SHA-256 da pin. Failed acquisition khong tao READY hay parse bytes do.
3. Kiem thu:
   - Chay unit/contract tests offline: pnpm --filter @du/worker-sdk test, pnpm --filter @du/document-core test.
   - TypeScript compile check: pnpm --filter @du/worker-sdk typecheck (hoac tsc --noEmit).
4. Quy tac: KHONG dung DB/Redis window live (offline unit/fixture only), KHONG commit/push git.
5. Ghi receipt vao coordination/reports/qwen-data.md (nhat ky, lenh, exit code, tests pass).
"@

& $orcaCli terminal send --terminal term_6df22fa3-e399-4e31-9400-364917d9bdc8 --text $prompt --enter --json
Write-Host "Dispatched W-DATA03-ACQ-1 to Qwen-DATA."
