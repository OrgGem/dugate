# Dispatch spec — AWEB-06 Operations/Usage/Audit + Business/Workflow (2026-10-04 13:32 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-06** (deps `AWEB-02/03` ✓; ADM-UX, COST, ACUI-07, PAR-04/07/08, P9).
- Contract §3/§4 (states, fence, BFF); AWEB-00 inventory: operations read LW + actions SC (nút chưa nối), businesses LW (enable/activate/deactivate API riêng chưa có form), audit LW, usage real.

## Việc cần làm (real-first, honest states)

1. **BFF reads (session fence như AWEB-02)**: operations list/detail (+artifacts nếu có), usage, business registry + versions, workflow/schema catalog (nếu route backend có; thiếu → honest unavailable). Allow-list query như AWEB-05; tenant ép từ session; không platform bearer cho operator/viewer.
2. **UI**:
   - `features/operations`: list/detail server-side (cursor/filter/sort), cancel/resume/replay **chỉ bật khi backend capability thật** (hiện chưa nối → disabled + lý do, không nút giả); artifact/usage phản ánh state thật.
   - `features/businesses` (+ workflow/schema nếu có dữ liệu): list/versions read; action enable/activate/deactivate chỉ khi có API + capability.
   - Route chưa có backend → state `unavailable` rõ (`requires backend`), không mock.
3. Đủ state `loading/ready/empty/error/denied`; link từ Overview.
4. **Browser evidence**: mở rộng harness (stub operations/business/usage) — cases: ready/empty/error/denied, action disabled honest, 320px; build/typecheck/regression (46+ jest cũ xanh).

## Lease

- **Sở hữu:** `services/orchestrator/src/app/admin/bff/**` (tiếp), `apps/admin-web/src/lib/api/**`, `src/routes/**`, `src/features/{operations,businesses,usage}/**` (mới), `tests/browser/admin-web/**`, test focused mới.
- **KHÔNG sửa:** `components/ui/**`, `styles/**`, `app-shell/**` (Antigravity); migrations/contracts/openapi (backend single-writer); `server.ts`, `main.ts`; `tasks/**`, `docs/**`. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb06-operations-business-2026-10-04.md` — route/state matrix, evidence literal, backend gaps ghi owner (P9/PAR/P2).

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978` (Admin UI integrator). Dispatch 2026-10-04 13:32.
