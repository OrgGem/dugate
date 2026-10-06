# Dispatch spec — AWEB-08-inv: legacy surface inventory cho cutover (read-only) (2026-10-04 16:31 +07)

## Mục tiêu

Audit READ-ONLY chuẩn bị AWEB-08 (cutover từng route): liệt kê **bề mặt legacy sẽ thành dead** theo từng route đã `UI_APPROVED`, kèm rủi ro xoá và điều kiện giữ. Chỉ ghi receipt — **không sửa/xoá gì**.

## Việc cần làm

1. Với từng route Admin Web mới (10 route: shell, overview, profiles, api-keys, connectors, operations, businesses, usage, security, identity, settings — theo rollout matrix `aweb08prep`), liệt kê phần legacy tương ứng:
   - renderer/HTML: `src/app/admin/shell-render.ts`, section renderers (`*-section-renderer.ts`), `shell-router.ts` route entries;
   - data/actions: `*-section-data.ts`, `section-dispatch.ts`, `mutation-dispatch.ts` handler;
   - tests/suites legacy tương ứng; fixtures/p6-01 shell fixtures.
   Ghi `file:line` + vai trò.
2. Phân loại mỗi mục: `dead-sau-cutover` / `còn dùng chung` (vd assets, login, session path) / `phải giữ tới khi X` — kèm lý do (URL/bookmark, role matrix, CSRF path, evidence cũ).
3. **Điều kiện cutover mỗi route**: UI_APPROVED ✓ (đã có, ghi build), service conditions (ghi theo rollout matrix + AWEB-08 acceptance), live evidence cần cho route nào (security/identity cần gì).
4. **Rủi ro xoá sớm** (≥5 dòng cụ thể): ai đang import legacy module, tests nào sẽ đỏ, docs nào trỏ vào.
5. Nêu rõ những gì **không** thể quyết trong audit này (chờ user/PAR-00/ACUI-10).

## Verdict

- Bảng tổng route → legacy pieces → classification → điều kiện; kết bằng danh sách “đề xuất bước AWEB-08 kế tiếp” (không thực thi).

## Deliverable

- Receipt: `coordination/reports/aweb08-legacy-inventory-2026-10-04.md`.

## Lane

- **cc_2** — `term_5f7e42da-6790-4449-8539-746626c5d078`. Dispatch 2026-10-04 16:31.
