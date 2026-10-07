# Runbook: Credential rotation

**Trạng thái:** draft. OIDC/Vault rollout là gate riêng chưa hoàn thành. Chỉ operator có vai trò được phê duyệt mới thực hiện rotation trên environment thật.

## Phân loại credential trước khi thao tác

| Loại | Cách xử lý trong snapshot | Lưu ý |
|---|---|---|
| Provider credential | Connector mã hóa AES-256-GCM và lưu phiên bản trong `secret_versions`; `POST /connectors/{id}/credentials/rotate` thêm version mới cho `credentialRef`. | Endpoint nội bộ cần xác nhận identity/auth và kênh gửi secret. Đây không phải bằng chứng production Vault đã sẵn sàng. |
| `CONNECTOR_ENCRYPTION_KEY` | Base64 32-byte key được inject khi Connector khởi động; dùng để decrypt các version hiện có. | Chưa thấy key-versioned decrypt/reencryption migration trong snapshot. Đổi env đơn lẻ có thể làm credential cũ không giải mã được. |
| Invocation-grant signer, service/API/admin/OIDC/Vault credential | Rotation phụ thuộc issuer/consumer/IdP/secret backend và deployment sequence. | Không dùng provider-secret route thay thế; không rollout một phía nếu verifier/consumer chưa hỗ trợ overlap. |
| Tenant public API key | DB giữ hash/prefix/status, không plaintext. | Issue/dual-key/revoke cần admin flow được duyệt; đừng tự ghi DB. |

`SEC-OIDC-VAULT-2026-09-24.md` và `DEPLOY-STORAGE-LOGGING-2026-09-24.md` đang là plan. Không coi API/GUI mock hoặc kế hoạch Vault là capability đã triển khai.

## Provider secret — rotation theo giai đoạn

### Trước khi đổi

1. Mở change/incident record, ghi connector alias/ID, revision, credential ref, actor, ngày hết hạn/thu hồi và owner provider. Không ghi secret vào ticket/chat.
2. Xác nhận provider hỗ trợ old/new credential overlap và có thể thử một request an toàn, ít chi phí. Chọn rollback condition và thời gian overlap.
3. Xác nhận credential API được bảo vệ bằng Connector service identity, TLS/private route và secret delivery không lưu shell history, process args, CI logs, tracing hay HTTP dump. Nếu chưa xác nhận được, dừng và page Security/Connector.
4. Lấy secret mới trực tiếp từ secret manager/approved secure input; không echo/print. Soát trước để tránh gọi test bằng credential cũ.

### Đổi và xác minh

1. Ghi version/revision marker không nhạy cảm rồi gửi secret mới qua cơ chế được duyệt tới internal rotation endpoint. Source endpoint hiện là `POST /connectors/{id}/credentials/rotate`; không chạy `curl` với secret literal trên command line.
2. Xác nhận request thành công qua response/audit chỉ chứa connector ID, actor, thời gian và version metadata; response phải không echo secret.
3. Thực hiện canary provider invocation có kiểm soát, kiểm tra provider auth, response, quota và usage event. `ConnectorManagement.test()` trong snapshot chỉ kiểm tra connector/revision và adapter registry; không dùng kết quả đó một mình để chứng minh provider đã chấp nhận secret.
4. Khi canary đạt, xác nhận traffic mới dùng version hiện hành. Thu hồi secret cũ ở provider sau overlap đã duyệt; xác nhận success rate và auth failures ổn định, rồi đóng change.

### Rollback / emergency revoke

- Nếu canary thất bại, ngừng rollout và kiểm tra provider account, key scope, connector revision và timestamp. Nếu old key vẫn hoạt động, yêu cầu Connector owner xác định rollback có audit; code hiện chọn credential active mới nhất theo `rotated_at`, và chưa có API chọn version trước đó. Không sửa `secret_versions` thủ công.
- Nếu nghi lộ provider secret, revoke upstream ngay qua provider's approved control plane, đánh giá tenant/connector/in-flight calls và phát secret mới qua đường an toàn. Đừng chờ metric tự hồi phục.
- Nếu đã revoke credential đang dùng, invocation kế tiếp có thể bị chặn `CREDENTIAL_INVALID`; xử lý các invocation UNKNOWN theo [runbook riêng](unknown-reconciliation.md), không retry mù.

## Không rotate `CONNECTOR_ENCRYPTION_KEY` như provider secret

Đổi `CONNECTOR_ENCRYPTION_KEY` mà không có kế hoạch key-versioning/dual-read/reencryption và rollback có thể làm mất khả năng giải mã toàn bộ secret hiện lưu. Snapshot dùng một key lấy từ env và chưa chứng minh migration/rollback. Với rotation thường kỳ, dừng tại đây và mở task triển khai + diễn tập.

Với compromise khẩn cấp: Security incident commander phải xác định phạm vi lộ key, backup/DB exposure, thứ tự thay key/re-encrypt, cách xử lý bản ghi không thể decrypt, rollout replicas và revoke upstream provider secrets đã được bảo vệ bởi key đó. Không xoay env một phía rồi restart toàn bộ Connector.

## Kiểm tra đóng change

- Canary thành công trên build đang deploy; không tăng auth failure/UNKNOWN/429 ngoài budget.
- Provider xác nhận old key revoked, Connector dùng secret mới, usage/idempotency không bị nhân đôi.
- Audit chỉ có metadata cần thiết; sink scan không tìm thấy secret sentinel trong DB plaintext, queue, response, logs, traces, HTML hoặc metric labels.
- Change có người thực hiện/duyệt, thời gian, credential type/version marker, kết quả canary và rollback path; không đính kèm raw secret.

**Tham chiếu:** `../../orchestrator/services/connector/src/services.ts`, `../../orchestrator/services/connector/src/http/server.ts`, `../../orchestrator/services/connector/src/entrypoint.ts`, `../../orchestrator/services/connector/src/db/repository.ts`; plan `../../tasks/SEC-OIDC-VAULT-2026-09-24.md`.
