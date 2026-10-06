# Dispatch spec — CFGADM/LPG register-delta inventory (cc_2, read-only) — 2026-10-04 19:00 +07

- **Owner:** cc_2 — `term_ee7e9f33-e20d-483d-8423-830f2924d90c`
- **Run:** `run_069ecd6957cd` · Nguồn: `plan-review-730 §3` (merge row) + §5 (cycle 732: "cc_2 nhận CFGADM/LPG register delta").

## Việc cần làm (read-only output — plan writes thuộc plan editor)

1. **Inventory register/index delta** cho các row mới: `CFGADM-00..11` (từ `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md`) + `LPG-01/02` (từ `LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md`): row nào hiện có mặt trong `tasks/README.md` index/register + bảng Phase packets; row nào còn thiếu; ghi `file:line`.
2. **Gate mapping check**: nhãn implemented/verified/accepted của các row này có đúng trạng thái thật (đối chiếu receipt hiện có) không; row nào đang active/dependency sai.
3. **Dedupe-noise check**: xác nhận "không đếm citation thành duplicate task declarations" — liệt kê các citation hợp lệ vs nơi có thể bị hiểu nhầm là định nghĩa trùng.
4. Bảng: row / register status hiện tại / cần gì / đề xuất (không thực thi).

## Deliverable

- Receipt **MỚI**: `coordination/reports/cfgadm-lpg-register-delta-2026-10-04.md`.

## Constraints

- READ-ONLY (ngoài receipt của mình); không sửa plan/task/docs; không tick; không commit/push.
