# Secret provenance review (READ-ONLY) — 3 ứng viên real-looking từ secret sweep

## Bối cảnh

`tester-secret-sweep-2026-10-02.md`: 253 lượt match, 250 placeholder/mock, **3 real-looking chưa kết luận**:

1. `services/orchestrator/src/app/admin/shell-server.ts:374` — literal `apiKey` assignment, **43 ký tự, production code**, không có marker placeholder.
2. `coordination/reports/qwen-cost.md:67` — OpenAI-style pattern (27).
3. `coordination/reports/qwen3.md:1600` — OpenAI-style pattern (20) trong ví dụ connection-string.

## Mục tiêu (mỗi ứng viên)

- Xác định **nguồn gốc + mục đích sử dụng** và **disposition khuyến nghị**:
  - shell-server.ts:374: đọc context quanh dòng đó (constant tên gì, dùng ở đâu, export? default/fallback?),
    xem `git log --oneline -- <file>` (KHÔNG dùng `-S`/`-L`/`git show` trên dòng có nguy cơ in giá trị);
    phân loại dựa trên vị trí/mục đích sử dụng + metadata từ sweep. Nếu kết luận "khả năng real cao" →
    **STOP ở khuyến nghị** (rotate/purge) + escalate, không tự xử lý.
  - 2 file report: xác nhận ngữ cảnh (prose/excerpt) + khuyến nghị redact/annotate (không tự sửa).
- Kết luận từng dòng: `real` / `benign-placeholder` / `không xác định được offline` + việc cần làm tiếp.

## HARD RULES

- **KHÔNG in giá trị** credential ở bất kỳ đâu: không terminal echo, không vào receipt, không trích >2 ký tự.
  Chỉ tham chiếu `file:line` + độ dài.
- Không validate credential qua mạng; không sửa file; không tick gate; không commit; không nhắm `nocobase-10`.

## Acceptance

- Receipt `coordination/reports/codex-secret-provenance-2026-10-02.md`: bảng 3 dòng
  (vị trí → nguồn/mục đích → phân loại → khuyến nghị) + giới hạn ("offline, không kiểm tra validity").
