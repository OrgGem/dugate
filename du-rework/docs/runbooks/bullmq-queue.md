# Runbook: BullMQ queue và worker

**Trạng thái:** draft; recovery cần rehearsal với đúng bản deploy, BullMQ/Redis và business version. Xem [dashboard/alerts](../ops/p8-07-dashboards-alerts.md).

**Redis HA boundary:** Orchestrator, Connector, and Worker SDK consume a single
`REDIS_URL`; the local Compose fixture has one Redis 7 service and no Sentinel.
If production selects Redis Sentinel, client discovery/auth/TLS options and
failover behavior must be implemented and rehearsed across all three consumers
before this runbook can be used for that topology. A managed Redis service's
stable endpoint is a separate supported configuration choice only after its
failover and reconnect evidence is recorded. Do not infer Sentinel health from
the application Redis `PING`.

## Khi dùng

Queue age tăng, waiting/delayed jobs tích tụ, không có worker cho queue/version, stalled jobs tăng, task lease hết hạn không được khôi phục, hoặc health báo DB/Redis degraded.

## Triage

1. **Xác nhận tín hiệu:** xem timestamp cập nhật dashboard, queue age, waiting/active/delayed/failed/stalled, enqueue/completion rate và release vừa triển khai. Nếu telemetry stale, xử lý monitoring trước khi suy luận queue rỗng.
2. **Kiểm tra dependency:** gọi Orchestrator `GET /api/v1/health`; xác nhận `db` và `redis`. Kiểm tra worker/container health, Connector `/health/ready` khi task chờ provider. Health endpoint hiện không cho biết queue có worker tương thích hay không.
3. **Kiểm tra queue mapping:** xác định business ID/version của operation. Task được ghim vào version; so với queue khai báo ở `business_versions.queue`, digest/release worker đang chạy và số worker ready cho chính queue đó. Worker khỏe nhưng nghe queue/version khác không xử lý được backlog này.
4. **Đối chiếu task và lease bằng log/UI hoặc DB read role:** dùng `task_id`, `operation_id`, business/version, `state`, `attempt`, `lease_epoch`, `lease_expires_at`, `leased_by`, `updated_at`. Chỉ đọc; không select/đưa `payload_ref` hoặc input file vào ticket.
5. **Tìm nguyên nhân:** phân biệt Redis/DB outage, thiếu worker hoặc sai queue name/version, crash/OOM, provider 429/timeout, parser/event-loop bị block, hết quota, và lô job poison lặp. Xem error code, tương quan thời gian restart, lease expiry và provider health.

## Khôi phục an toàn

- **Không có worker tương thích:** khôi phục hoặc scale đúng worker image/version qua release tooling đã duyệt. Không chuyển job sang queue của version khác; operation đang chạy vẫn gắn business version đã chọn lúc submit.
- **Worker vừa rollout gây backlog/lỗi lặp:** dừng rollout/scale-in theo deployment playbook. Rollback chỉ về image tương thích schema/manifest; giữ bản worker cũ cho version còn in-flight. Không xóa hay đổi job ID để “làm sạch”.
- **Redis không khỏe:** dừng tăng tải theo admission-control đã duyệt nếu cần; khôi phục Redis/ACL/persistence. Sau khi Redis trở lại, để DB outbox/scheduler và lease recovery khôi phục giao nhận. Không chạy `FLUSHDB`, `DEL bull:*`, hoặc tự nạp lại mọi task.
- **Lease hết hạn hoặc 409 `LEASE_LOST`:** đây có thể là fence hoạt động bình thường sau worker chậm/chết. Để lease recovery và delivery có kiểm soát xử lý lại; điều tra event-loop/CPU/RSS nếu số tăng. Không tự sửa `lease_epoch`, `lease_expires_at` hoặc `leased_by` trong SQL.
- **Provider/quota bị giới hạn:** theo dõi [UNKNOWN runbook](unknown-reconciliation.md) và connector quota. Giảm admission/dispatch qua cơ chế đã duyệt; không tăng retry/concurrency để đẩy backlog qua quota.

## Kiểm tra hồi phục

Xác nhận queue age và số task ready giảm; completion throughput trở lại; lease quá hạn không tích lũy; task được claim bằng epoch mới và thao tác từ worker cũ bị từ chối; operation đi tới trạng thái hợp lệ; không phát sinh provider invocation/billing trùng. Ghi queue/version và thời gian đạt lại budget.

## Escalation

Page Platform nếu DB/Redis readiness fail, outbox không dispatch hoặc lease recovery ngừng. Page owner business/runtime nếu chỉ một queue/version lỗi. Page Connector nếu backlog chờ provider, 429 hoặc UNKNOWN tăng. Source mapping: `../../services/orchestrator/src/modules/queue/dispatcher.ts`, `../../services/orchestrator/src/modules/runtime/runtime.ts`.
