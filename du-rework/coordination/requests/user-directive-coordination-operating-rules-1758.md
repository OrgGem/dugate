# User Directive — Nguyên Tắc Vận Hành Điều Phối (2026-10-04 17:58 +07)

- **Người ban hành**: User
- **Đối tượng tiếp nhận**: Command Code Coordinator (`term_58db0267`), toàn bộ Roster Agents trong Orca
- **Mục tiêu**: Chuẩn hóa 4 quy tắc vận hành bắt buộc trong quá trình điều phối `du-rework`.

---

## 4 Quy Tắc Điều Phối Bắt Buộc

### 1. Phủ kín và điều phối đủ số lượng Agent hiện có trong Roster
* Coordinator phải phân bổ công việc đồng đều, tận dụng công suất của **toàn bộ các agent** trong danh sách:
  * 5 workers Qwen Code (`qwen_1..5`)
  * 2 testers Codex (`codex_tester_offline`, `codex_tester_live`)
  * 2 lane Command Code phụ (`cc_1`, `cc_2`)
  * 1 Codex Arch (`codex_arch` - `term_43f85ccc`)
  * 1 Reviewer (`reviewer` - Claude Code `term_19edcad8`)
  * 1 UI Lead & Reviewer (`antigravity` - `term_ae2d7e42`)
* Phân công theo đúng năng lực chuyên trách và áp dụng cơ chế single-writer / file lease để tránh conflict; tuyệt đối không dồn việc vào 1 agent hay để các worker khác ngồi idle.

### 2. Kiểm tra Log thật mỗi phiên — Chống Stuck Task
* Tại mỗi phiên điều phối (nhịp 10 phút), Coordinator **bắt buộc đọc log terminal thật** (`orca terminal read`) của từng agent đang nhận task.
* Nếu task chưa hoàn thành: phải phân tích tail xem agent có đang làm việc thực sự hay bị kẹt (chờ user confirm, lỗi vòng lặp, rate limit, unhandled prompt).
* Nếu phát hiện stuck hoặc không có tiến triển sau 2-3 chu kỳ kiểm tra liên tiếp: phải gửi prompt can thiệp ngay (nudge, tháo gỡ blocker, hoặc thu hồi lease tái phân bổ), không để task bị kẹt kéo dài.

### 3. Quy trình Gọi Review Độc Lập cho Task đã Implement
* Khi bất kỳ task nào được implement xong và có receipt kiểm thử đạt chuẩn:
  * **Backend / Service / API / Contracts**: Bắt buộc chuyển sang **Claude Code** (`term_19edcad8`) để review độc lập.
  * **Admin UI**: Khi có build và browser evidence, bắt buộc tạo packet gửi **Antigravity** (`term_ae2d7e42`) review theo Contract §5.
* Coordinator tiếp nhận findings từ Reviewer, chuyển lại cho worker phụ trách sửa đổi, sau đó yêu cầu review lại. Chỉ tick acceptance khi đã có verdict APPROVED.

### 4. Kiểm Điểm & Bổ Sung Plan Sau Mỗi 5 Lượt Điều Phối (5-Cycle Checkpoint)
* Cứ sau mỗi **5 lượt điều phối** (hoặc mỗi chu kỳ `turn % 5 == 0`):
  * Coordinator dừng nhịp dispatch thường quy để thực hiện **Plan Review Checkpoint**.
  * Soát xét toàn bộ tiến độ đối chiếu với Master Plans (`tasks/PLAN-COMPLETION-*.md`, `tasks/ORCHESTRATOR-CONFIG-*.md`, `tasks/ADMIN-WEB-*.md`).
  * Phối hợp cùng **Codex Arch** (`term_43f85ccc`) hoặc trực tiếp bổ sung, cập nhật các task mới phát sinh, sắp xếp lại backlog cho 5 chu kỳ tiếp theo trước khi tiếp tục dispatch.
