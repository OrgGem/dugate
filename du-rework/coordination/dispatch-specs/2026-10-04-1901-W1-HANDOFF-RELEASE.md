# Dispatch spec — W1-HANDOFF: danh sách release file cho W1c/W3 — 2026-10-04 19:01 +07

- **Owner:** qwen_1 — `term_7cb640ae-5ffe-4675-9f7b-0c99c1070268`
- **Run:** `run_069ecd6957cd` · Bối cảnh: checkpoint (b) của W1 yêu cầu "release từng file cần chuyển, không tự giả định cả lease hết" (plan-review-730 §2).

## Việc cần làm (chỉ ghi receipt — KHÔNG đổi code)

Ghi vào `coordination/reports/qwen1.md` **section mới**: `## W1 HANDOFF — RELEASE LIST`:

1. Với từng file/nhóm trong lease W1 (`submission.ts`, `profiles/**`, `queue/dispatcher.ts`, `runtime/runtime.ts`, `contracts/{profile-policy,runtime,index}.ts`, `migrations/0026,0027` nếu có chạm, test files riêng của bạn): trạng thái (frozen) + **digest ngắn (sha256 rút gọn)**.
2. **Đề xuất release**: file nào chuyển NGAY cho **W1c** (đặc biệt `profiles/file-url-auth.ts` + acquisition-adjacent), file nào cho **W3** (publish/CAS paths), **thứ tự** + điều kiện an toàn (không 2 writer cùng lúc).
3. File/nhóm nào **giữ read-only** (hoặc không release) — kèm lý do.
4. Câu hỏi cho coordinator nếu có xung đột quyền.

## Constraints

- Không sửa code/test; không commit/push; không tick. Chỉ ghi receipt (section mới trong file lane của bạn).
- Δ-DEVIATION nếu cần.
