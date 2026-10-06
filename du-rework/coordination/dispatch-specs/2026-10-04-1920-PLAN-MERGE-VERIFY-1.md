# Dispatch spec — PLAN-MERGE-VERIFY-1 (cc_1, read-only) — 2026-10-04 19:20 +07

- **Owner:** cc_1 — `term_c03791d1-2f0a-4c30-afc1-533d28f193ea`
- **Run:** `run_069ecd6957cd` · Nguồn: `coordination/reports/plan-merge-fix-2026-10-04.md` (codex_arch vừa land — claim 10/10 fixed).

## Việc cần làm (READ-ONLY, no re-test)

1. Với từng mục **M2, M3, M4, L1–L7**: claim trong plan-merge-fix → đối chiếu **cây hiện tại**: fixed đúng **ngữ nghĩa** hay chỉ resolve hình thức (ví dụ L1 anchor trỏ đúng heading, không chỉ tồn tại).
2. Re-run check tương ứng từng item (link/ID/anchor/port/text) — dùng đúng phương pháp của bạn; ghi literal output.
3. Re-anchor nếu drift (cây đã đổi sau receipt).
4. Ghi receipt **MỚI**: `coordination/reports/plan-merge-verify-1-2026-10-04.md` — bảng: item / claim / verified (FIXED / PARTIAL / STILL) / ghi chú.

## Constraints

- READ-ONLY tuyệt đối; không sửa plan/docs; không tick; không commit/push. Được phép chạy checker của bạn (đọc).
