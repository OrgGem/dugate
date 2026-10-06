# Dispatch spec — AWEB-05 API Keys & Connectors slice (2026-10-04 12:22 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-05** (deps `AWEB-02/03` ✓ đã xong + verify).
- Contract §3/§4 + AWEB-00 inventory: `/admin/api-keys` = LW(list+issue+revoke), rotate/disable **BM**; `/admin/connectors`: projection giả + composition thiếu (F3) — readiness/test/revision thật còn thiếu; Vault thuộc PAR-03/14.

## Việc cần làm (real-first, honest states)

1. **BFF mở rộng** (cùng pattern AWEB-02): `GET /admin/api/api-keys` (list/by-id, principal-aware), `POST /admin/api/actions` (issue/revoke — đã có upstream), copy-once không lộ lại. Connector: `GET /admin/api/connectors/:id/revisions/:rev` (readiness/state), action test/rotate-secret khi upstream khả dụng.
2. **UI** (`features/api-keys`, `features/connectors`):
   - API keys: list + detail; issue → **copy-once** (một lần, `no-store`, không hiện lại sau reload); revoke có confirm; **rotate/disable**: hiện disabled kèm `requires backend` (F7) — không nút giả.
   - Connectors: list/detail + readiness/state; test/rotate: chỉ bật khi capability backend thật; thiếu composition (`connectorBaseUrls`/`credentialWorkflow`) → hiện `unavailable` rõ nguyên nhân.
   - Profile binding hiển thị read-only (binding list từ `admin.ts:151`).
3. Đủ state `loading/ready/empty/error/denied`; secret write-only; không đọc lại plaintext.
4. Browser evidence mở rộng harness (`tests/browser/admin-web/**`): copy-once chỉ hiện 1 lần; revoke flow; rotate/disable disabled; connector unavailable state; 320px.
5. Build + typecheck + regression như các packet trước.

## Lease

- **Sở hữu:** `services/orchestrator/src/app/admin/shell-server.ts` + `bff/**`, `apps/admin-web/src/lib/api/**`, `src/routes/**`, `src/features/api-keys/**`, `src/features/connectors/**`, `tests/browser/admin-web/**`.
- **KHÔNG sửa:** `components/ui/**`, `styles/**`, `app-shell/**` (Antigravity); `server.ts`; `packages/contracts/**` (nếu cần DTO mới → báo coordinator chốt lease); `main.ts` (đang có packet AWEB-02b riêng); `tasks/**`, `docs/**`. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb05-api-keys-connectors-2026-10-04.md` — route/state matrix, copy-once evidence, gaps backend (ghi rõ cái nào cần PAR-03/14), commands literal.

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978` (Admin UI integrator). Dispatch 2026-10-04 12:22.
