# Dispatch spec — .env.example sync Admin Web flags (2026-10-04 14:51 +07)

## Mục tiêu

Đóng doc-note của `aweb08-docs`: thêm 3 biến Admin Web vào `du-rework/.env.example` (file sạch, mtime 28/09 — đã kiểm; tái-kiểm mtime trước khi vá).

## Việc cần làm

1. Đọc `.env.example` hiện tại; thêm nhóm comment ngắn (giữ format hiện có):
   ```
   # Admin Web React (AWEB) — xem docs/12b-deployment-guide.md §3.1
   # DU_ADMIN_WEB=1                       # bật mount /admin/web (mặc định tắt)
   # DU_ADMIN_WEB_ROUTES=overview         # allow-list route SPA (fail-closed; mặc định toàn bộ)
   # DU_ADMIN_WEB_DIST=/abs/apps/admin-web/dist   # tùy chọn override bundle
   ```
   (3 dòng comment-out đúng convention file hiện tại; nếu file dùng biến thật không comment cho các flag tương tự thì theo convention đó.)
2. Grep xác nhận không trùng; không đổi biến khác; ghi file:line vào receipt.

## Lease

- `du-rework/.env.example` + receipt. Không sửa gì khác (kể cả `.env.live`).

## Deliverable

- Receipt: `coordination/reports/env-example-admin-web-2026-10-04.md` (diff ngắn + mtime trước khi vá).

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978`. Dispatch 2026-10-04 14:51.
