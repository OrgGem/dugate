# Runbook: Provider invocation `UNKNOWN`

**Trạng thái:** draft. Đây là outcome mơ hồ, không phải failed có thể retry. Source snapshot không cung cấp operator reconciliation endpoint hoặc quy trình cập nhật ledger đã được nghiệm thu.

## Trigger và ý nghĩa

Connector có thể ghi invocation `UNKNOWN` khi provider call đã gửi nhưng response/transport mất, poll budget cạn hoặc kết quả không thể kết luận. Replay cùng `invocation_id` sẽ trả `INVOCATION_UNKNOWN`; đây là chặn blind retry. `PENDING` khác `UNKNOWN`: pending có lịch `next_poll_at` và có thể tiếp tục polling theo lease/poll budget.

## Triage

1. Tạo incident/ticket riêng cho invocation; ghi UTC, môi trường, invocation/operation/task/step IDs, connector alias/revision, error code và provider request ID nếu có. Không lưu request/result body, API key, signed grant hoặc file.
2. Dùng log có phân quyền hoặc DB read role để đọc đúng một ledger row. Chỉ lấy các field cần thiết; không dump cột `request` hoặc `result`:

   ```sql
   SELECT invocation_id, operation_id, task_id, step_key, state,
          error_code, provider_request_id, next_poll_at, updated_at
   FROM connector_invocations
   WHERE invocation_id = $1;
   ```

3. Nếu state là `PENDING`, xem `next_poll_at`, poll attempts/lease và provider readiness; để worker recovery/poll theo cơ chế hiện có. Không chuyển PENDING thành UNKNOWN chỉ vì một lần timeout.
4. Với `UNKNOWN`, tra trạng thái qua provider console/API hoặc support chính thức bằng provider request ID/idempotency key và account alias. Chỉ dùng credential/tool đã được duyệt; lưu bằng chứng provider có thẩm quyền và thời điểm tra cứu.
5. Nếu provider không tìm thấy request, xác minh retention/lookup window và idempotency guarantee bằng provider contract. “Không thấy” không đủ để khẳng định call chưa được thực thi.

## Quyết định theo evidence

| Kết quả tra cứu | Hành động |
|---|---|
| Provider xác nhận completed và trả được kết quả có thẩm quyền | Chuyển Connector owner để đối chiếu invocation ledger, materialize result/usage qua recovery path đã hỗ trợ. Không tự cập nhật state/result trong DB. |
| Provider xác nhận request chưa được chấp nhận hoặc failed terminal | Chuyển Connector owner xác minh retry/idempotency và phát hành replay qua cơ chế có audit. Không reuse/reset invocation bằng SQL. |
| Provider vẫn processing | Giữ alert/ticket mở, lên lịch tra cứu tiếp theo theo provider contract; không phát call thứ hai. |
| Provider lookup không có kết luận | Giữ `UNKNOWN`, báo rõ nguy cơ duplicate effect/charge và escalation cho Connector + nghiệp vụ. Không đoán `FAILED`. |

Snapshot hiện không có API reconcile operator-facing. Nếu provider đã xác nhận nhưng chưa có công cụ recovery được duyệt, **dừng tại bước escalation**; owner phải cung cấp path có audit và concurrency/idempotency guard. Không `UPDATE connector_invocations`, xóa quota key hoặc gửi lại invocation để thử vận may.

## Đóng incident

Chỉ đóng sau khi có state/kết quả có thẩm quyền, usage event đối chiếu đúng một lần, quota lease/counter được service quản lý nhất quán, và operation được resume/recover qua supported path. Lưu evidence tham chiếu, người quyết định và mọi khoản bù/hoàn phí. UNKNOWN quá budget phải page; tuổi state không tự làm nó thành failure.

**Tham chiếu:** `../../orchestrator/services/connector/src/invoke.ts`, `../../orchestrator/services/connector/src/db/repository.ts`, `../../orchestrator/services/connector/src/db/migrations/001_connector.sql`.
