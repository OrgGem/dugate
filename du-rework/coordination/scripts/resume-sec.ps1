$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
Thực hiện [PACKET W-VAULT01-ORCH-BIND-1]:
Tiếp tục đóng gate integration của VAULT-01 trong Orchestrator:
1. File cần sửa:
   services/orchestrator/src/modules/connector-credentials/connector-http-store.ts
   (hoặc workflow liên quan trong connector-credentials)
2. Nội dung:
   Truyền các trường binding độc lập (tenantId và accountId) khi Orchestrator tạo/yêu cầu Connector revision, đảm bảo không chỉ gửi mỗi credentialSource mà phải gửi cả tenant/account độc lập theo Migration 008 và contract matchesVaultAccountPath.
3. Kiểm thử offline:
   - pnpm --filter @du/contracts build
   - pnpm --filter @du/connector typecheck
   - pnpm --filter @du/orchestrator lint
   - pnpm --filter @du/orchestrator test -- tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/connector-revision-http-offline.functional.test.ts
4. STRICT: Offline only. Không đụng vào DB window, không gọi PostgreSQL :5433, Redis :6380 hay Vault thật.
5. Ghi raw logs và cập nhật receipt vào du-rework/coordination/reports/codex6.md. Không commit, không push.
"@

# Encode to a single-line or use a temporary file or pass directly
$cmd = "codex resume 01a0d97d-5633-7083-b328-6536dc778537 -a never `"$($prompt -replace '"', '\"' -replace "`r?`n", ' ')`""

& $orcaCli terminal send --terminal term_f190d102-3a5a-4827-a1bf-ea62dcbc720b --text $cmd --enter --json
Write-Host "Sent resume command to Codex-Security."
