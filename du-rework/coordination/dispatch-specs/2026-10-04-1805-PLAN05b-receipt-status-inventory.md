# Dispatch spec — PLAN04-05b: inventory receipt/trạng thái cho các row PLAN-COMPLETION (READ-ONLY) — 2026-10-04 18:05 +07

- **Owner:** cc_2 — `term_ee7e9f33-e20d-483d-8423-830f2924d90c`
- **Run:** `run_069ecd6957cd` (command-code coordinator `term_58db0267`)
- **Mục tiêu:** chuẩn bị **input cho vòng rà soát Master Plan tại turn 730**. **READ-ONLY** — không sửa file nào, chỉ viết receipt.

## Việc cần làm

1. Với từng row của `tasks/PLAN-COMPLETION-2026-10-04.md` (PLAN04-01..05, CONT-00..05) + các row mới của `LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md`: đối chiếu xem đã có receipt/evidence nào trong `coordination/reports/**` tương ứng chưa (tên file gần đúng, cross-check nội dung).
2. Phân loại mỗi row: `đã có receipt chưa review` / `đang dispatch` / `chưa có gì` / `gated bởi dependency khác (ghi rõ)`.
3. Cross-check với báo cáo register cũ (`coordination/reports/plan-open-task-register-2026-10-03.md`, `recon-old-plans-*`) — **không làm lại từ đầu**; chỉ ghi phần lệch mới.
4. Bảng: **row / trạng thái / receipt hiện có / dependency / đề xuất kế tiếp** (không thực thi).

## Deliverable

- Receipt: `coordination/reports/receipt-status-inventory-2026-10-04.md`.

## Constraints

- **READ-ONLY** (ngoại trừ file receipt của mình); không commit/push; offline.
