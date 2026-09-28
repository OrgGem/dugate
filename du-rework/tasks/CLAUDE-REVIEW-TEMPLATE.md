# Claude Code Post-Module Review Packet Template

Sử dụng template này khi một module chức năng hoàn tất toàn bộ chu trình từ Implementation (Qwen) đến Verification (Codex Tester), trước khi coordinator phê duyệt chuyển sang trạng thái `ACCEPTED` (`[x]`).

---

## 1. Thông tin tổng quan (Overview)

- **Module / Feature ID**: [Ví dụ: `ORCH-OPS-01`, `VAULT-06`, `SEC-OIDC-03`]
- **Các Task cấu thành đã xong**: [Liệt kê Task ID, ví dụ: `task_xxxx` (implement), `task_yyyy` (testing)]
- **Owner Implement (Qwen)**: [Qwen-1 / Qwen-2 / Qwen-3]
- **Owner Tester (Codex)**: [Codex Offline / Codex Live]
- **Target paths / Git diff**: [Danh sách file/thư mục thay đổi trong module]
- **Spec / ADR liên quan**: [Đường dẫn ADR và tài liệu đặc tả luồng]
- **Evidence / Receipts đính kèm**:
  - Implement report: `coordination/reports/qwen-*.md#...`
  - Verification receipt: `coordination/reports/tester.md#...` (ghi rõ test count, exit code, SHA guard nếu có)

---

## 2. Tiêu chí rà soát (Review Checklist for Claude Code)

1. **Tuân thủ Spec & Contract (Contract Conformance)**:
   - Code có bám sát ADR/BRD không? Có assumption ngầm nào chưa được chuẩn hóa không?
   - Input/output schemas, error taxonomy, wire contract có bảo đảm tính tương thích ngược với các consumer không?
2. **Chất lượng mã nguồn & Kiến trúc (Code Quality & Architecture)**:
   - Xử lý lỗi, fail-closed, timeout/cancellation, idempotency token có chặt chẽ không?
   - Phân định ranh giới module (boundaries), tính toàn vẹn dữ liệu, transaction/DB outbox (nếu có)?
3. **Bảo mật & Ranh giới Tenant (Security & Multi-tenancy)**:
   - Kiểm tra tenant isolation, authorization checks, credential leak, input sanitization.
4. **Tính xác thực của Test Suite (Test Validity & Coverage)**:
   - Các ca test có thực sự kiểm tra logic biên (edge cases) không?
   - Có hiện tượng false-green, over-mocking hoặc silent skipped test bị tính nhầm là passed không?
5. **Đồng bộ tài liệu (Traceability & Documentation)**:
   - `docs/19`, `docs/28`, `docs/35` và README tương ứng đã được cập nhật chính xác theo thay đổi chưa?

---

## 3. Định dạng kết quả Review (Finding & Verdict Protocol)

Claude Code nộp báo cáo review vào `coordination/reports/review.md` (hoặc gửi message qua Orca terminal) theo cấu trúc:

### Danh sách Findings:
Mỗi finding phải có cấu trúc:
- **`[REV-<Module>-<STT>]`**: [Tiêu đề finding]
  - **Mức độ (Severity)**: `HIGH` (Blocker / Bug bảo mật / Sai spec) | `MEDIUM` (Thiếu kiểm tra biên / Lỗi tài liệu nghiêm trọng) | `LOW` / `SUGGESTION` (Code smell / Tối ưu nhỏ).
  - **Vị trí (Location)**: `<file_path>:<line_number>`
  - **Kỳ vọng (Expected)**: Mô tả hành vi đúng theo spec/ADR.
  - **Thực tế (Actual)**: Mô tả hiện trạng code hoặc test.
  - **Bằng chứng (Evidence/Repro)**: Đoạn code, lệnh test hoặc logic chứng minh lỗi.

### Kết luận thẩm định (Final Verdict):
- **`APPROVED`**: Không có finding `HIGH` hoặc `MEDIUM`. Module đủ điều kiện kỹ thuật để coordinator đánh dấu `ACCEPTED` (`[x]`).
- **`CHANGES_REQUESTED`**: Có ít nhất một finding `HIGH` hoặc `MEDIUM`. Acceptance gate bị chặn. Coordinator sẽ tạo packet sửa lỗi giao lại cho Qwen và yêu cầu tái kiểm thử.
