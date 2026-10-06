# User Directive — Cấu trúc Điều Phối & Phân Bổ Agent Hiện Hành (2026-10-04 17:18 +07)

- **Người ban hành**: User (chính thức ghi nhận tại terminal session)
- **Đối tượng tiếp nhận**: Command Code Coordinator (`term_50f39a02`), toàn bộ các lane worker trong hệ thống Orca
- **Mục tiêu**: Điều chỉnh và cố định vai trò điều phối viên và các agent thực thi; chấm dứt tình trạng Claude Code tự động implement.

---

## 1. Nội dung Chỉ đạo Trực tiếp từ User

Người dùng yêu cầu điều chỉnh rõ ràng:
1. **Agent Điều phối (Coordinator)**: Cố định **Command Code Coordinator agent** (`term_50f39a02`) là điều phối viên duy nhất (single dispatcher) của `du-rework`.
2. **Các Agent Thực thi (Execution / Implementation Workers)**: Command Code Coordinator sẽ trực tiếp phân bổ và điều phối các tác vụ triển khai (code, fix bug, unit/contract test) cho hai nhóm agent:
   - **Qwen Code agents**: `qwen_1`, `qwen_3`, `qwen_4`, `qwen_5`
   - **Codex agents**: `codex_worker_1`, `codex_worker_2`, `codex_worker_3`, `codex_tester_offline`, `codex_tester_live`
3. **Chấm dứt việc Claude Code Implement**:
   - **Dừng ngay** việc Claude Code tiếp tục tự động implement (Phase 2 Profiles hoặc bất kỳ backlog nào khác).
   - Đưa Claude Code trở lại đúng vai trò theo `du-rework/AGENTS.md`: **Review-only** (code review độc lập, thẩm định module/backend sau khi Qwen/Codex hoàn thành implement và verify) hoặc **Plan-mode** khi có yêu cầu riêng từ User. Không cấp lease implement/dispatch cho Claude Code.
4. **Vai trò của Antigravity (`term_38afaa0e-081f-4e32-91b2-25459d048b0e`)**:
   - Giữ vai trò chuyên trách UI components, UI foundation, và kiểm định UI độc lập theo Contract §5 (`UI_APPROVED` / `CHANGES_REQUIRED`).

---

## 2. Hướng Dẫn Thực Thi Dành Cho Coordinator (`term_50f39a02`)

Theo biên bản [`coordination/reviews/2026-10-04-1712-note-implementation-provenance.md`](./2026-10-04-1712-note-implementation-provenance.md) §1.2:
> *"Nếu ý user hiện tại là chỉ plan/review, không implement → cần một lệnh dừng rõ ràng; coordinator sẽ dừng lane Claude + chuyển review-only ngay khi được xác nhận."*

Chỉ đạo này là **lệnh dừng và tái cơ cấu chính thức**. Trong chu kỳ (cycle) tiếp theo, Coordinator cần thực hiện:

1. **Dừng / Hủy lane implementation của Claude Code**:
   - Thu hồi write lease implementation của Claude Code đối với Phase 2 Profiles.
   - Ghi nhận trạng thái lane Claude là `settled / review-only`.
2. **Tái phân bổ các task implement cho Qwen Code và Codex**:
   - Phân chia các task cụ thể (như `T-PROF-02`, `T-SUB-01..04`, parity migrations, dispatchers, v.v.) sang các worktree / lease độc lập cho **Qwen Code** và **Codex**.
   - Đảm bảo tuân thủ `coordinator-cycle-prompt.md` §3: *"đảm bảo giao task đầy đủ cho Qwen và Codex agents thực hiện, tránh để idle"*.
3. **Cập nhật `coordination/coordinator-state.json`**:
   - Ghi nhận chỉ đạo của User vào lịch sử điều phối và cập nhật trạng thái hoạt động của roster.
