# Tổng hợp đánh giá Frontend Orchestrator & Đề xuất tính năng mới

Ngày: 2026-10-10 (Asia/Bangkok)
Người tổng hợp: Coordinator (Single Dispatcher)
Kính gửi: Claude Code Agent (`term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8`)

---

## 1. Nguồn dữ liệu khảo sát độc lập
Ba agent độc lập (đóng vai trò Support / System Admin vận hành `du-rework`) đã khảo sát mã nguồn tĩnh tại `du-rework/orchestrator/apps/admin-web` và nộp báo cáo:
1. **DeepSeek-1 (`term_8bfe6adc`)**: `feedback-frontend-deepseek-1-2026-10-10.md` (87 dòng, 9.0 KB)
2. **Codex-Luna-1 (`term_cd3c19e4`)**: `feedback-frontend-codex-1-2026-10-10.md` (44 dòng, 8.7 KB)
3. **Codex-Luna-2 (`term_e97ba66f`)**: `feedback-frontend-codex-2-2026-10-10.md` (69 dòng, 11.7 KB)

---

## 2. Các điểm yếu cốt lõi được đồng thuận (Consensus Flaws)

1. **Hiển thị giả lập / sai lệch độ trung thực (False / Stale Reality)**:
   - **Workflow Test trả kết quả giả thành công**: Khi `workflow.test` lỗi hoặc ném ngoại lệ, `workflows-screen.tsx:376-414` vẫn sinh trạng thái `SIMULATED_SUCCESS` kèm operation ID giả (`sim-op-*`) và đánh dấu xanh các stage, khiến nhân viên hỗ trợ tưởng nhầm workflow đã chạy thành công thật.
   - **Trạng thái Worker là giả lập**: Overview tạo hàng worker từ Business registry (`computeWorkerTelemetry`), hiển thị chấm xanh nhấp nháy `bg-green-500 animate-pulse` dựa trên business registration chứ không hề có heartbeat hay health check của worker instance thật.
   - **Overview chỉ lấy mẫu 100 operation gần nhất**: `overview-screen.tsx:327` chỉ tải `limit: 100`, nhưng UI lại cho chọn khung thời gian lên tới 6 tháng. Success rate, total count đều tính trên 100 dòng này ở client.
   - **Overview không lọc theo Tenant đang chọn**: Với Platform Admin, dữ liệu Overview bị gộp toàn bộ tenant dù dropdown đang chọn 1 tenant cụ thể.

2. **Khó khăn nghiêm trọng trong việc Triage / Hỗ trợ sự cố**:
   - **Thiếu màn hình Audit độc lập**: Không có route `/audit` riêng, chỉ nhúng 50 log gần nhất ở Overview mà không có phân trang server-side, không tìm kiếm lịch sử được.
   - **Lần vết sự cố (Traceability) bị phân mảnh**: Khi có `correlationId` hoặc `operationId`, nhân viên phải nhảy qua 5-6 màn hình (Operations, Tasks, Webhooks, Outbox, Audit) để chắp vá vòng đời.
   - **Lọc ngày Operations chỉ lọc trên trang hiện tại**: Bộ lọc ngày chỉ áp dụng cho mẩu dữ liệu đang tải, không thể query lịch sử server-side.
   - **Bulk Actions xóa mất trạng thái chọn khi gặp lỗi**: Khi cancel nhiều operation, nếu dòng thứ 3 lỗi thì vòng lặp dừng ngay lập tức và xóa sạch selection, operator không biết dòng nào đã cancel dòng nào chưa.
   - **0 file dùng AbortController**: Rời màn hình hoặc đổi filter nhanh gây race condition kết quả cũ ghi đè kết quả mới.

---

## 3. Danh sách các đề xuất tính năng được gộp nhóm

Từ các đề xuất của 3 agent, có 5 nhóm tính năng lớn nổi bật:

### Nhóm 1: Trace / Support Incident Workspace (Tra cứu vòng đời hợp nhất)
- **Mục tiêu**: Một ô tìm kiếm đa năng nhận `correlationId`, `operationId`, `taskId`, hoặc `deliveryId`.
- **Hành vi**: Trả về toàn bộ timeline: Operation state transitions -> Root task & child task attempts -> Outbox/Webhook delivery -> Usage & Quota events -> Audit log liên quan. Có payload viewer (đã mask/redact dữ liệu nhạy cảm) và deep-link chia sẻ nội bộ.

### Nhóm 2: Audit Trail Console độc lập & Lọc Server-side
- **Mục tiêu**: Đưa Audit thành một menu riêng (`/audit`) thay vì nhúng phụ ở Overview.
- **Hành vi**: Phân trang cursor server-side; lọc đa chiều theo time range, actor, tenant, severity, event kind, correlationId; hỗ trợ export CSV cho ticket điều tra sự cố.

### Nhóm 3: Worker & Queue Telemetry thời gian thực (Heartbeat thật)
- **Mục tiêu**: Xóa bỏ trạng thái chấm xanh giả lập.
- **Hành vi**: Kết nối với bảng `worker_instances` (đã duyệt ở plan §12) để hiển thị danh sách worker thật, heartbeat last-seen, queue backlog depth, lease age, stalled jobs, và báo trạng thái degraded/offline chuẩn xác.

### Nhóm 4: Operations Recovery Workspace & Bulk Action Tin Cậy
- **Mục tiêu**: Nâng cấp màn Operations thành trung tâm cứu hộ hệ thống.
- **Hành vi**: Lọc server-side theo thời gian thực sự; bulk retry/cancel có báo cáo kết quả per-item; giữ lại các item thất bại để retry tiếp; xem chi tiết lỗi và stack trace gọn gàng.

### Nhóm 5: Configuration & Workflow Change Center (Kiểm soát thay đổi & Dry-run thật)
- **Mục tiêu**: Tách biệt hoàn toàn Dry-run / Validation với Chạy thật.
- **Hành vi**: Sửa màn Workflows không sinh `SIMULATED_SUCCESS` giả tạo khi backend lỗi; diff so sánh giữa 2 revision Business/Profile/Workflow; effective configuration preview theo từng tenant trước khi bấm Publish/Rollback.

---

## 4. Nhiệm vụ của Claude Code Agent
Kính nhờ Claude Code Agent:
1. Đọc và đánh giá 5 nhóm tính năng đề xuất trên dựa trên mức độ ưu tiên, rủi ro vận hành và kiến trúc tổng thể của `du-rework`.
2. Chọn ra **Top 5 tính năng chuẩn xác nhất** để đưa vào plan triển khai mới.
3. Phác thảo roadmap/breakdown task (ví dụ: AWEB-16, AWEB-17...) vào plan điều phối tiếp theo.
