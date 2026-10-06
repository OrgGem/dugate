# Dispatch spec — docs pointer sync (11-admin-ux) (2026-10-04 16:01 +07)

## Mục tiêu

Đóng nốt doc-note của `aweb08-docs`: cập nhật `docs/11-admin-ux.md` trỏ về semantics rollout mới; **không** chép lại nội dung.

## Việc cần làm

1. **Mtime guard**: `11-admin-ux.md` mtime 10:50:05 (đã 5h không writer) + `git status -- docs` — nếu vẫn vậy thì vá; nếu ai đó vừa chạm → dừng, báo coordinator.
2. Thêm **1–2 dòng** (đúng chỗ liên quan Admin Web/màn hình) trỏ: `docs/12b-deployment-guide.md §3.1` cho rollout flag `DU_ADMIN_WEB*` (fail-closed, per-route) + `docs/admin-ui-development-contract.md` cho contract UI; giữ văn phong hiện có.
3. **Rà nhanh tuyên bố cũ** (grep trong `docs/**.md`): các câu kiểu "Admin Web mount toàn bộ / không per-route", "bật/tắt bằng 1 cờ duy nhất" hoặc tham chiếu rollout cũ — **chỉ liệt kê** file:line trong receipt (không sửa rộng; nếu file đó sạch + sửa 1 dòng được thì sửa, ghi rõ).
4. Receipt ghi: file:line đã sửa, danh sách stale còn lại (nếu có) + mtime guard.

## Lease

- `du-rework/docs/11-admin-ux.md` (+ tối đa 1 file docs sạch khác nếu chỉ 1 dòng), receipt. KHÔNG code, không `tasks/**`, không file đang dirty bởi lane khác. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb08-docs-ux-pointer-2026-10-04.md`.

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978`. Dispatch 2026-10-04 16:01.
