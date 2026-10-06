# Dispatch spec — AWEB-08-prep: per-route rollout flag + matrix + docs (2026-10-04 14:12 +07)

## Mục tiêu

Chuẩn bị hạ tầng cutover từng route (AWEB-08) **mà chưa gỡ renderer cũ** — giữ legacy nguyên trạng mặc định.

## Việc cần làm

1. **Per-route flag**: mở rộng cơ chế `DU_ADMIN_WEB` hiện có (mount toàn app) thành cho phép **bật/tắt theo route** cho các route mới (`overview, profiles, api-keys, connectors, operations, businesses, usage, security, identity, settings`) — ví dụ env `DU_ADMIN_WEB_ROUTES` (allow-list, default = hành vi hiện tại: toàn bộ hoặc tắt theo `DU_ADMIN_WEB`); route không nằm allow-list → SPA trả not-found nhất quán HOẶC fallback legacy (chọn theo contract "route chưa chuyển tiếp tục dùng renderer hiện tại" — ghi rõ quyết định trong receipt).
   - Không đổi hành vi khi env vắng; test cho: mặc định, allow-list một phần, route ngoài allow-list.
2. **Rollout matrix (trong receipt)**: bảng route → UI verdict hiện có (`UI_APPROVED` `/admin/web`+`/overview`; các route khác chờ review packet #2) → điều kiện cutover (UI_APPROVED + service conditions) → trạng thái bật/tắt hiện tại.
3. **Docs**: cập nhật `apps/admin-web/README.md` (flag + cách chạy + serve); ghi doc-note cho docs khác trong receipt (không sửa `docs/**`).
4. Regression: jest 59+ xanh (thêm case flag), build/typecheck; **không gỡ file/renderer nào**.

## Lease

- **Sở hữu:** `shell-server.ts` (flag), `apps/admin-web/README.md`, `tests/**` (case mới), `coordination/**` receipt.
- **KHÔNG sửa:** renderer cũ (`shell-render.ts`, section renderers), `components/ui/**`, `styles/**`, `app-shell/**`; migrations/contracts; `server.ts`, `main.ts`; `tasks/**`, `docs/**`. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb08prep-per-route-flag-2026-10-04.md`.

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978`. Dispatch 2026-10-04 14:12.
