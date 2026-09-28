# P8-07 — Thiết kế dashboard và cảnh báo vận hành

**Trạng thái:** bản thiết kế, chưa phải cấu hình dashboard/alert đã triển khai hoặc nghiệm thu. Tài liệu này mô tả nhánh `du-rework`; không áp dụng cho runtime DUGate cũ.

## Trạng thái hiện tại và khoảng trống

Snapshot hiện có một số health probe nhưng chưa có dashboard/Prometheus exporter nối đầy đủ các chỉ số bên dưới:

| Nguồn | Hiện có | Giới hạn |
|---|---|---|
| Orchestrator `GET /api/v1/health` | `status`, `db`, `redis`, `activeLeases`, `queueIntegrity` | Không có queue age, outbox lag, storage probe hoặc provider outcome. `queueIntegrity: SUSPECT` cần được coi là degraded dù HTTP status là 200. |
| Connector `/health/live`, `/health/ready` | Liveness/readiness của process và dependencies được cấu hình | Không cho biết provider credential có được provider chấp nhận hay không. |
| Redis topology | Orchestrator, Connector và Worker SDK nhận một `REDIS_URL`; `infra/docker-compose.yml` chỉ có một Redis 7 service. | Không có Sentinel discovery/config/service trong source snapshot. Sentinel/managed-Redis failover health phải lấy từ telemetry của platform; app ping thành công không chứng minh quorum, leader election hoặc failover đã được diễn tập. |
| `@du/observability` metrics library | Có counter/gauge/histogram in-memory và quy tắc label bounded | Service snapshot chưa nối registry với scrape endpoint/dashboard; mới import logger ở service path. |
| BullMQ + PostgreSQL `outbox` | Durable dispatch row, BullMQ job có ID ổn định theo delivery | Chưa có bộ chỉ số/alert operator được cấu hình trong source snapshot. |
| `webhook_deliveries`, `connector_usage_outbox` | Retry state lưu trong PostgreSQL | Đây là hai luồng giao nhận riêng, không gộp vào task outbox. |
| `connector_invocations` | Ledger giữ `PENDING`, `UNKNOWN`, provider request ID và thời gian cập nhật | Chưa có API reconciliation thủ công đã được xác nhận. |
| `artifacts` + `artifact_blobs` + S3 | PostgreSQL giữ metadata/grants và mỗi artifact có `storage_backend` cùng generation pin; bytes thuộc PostgreSQL hoặc S3 versioned theo backend đã lưu. | Facade và cấu hình S3 đã có trong source; bucket/IAM/KMS, telemetry, backup/restore và failover vẫn cần xác minh theo môi trường. Health hiện không probe artifact I/O. |

`ARTIFACT_STORAGE_BACKEND` chọn write backend khi process khởi động (`postgres` mặc định hoặc `s3`); S3 yêu cầu bucket config. Với backend `s3`, `ARTIFACT_STORAGE_MIGRATION_WINDOW=true` bật dual-read cho bước DATA-05; nếu bỏ trống, source cũng giữ dual-read compatibility mặc định; chỉ đặt rõ `false` mới chuyển sang S3-only cutover và fail-closed khi legacy reference chưa được migrate. Đây không phải automatic failover. Compose test fixture hiện không cấu hình S3.

Health route hữu ích để phân biệt lỗi dependency nhưng không thay dashboard vận hành. Ngưỡng số tuyệt đối phải được chốt sau P8-05 benchmark và khi owner/SLO đã được chỉ định. Trước thời điểm đó, dùng các budget dưới đây làm cấu hình bắt buộc, chưa gán giá trị mặc định:

- `QUEUE_WAIT_BUDGET`: thời gian chờ queue tối đa theo SLO.
- `TASK_DISPATCH_BUDGET`: thời gian từ durable outbox đến nhận job trong BullMQ.
- `WEBHOOK_DELIVERY_BUDGET`, `USAGE_DELIVERY_BUDGET`: độ trễ giao nhận được chấp thuận cho từng luồng.
- `UNKNOWN_RECONCILE_BUDGET`: thời gian tối đa invocation được phép chưa có kết luận.
- `ARTIFACT_IO_BUDGET`: budget lỗi/độ trễ đọc, ghi và finalize artifact.

## Dashboard bắt buộc

| Dashboard | Panel tối thiểu | Drill-down an toàn |
|---|---|---|
| **Queue & workers** | waiting/delayed/active/failed/stalled; tuổi job waiting cũ nhất; enqueue và hoàn thành theo thời gian; worker readiness theo queue và business version; lease hết hạn và recovery; DB/Redis readiness | Từ queue/version sang `delivery_id`, `task_id`, `operation_id` trong log có phân quyền. Không đưa payload, file name hoặc tenant ID thành metric label. |
| **Outbox delivery** | Số row đến hạn và tuổi row cũ nhất tách riêng cho `outbox`, `webhook_deliveries`, `connector_usage_outbox`; retry/attempts; delivered rate; thời điểm dispatch thành công gần nhất | Liệt kê ID, state, attempts và timestamp; không hiển thị payload, destination URL đầy đủ, secret hoặc provider token. |
| **Provider outcomes** | `IN_FLIGHT`/`PENDING`/`SUCCEEDED`/`FAILED`/`UNKNOWN`; tuổi UNKNOWN; poll delay/attempts; provider timeout/429; quota utilization | Invocation ID, connector alias, operation/task/step, provider request ID trong vùng truy cập hạn chế. Không log request/result body hoặc credential. |
| **Artifacts** | Upload/read/finalize lỗi và latency; hash/size mismatch; `STAGING` age/bytes; READY reference bị thiếu bytes; backend health và capacity | Artifact ID, state, operation/task và hash metadata. Signed URL, grant token và bytes không được hiển thị. |
| **Credentials & security** | Credential-invalid/revoked/auth failure theo connector alias; thời điểm rotation gần nhất nếu có metadata an toàn; lỗi secret backend; rotation/revocation audit event | Connector ID và revision, actor, kết quả; tuyệt đối không hiển thị secret, encryption key, Vault token/path nhạy cảm hoặc request body. |

Giữ metric labels ở tập hữu hạn: `service`, `environment`, `queue_class`/business version đã đăng ký, `connector_alias`, `outcome`, `error_code`. Không dùng `operation_id`, `task_id`, `invocation_id`, `tenant_id`, URL hoặc credential làm label.

## Alert specification

Các điều kiện dưới đây cần được nối với on-call owner và runbook tương ứng. `for`/cửa sổ đánh giá phải lấy từ scrape interval và SLO đã duyệt; không coi tên budget là ngưỡng đã được cấu hình.

| Alert | Severity | Điều kiện kích hoạt | Runbook |
|---|---|---|---|
| `PlatformDependencyUnavailable` | Page / Critical | Orchestrator readiness báo DB hoặc Redis không khỏe trong nhiều lần scrape liên tiếp. | [Queue](../runbooks/bullmq-queue.md) |
| `RedisFailoverDegraded` (conditional) | Page / Critical | Với Sentinel hoặc managed HA đã chọn: telemetry của provider/Sentinel báo mất quorum/primary hoặc failover vượt recovery budget đã duyệt. Chỉ dùng sau khi topology và signal source được cấu hình, kiểm thử. | [Queue](../runbooks/bullmq-queue.md) |
| `QueueWaitingBeyondBudget` | Page / Critical | Tuổi job runnable vượt `QUEUE_WAIT_BUDGET` và backlog tiếp tục tăng; nâng severity khi không có worker tương thích healthy. | [Queue](../runbooks/bullmq-queue.md) |
| `TaskDispatchOutboxStalled` | Page / Critical | Row task outbox đến hạn quá `TASK_DISPATCH_BUDGET`, hoặc không có tiến triển dispatch trong khi backlog dương. | [Outbox](../runbooks/outbox-retry-fencing.md) |
| `WebhookDeliveryLag` | Warning / Page | Tuổi pending vượt `WEBHOOK_DELIVERY_BUDGET`; page khi delivery vào `FAILED`/hết retry hoặc thông báo nghiệp vụ quan trọng bị trễ quá SLA. | [Outbox](../runbooks/outbox-retry-fencing.md) |
| `WebhookMaxRetriesExceeded` | Page / Critical | Webhook delivery chuyển `FAILED` sau retry budget; operation terminal state không đổi, nhưng callback chưa được giao. | [Outbox](../runbooks/outbox-retry-fencing.md) |
| `WebhookEndpoint5xxRate` | Warning / Page | Tỷ lệ 5xx của callback vượt `WEBHOOK_5XX_BUDGET` trong cửa sổ đã duyệt. | [Outbox](../runbooks/outbox-retry-fencing.md) |
| `UsageOutboxLag` | Page / Critical | Tuổi usage event chưa ack vượt `USAGE_DELIVERY_BUDGET`; theo dõi riêng hàng chờ đã chạm retry budget và đang defer 24 giờ. | [Outbox](../runbooks/outbox-retry-fencing.md) |
| `ExpiredTaskLeaseNotRecovering` | Warning / Page | Số lease quá hạn hoặc tuổi lease lớn hơn recovery budget; page nếu stale completion/lease-lost tăng liên tục. | [Queue](../runbooks/bullmq-queue.md) |
| `ProviderInvocationUnknown` | Page / Critical | Có UNKNOWN vượt `UNKNOWN_RECONCILE_BUDGET`; mỗi invocation cần một ticket/owner, không retry tự động. | [UNKNOWN](../runbooks/unknown-reconciliation.md) |
| `ProviderRateLimitSpike` | Warning / Page | Provider 429/rate-limit tăng vượt budget; page nếu backlog hoặc operation SLA bị tác động. | [Queue](../runbooks/bullmq-queue.md) |
| `ArtifactBackendFailure` | Page / Critical | Read/write/finalize lỗi vượt `ARTIFACT_IO_BUDGET`, S3 request/error signal bất thường, hash/version sai, hoặc READY metadata không đọc được bytes. Nguồn phải có S3 telemetry riêng vì health route không probe storage. | [Storage](../runbooks/artifact-storage.md) |
| `CredentialRejectedAfterRotation` | Page / Critical | Provider trả auth failure sau lần rotate/revoke; giới hạn alert theo connector alias và revision. | [Credentials](../runbooks/credential-rotation.md) |
| `SecretMaterialLeakSuspected` | Security incident | Secret sentinel/token bị phát hiện trong response, log, trace, DB field không mã hóa, metric label hoặc URL. | [Credentials](../runbooks/credential-rotation.md) |

Mỗi alert cần có owner, escalation contact, dashboard link, môi trường, service/version đã deploy và thời điểm cập nhật runbook. Chỉ đóng alert sau khi metric đã trở về budget và backlog/ledger được đối chiếu; đừng chỉ đóng theo trạng thái process `healthy`.

## Nguồn đối chiếu trong repo

- Health và dispatcher: `../../services/orchestrator/src/server.ts`, `../../services/orchestrator/src/modules/queue/dispatcher.ts`.
- Outbox webhook/usage: `../../services/orchestrator/src/modules/webhooks/webhooks.ts`, `../../services/connector/src/db/usage-outbox.ts`, `../../services/connector/src/usage-dispatcher.ts`.
- UNKNOWN/credential: `../../services/connector/src/invoke.ts`, `../../services/connector/src/db/repository.ts`, `../../services/connector/src/services.ts`.
- Artifact backend/configuration: [`storage-facade.ts`](../../services/orchestrator/src/modules/artifacts/storage-facade.ts), [`main.ts`](../../services/orchestrator/src/main.ts), and [artifact storage runbook](../runbooks/artifact-storage.md). The broader [G-DATA plan](../../tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md) tracks environment rollout and operational evidence.
