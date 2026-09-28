# Dispatch Turn 1 packets to all worker agents
$ErrorActionPreference = 'Stop'
$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$stateFile = 'D:\Git\dugate\du-rework\coordination\coordinator-state.json'
$state = Get-Content $stateFile -Raw | ConvertFrom-Json

function Send-Packet([string]$role, [string]$handle, [string]$prompt) {
  Write-Host ">>> Dispatching to $role ($handle)..."
  try {
    $resText = & $orcaCli terminal send --terminal $handle --text $prompt --enter --wait-submit 5 --json 2>$null
    if ($LASTEXITCODE -eq 0 -and $resText) {
      $res = $resText | ConvertFrom-Json
      if ($res.ok -and $res.result.send.accepted) {
        Write-Host "  [OK] Prompt accepted. RequestId: $($res.result.send.prompt.requestId)"
        return @{ Role = $role; Handle = $handle; Status = "DISPATCHED"; RequestId = $res.result.send.prompt.requestId }
      } else {
        Write-Host "  [WARN] Not accepted: $($res.error.code)"
        return @{ Role = $role; Handle = $handle; Status = "NOT_ACCEPTED"; Error = $res.error.code }
      }
    } else {
      Write-Host "  [FAIL] Orca send command failed"
      return @{ Role = $role; Handle = $handle; Status = "COMMAND_FAILED" }
    }
  } catch {
    Write-Host "  [ERROR] $($_.Exception.Message)"
    return @{ Role = $role; Handle = $handle; Status = "ERROR"; Error = $_.Exception.Message }
  }
}

$dispatches = @()

# 1. Qwen-Docs
$promptDocs = @"
[PACKET D-EVID-A7] Chuyên trách Tài liệu & Evidence (Qwen-Docs).
Đọc du-rework/AGENTS.md.
Nhiệm vụ:
1. Đồng bộ docs/28-test-inventory.md và docs/35-acceptance-baseline.md với các bằng chứng mới nhất:
   - codex6.md Cycle 140 (W-VAULT04-FIX1): 3 aggregate offline runs 55 suites / 1286 tests PASS ExitCode 0.
   - codex-lint-probe.md (D-LINT-ORCH-1): pnpm --filter @du/orchestrator lint PASS ExitCode 0.
   - tester-antigravity.md (T-DATA-LIVE-4): 5/5 exit 0 x2 trên MinIO S3 pilot.
2. Chạy offline local markdown link/anchor check.
3. Không sửa source sản phẩm, không chạy test, không đụng DB. Báo cáo vào coordination/reports/qwen-docs.md.
"@
$dispatches += Send-Packet "Qwen-Docs" $state.roster.qwen_docs.handle $promptDocs

# 2. Tester (Codex)
$promptTester = @"
[PACKET T-CODEX-TEST-1] Dedicated Tester (Codex).
Đọc du-rework/AGENTS.md.
Nhiệm vụ kiểm thử độc lập offline cho Connector & Contracts:
1. pnpm --filter @du/contracts build
2. pnpm --filter @du/connector typecheck
3. pnpm --filter @du/connector test -- tests/vault-account-isolation.test.ts tests/secret-resolver.test.ts
Yêu cầu: Không sửa source code sản phẩm. Ghi lại literal ExitCode, số lượng test passed/failed/skipped vào coordination/reports/tester.md.
"@
$dispatches += Send-Packet "Tester" $state.roster.tester.handle $promptTester

# 3. Codex-Security
$promptSec = @"
[PACKET W-VAULT01-BIND-1] Security / Vault Implementer (Codex-Security).
Đọc du-rework/AGENTS.md và tasks/SEC-OIDC-VAULT-2026-09-24.md (VAULT-01).
Nhiệm vụ:
Kiểm tra services/connector/src/db/repository.ts và contracts. Đảm bảo Connector revision storage có độc lập trusted columns/binding (tenant_id, connector_id, account_id) thay vì chỉ kiểm tra chuỗi path trong credential_source.
Viết / cập nhật negative unit tests đảm bảo foreign account bị từ chối trước Vault I/O.
Chỉ sửa trong services/connector/, không commit/push. Báo cáo vào coordination/reports/codex6.md.
"@
$dispatches += Send-Packet "Codex-Security" $state.roster.codex_security.handle $promptSec

# 4. Qwen-DATA
$promptData = @"
[PACKET W-DATA02-PUB-2] DATA Implementer (Qwen-DATA).
Đọc du-rework/AGENTS.md và tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md (DATA-02).
Nhiệm vụ:
1. Rà soát public multipart upload routes trong services/orchestrator/src/server.ts và modules/artifacts/.
2. Đảm bảo nhánh public upload (/api/v1/uploads):
   - Yêu cầu kiểm tra submit guard: chỉ hoàn tất khi trạng thái là READY, từ chối STAGING.
   - Gắn kết sweeper định kỳ dọn dẹp các part/staging quá hạn.
3. Chạy kiểm tra offline: pnpm --filter @du/orchestrator test -- tests/multipart-routes-offline.test.ts tests/multipart-service-offline.test.ts.
Chỉ sửa trong services/orchestrator/src/modules/artifacts/ và server.ts. Báo cáo vào coordination/reports/qwen-data.md.
"@
$dispatches += Send-Packet "Qwen-DATA" $state.roster.qwen_data.handle $promptData

# 5. Qwen-SEC
$promptOidc = @"
[PACKET W-OIDC02-REPLICA-1] SEC / OIDC Implementer (Qwen-SEC).
Đọc du-rework/AGENTS.md và tasks/SEC-OIDC-VAULT-2026-09-24.md (OIDC-02).
Nhiệm vụ:
1. Xem xét services/orchestrator/tests/oidc02-process-replicas-offline.test.ts.
2. Bổ sung các kịch bản kiểm thử offline cho việc thu hồi phiên (revoke) và khởi động lại tiến trình (restart/expiry) giữa các replica.
3. Chạy typecheck và unit test: pnpm --filter @du/orchestrator test -- tests/oidc02-process-replicas-offline.test.ts tests/session-store.test.ts.
Chỉ sửa trong services/orchestrator/src/modules/auth/ và tests liên quan. Báo cáo vào coordination/reports/qwen-sec.md.
"@
$dispatches += Send-Packet "Qwen-SEC" $state.roster.qwen_sec.handle $promptOidc

# 6. Qwen-Admin
$promptAdmin = @"
[PACKET W-ADMUX-01] Admin Ops UI Implementer (Qwen-Admin).
Đọc du-rework/AGENTS.md và tasks/ADMIN-OPS-UX-2026-09-24.md (ADM-UX-00, ADM-UX-01).
Nhiệm vụ:
1. Rà soát apps/admin/ (hoặc các component Admin dashboard/view-models).
2. Xây dựng nền tảng responsive layout, điều khiển phân trang server-side cho danh sách operations/tasks.
3. Chạy lint/typecheck cho apps/admin.
Chỉ sửa trong apps/admin/. Báo cáo vào coordination/reports/qwen-admin.md.
"@
$dispatches += Send-Packet "Qwen-Admin" $state.roster.qwen_admin.handle $promptAdmin

Write-Host "========================================="
Write-Host "Dispatch complete. Dispatched: $($dispatches.Count) packets."
