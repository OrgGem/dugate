# Runbooks vận hành P8-07

**Trạng thái:** bản nháp dựa trên source snapshot `du-rework`; chưa được diễn tập trên môi trường cô lập và chưa phải chấp thuận go-live. Đây không phải runbook cho DUGate cũ.

## Chọn runbook

- [P8-06 pre-release operations checklist and drills](../ops/p8-06-ops-checklist.md)
- [BullMQ queue và worker](bullmq-queue.md)
- [Outbox retry và fencing](outbox-retry-fencing.md)
- [Provider invocation `UNKNOWN`](unknown-reconciliation.md)
- [Artifact storage](artifact-storage.md)
- [DATA-02 / DATA-03 live public upload và URL ingestion pilot](data-02-public-uploads-live.md)
- [Credential rotation](credential-rotation.md)
- [Vault and OIDC operations](vault-oidc-operations.md)
- [Thiết kế dashboard/alerts](../ops/p8-07-dashboards-alerts.md)

## Quy tắc chung khi có sự cố

1. Ghi UTC start time, môi trường, release/image digest, alert, dashboard snapshot, correlation ID và resource ID cần thiết. Chỉ dùng identifier trong log có kiểm soát truy cập; không sao chép prompt, file bytes, request body, secret hoặc signed URL vào ticket/chat.
2. Xác nhận health và độ mới của telemetry trước khi hành động. Phân biệt backlog không đổi với metric scrape bị stale.
3. Chỉ thực hiện thay đổi qua API/automation đã được owner xác nhận, có audit và rollback. Các ví dụ SQL trong runbook nếu có đều chỉ đọc và phải chạy bằng DB read role trên schema đúng migration.
4. Không sửa/xóa row để ép state, không xóa/obliterate job BullMQ, không `FLUSHDB`, không tự bump/reset lease epoch/quota, không đánh dấu invocation thành công/thất bại bằng tay.
5. Nếu chưa có đường khôi phục được hỗ trợ, giữ lại bằng chứng, hạn chế admission/dispatch bằng cơ chế triển khai đã duyệt nếu có nguy cơ mất dữ liệu/chi phí lặp, rồi chuyển cho Platform/Connector/Security owner. Không phát lại provider call mơ hồ.

## Điều kiện kết thúc incident

- Đã xác nhận dependency, queue/outbox và các state bền vững tiến triển trở lại; backlog giảm theo budget.
- Task được claim bằng lease mới hoặc có kết quả state có thẩm quyền; stale worker không thể ghi đè state mới.
- Provider usage không bị nhân đôi, usage outbox có ack, artifact bytes khớp hash và vẫn được tham chiếu.
- Credential cũ đã revoke theo kế hoạch, canary thành công và không thấy secret trong log/trace/response.
- Ticket ghi rõ tác động, timeline, actor, action, bằng chứng kiểm tra sau khôi phục và việc cần làm để chuyển draft này thành runbook đã diễn tập.

## Giới hạn nghiệm thu

P8-07 chưa thể được đánh dấu hoàn tất chỉ dựa trên tài liệu. Cần dashboard/alert thật, owner/on-call, ngưỡng sau benchmark, công cụ recovery được hỗ trợ, và rehearsal cô lập không tạo duplicate provider effect/billing hay xóa artifact còn tham chiếu.
