# Dispatch spec — AWEB-02 BFF foundation (2026-10-04 11:42 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-02**.
- Contract: `docs/admin-ui-development-contract.md` §4 (BFF + an toàn) — nguồn interface chính.
- Tiền đề: AWEB-01 DONE (`reports/aweb01-admin-web-bootstrap-2026-10-04.md`) — mount `/admin/web` sau session gate, flag `DU_ADMIN_WEB`, toàn bộ thay đổi trong `shell-server.ts`.

## Việc cần làm (AWEB-02)

1. **`/admin/api/session`** (đề xuất, theo contract §4): trả principal hiển thị, role, phạm vi tenant, CSRF token; `Cache-Control: no-store`. Session/tenant/assignment kiểm trên **mỗi request**; không lấy tenant scope/assignment từ query/body.
2. **Typed read/mutation client** trong `apps/admin-web/src/lib/api/**`: đọc session, mang `X-CSRF-Token` cho mutation, `expectedRevision` khi có, idempotency key; map lỗi `401/403/409/422/5xx` thành error envelope.
3. **Error envelope** thống nhất (JSON) + client decoder typed (không `any`).
4. **Principal/tenant fence cho read path của app mới** — xử lý `ACUI-M07` cho `/admin/api/*`: BFF phải kiểm session-scope, **không dùng platform bearer** cho operator/viewer; test hai tenant: operator tenant A không đọc B qua browser **và** gọi API trực tiếp.
5. **Route thử**: cập nhật route bootstrap đọc session thật qua client (direct URL/reload/login/logout vẫn xanh).
6. Token/bundle: không đưa `adminToken`/Vault token vào bundle/HTML/log; authenticated responses `no-store`.

## Lease

- **Sở hữu:** `services/orchestrator/src/app/admin/shell-server.ts` + module mới dưới `src/app/admin/bff/**` (nếu tách), `apps/admin-web/src/lib/api/**`, `apps/admin-web/src/routes/**`, test focused mới dưới `services/orchestrator/tests/**` (file mới).
- **KHÔNG sửa:** `server.ts`, `packages/contracts/**`, `apps/admin-web/src/styles/**`, `src/components/**`, `src/app-shell/**` (Antigravity), `tasks/**`, `docs/**`; không chạm file lane khác.
- Single-writer: chỉ lane này giữ `shell-server.ts` trong lúc chạy.

## Acceptance (theo plan)

- 401/403/409/422 đúng; viewer/operator không mượn platform scope; operator tenant A không đọc B (browser + API trực tiếp); token không có trong bundle/HTML/log. Focused test + typecheck xanh; ghi literal output.

## Deliverable

- Receipt: `coordination/reports/aweb02-bff-foundation-2026-10-04.md` (commands/evidence, file:line, tenant-fence matrix, ACUI-M07 status, open items).

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978` (Admin UI integrator, tiếp nối AWEB-01). Dispatch 2026-10-04 11:42.
