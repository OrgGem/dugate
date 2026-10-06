# Dispatch spec — AWEB-03b Overview graft + component diff review (2026-10-04 12:05 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-03** (phần integrator).
- Contract: `docs/admin-ui-development-contract.md` §3 (component/màn), §5 (review), §6.2-6.3.
- Tiền đề: AWEB-01 ✓ VERIFIED; AWEB-02 ✓ (BFF `/admin/api/{session,audit,actions}`, fence ACUI-M07); AWEB-03a ✓ (primitives + fixtures của Antigravity, receipt `aweb03a-components`); browser harness tái dùng ở `tests/browser/admin-web/**` (cc_2).
- Coordinator chốt open Q của AWEB-02: **giữ một switch `DU_ADMIN_WEB`** cho cả static mount + BFF (không tách `DU_ADMIN_API`).

## Việc cần làm (AWEB-03b)

1. **Review độc lập diff component của Antigravity** (trước khi ghép, theo contract §5): props contract, dependency, fixture, a11y, token dùng đúng 1 nguồn; finding ghi vào receipt (nếu có) — không tự sửa file component (lease Antigravity); nếu cần sửa → báo coordinator.
2. **Ghép màn Overview read-only** vào shell mới (`/admin/web`):
   - Dùng primitives `@/components/ui` + `lib/api` (AWEB-02);
   - Dữ liệu thật theo tenant: bắt buộc **audit list** qua BFF `/admin/api/audit` (đã có); session card; các tile usage/operations nếu backend chưa expose → hiện trạng thái honest (`unavailable`/`requires backend`) — **không dữ liệu giả**;
   - Đủ state `loading/ready/empty/error/denied`; `401` → link login; `403` → denied; lỗi mạng → error có retry.
3. **Browser evidence**: tái dùng harness `tests/browser/admin-web/**` (cc_2 đã làm) — thêm case 401/403/320px cho Overview; ghi literal `npx playwright test` + screenshot vào `coordination/evidence/aweb03b/`.
4. Build + typecheck xanh; regression so baseline như các packet trước.

## Lease

- **Sở hữu:** `services/orchestrator/src/app/admin/shell-server.ts` + `src/app/admin/bff/**`, `apps/admin-web/src/lib/api/**`, `apps/admin-web/src/routes/**`, `apps/admin-web/src/features/**` (mới), `tests/browser/admin-web/**` (bổ sung case), test focused mới.
- **KHÔNG sửa:** `apps/admin-web/src/components/ui/**`, `src/styles/**`, `src/app-shell/**` (Antigravity); `server.ts`; `packages/contracts/**`; `tasks/**`, `docs/**`.
- Không commit; không đụng container user.

## Sau packet này

- Coordinator gọi **Antigravity review UI** cho route `/admin/web` (packet review riêng theo contract §5) — chưa phải bước của lane này.

## Deliverable

- Receipt: `coordination/reports/aweb03b-overview-graft-2026-10-04.md` — component-review findings, quyết định ghép, commands literal, browser evidence path, gaps.

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978`. Dispatch 2026-10-04 12:05.
