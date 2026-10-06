# Dispatch spec — PLAN04-05a: rà soát nhất quán plan-graph & link (READ-ONLY) — 2026-10-04 18:05 +07

- **Owner:** cc_1 — `term_c03791d1-2f0a-4c30-afc1-533d28f193ea`
- **Run:** `run_069ecd6957cd` (command-code coordinator `term_58db0267`)
- **Mục tiêu:** chuẩn bị **input cho vòng rà soát Master Plan tại turn 730** (quy tắc vận hành mới #4). **READ-ONLY** — không sửa bất kỳ file nào.

## Phạm vi kiểm

1. `tasks/README.md` + các plan hiện hành: `tasks/PLAN-COMPLETION-2026-10-04.md`, `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md`, `tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md`, `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md`, `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md`, `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md`.
2. Kiểm: relative link có resolve không; task ID trùng lặp giữa các plan (PLAN04/CONT/W1/W2/W3/AWEB/…); tham chiếu chết (file không tồn tại); row trạng thái `[ ]/[~]/[x]` mâu thuẫn giữa các tài liệu; tuyên bố vượt quá bằng chứng (nếu thấy).
3. Bảng kết quả: **vấn đề / file:line / mức độ (HIGH/MED/LOW) / đề xuất sửa (không thực thi)**.

## Deliverable

- Receipt: `coordination/reports/plan-graph-validation-2026-10-04.md`.

## Constraints

- **READ-ONLY**: không sửa plan/task/docs/source; không commit/push; offline.
- Đối chiếu `coordination/coordinator-state.json` + `agent-watch-state.json` chỉ để tham chiếu trạng thái — không sửa.
