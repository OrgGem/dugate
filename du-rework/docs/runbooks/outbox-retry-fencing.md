# Runbook: Outbox retry và fencing

**Trạng thái:** draft; ba luồng bên dưới có semantics khác nhau. Chưa có manual replay chung đã được xác nhận. Xem [dashboard/alerts](../ops/p8-07-dashboards-alerts.md).

## Đầu tiên: xác định đúng outbox

| Luồng | Nơi lưu | Giao đến | Retry hiện tại |
|---|---|---|---|
| Task dispatch | Orchestrator `outbox` | BullMQ queue theo business/version | Row đến hạn được poll; `delivery_id` tạo job ID ổn định. Lỗi enqueue đặt `claim_until` 30 giây rồi thử lại; scheduler mặc định poll mỗi 2 giây. |
| Webhook | Orchestrator `webhook_deliveries` | Callback URL tenant | `PENDING` với exponential backoff; tối đa mặc định 5 attempts rồi `FAILED`. Callback thất bại không đổi terminal state của operation. |
| Usage | Connector `connector_usage_outbox` | Orchestrator usage ingest | `event_id` là idempotency key. Exponential backoff + jitter; mặc định sau 8 attempts defer 24 giờ và tiếp tục retry, không phải dead-letter terminal. |

Đừng chạy lệnh sửa một bảng dựa trên tên “outbox” mà chưa phân loại event. Task outbox dispatch khác webhook callback và usage/billing projection.

## Chẩn đoán chỉ đọc

Dashboard nên trình bày count/oldest age/retry/last success riêng từng luồng. Nếu DBA cần xác nhận trực tiếp, dùng DB read role, schema đúng migration, và không select `payload`, `destination_url`, headers hay token.

Ví dụ task outbox:

```sql
SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND due_at <= now()) AS due_rows,
       max(now() - due_at) FILTER (WHERE dispatched_at IS NULL AND due_at <= now()) AS oldest_due_age,
       count(*) FILTER (WHERE dispatched_at IS NULL AND claim_until > now()) AS deferred_rows,
       max(attempts) FILTER (WHERE dispatched_at IS NULL) AS max_attempts
FROM outbox;
```

Để webhook và usage, xem `status`, `attempts`, `next_at`/`next_attempt_at`, `delivered_at` và tuổi oldest trong migration tương ứng. Lấy detail theo event/delivery ID có phân quyền; tránh dump row payload vào console/log.

## Task dispatch outbox bị trễ

1. Xác nhận DB khỏe, poller đang chạy và Redis nhận kết nối; so sánh tuổi `due_at` với BullMQ enqueue/worker progress.
2. Kiểm tra row có `dispatched_at IS NULL`, `due_at` đã đến hạn, task ID còn tồn tại và business/version vẫn có queue mapping. Nếu mapping thiếu, sửa registry/config bằng release đã duyệt.
3. Kiểm tra BullMQ có job với delivery ID tương ứng và worker tương thích đang nghe queue. `queue.add` dùng stable job ID để delivery lặp được deduplicate ở queue layer.
4. Nếu enqueue lỗi, source hiện defer 30 giây bằng `claim_until`; sửa dependency/config gốc và theo dõi scheduler tự retry. Không cập nhật `dispatched_at`, `claim_until`, `attempts` hoặc tự insert outbox row.
5. Xác nhận row được dispatch, task claim được và operation tiến triển. Nếu Redis đã nhận job nhưng DB transaction/ack không kết thúc rõ ràng, giữ ID để đối chiếu; job ID ổn định là dedup guard, không phải lý do tạo delivery mới.

## Webhook pending/failed

1. Xác nhận destination host, TLS/DNS, receiver status, signature/timestamp verification và SSRF/egress policy. Không mở rộng allowlist chỉ để làm hết alert.
2. Xem error class/status, attempts, next retry time và delivery ID. Destination URL là dữ liệu nhạy cảm; chỉ operator được phân quyền mới được xem.
3. Retry tự động khi còn budget. `FAILED` sau max attempts cần tenant/incident owner xác nhận endpoint ổn và quyết định redelivery qua cơ chế có audit.
4. Snapshot hiện không có manual redelivery route được xác nhận. Không đổi `FAILED` về `PENDING` hoặc reset attempts bằng SQL. Nếu chưa có API/tools được nghiệm thu, giữ state, mở escalation và theo dõi operation terminal state riêng.

## Usage outbox chưa ack

1. Kiểm tra Orchestrator usage ingestion, Connector usage dispatcher, identity/auth, DB connectivity và error rate của sink.
2. Cùng `event_id` có thể được gửi lại; sink phải deduplicate theo idempotency key. Không tạo ID mới hoặc xóa event để giảm backlog.
3. Sau 8 attempts theo mặc định, dispatcher defer khoảng 24 giờ rồi retry tiếp. Page nếu `USAGE_DELIVERY_BUDGET` sắp vi phạm; xác minh projection đã ingest event trước khi cân nhắc bất kỳ replay nào.

## Fencing và hoàn tất

Database row lock `FOR UPDATE SKIP LOCKED` bảo vệ claim của dispatcher trong transaction. Đây không phải lease fencing cho worker. Runtime dùng `tasks.lease_epoch` để từ chối stale worker; 409 `LEASE_LOST` phải được coi là kết quả fence, không lặp lại write bằng epoch cũ. Giữ task/outbox IDs trong audit; xác nhận backlog giảm, webhook/usage ack đúng và không có duplicate operation/provider effect trước khi resolve alert.

**Tham chiếu:** `../../orchestrator/services/orchestrator/src/modules/queue/dispatcher.ts`, `../../orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts`, `../../orchestrator/services/connector/src/db/usage-outbox.ts`, `../../orchestrator/services/connector/src/usage-dispatcher.ts`.
