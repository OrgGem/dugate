# Dispatch spec — AWEB-07 Identity / Security / Settings (2026-10-04 13:52 +07)

## Nguồn

- Plan: `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` — slice **AWEB-07** (deps `AWEB-02/03` ✓; ACUI-00/02/03/08/09, LOCAL/OIDC, DATA/ENC/DEP).
- AWEB-00 inventory: `/admin/crypto-config` LW (POST có handler+CSRF); local auth mode chưa mount (F8); settings/deployment adapters chưa có.

## Việc cần làm (real-first, honest states)

1. **Security screen (`/admin/web/security`)**: crypto-config read + write qua BFF (CSRF, session fence, no-store; giữ semantics POST hiện có) — nếu upstream đủ để hiển thị trạng thái thật; không hiển thị secret.
2. **Identity screen (`/admin/web/identity`)**: session/principal hiện tại + **auth mode hiển thị thật** (`local|oidc|both` khi đọc được từ session/policy; chưa mount → honest "auth mode: chưa managed" + note LOCAL-00/LOCAL-03); user/session list CHỈ khi backend có (thiếu → unavailable + owner LOCAL/OIDC).
3. **Settings/Deployment screen (`/admin/web/settings`)**: catalog theo source/desired/effective revision **chỉ khi adapter thật**; chưa managed → `requires deployment action` + hướng dẫn deploy; **không nút Save giả** (theo plan §1).
4. States `loading/ready/empty/error/denied`; nav link; browser evidence (stub cho các route có thật; cases honest-unavailable); regression 53+ xanh.

## Lease

- **Sở hữu:** `bff/**` (tiếp, thêm `bff/security.ts` nếu cần), `lib/api/**`, `routes/**`, `features/{security,identity,settings}/**` (mới), `tests/browser/admin-web/**`, test focused mới.
- **KHÔNG sửa:** `components/ui/**`, `styles/**`, `app-shell/**`; migrations/contracts/openapi; `server.ts`, `main.ts`; `tasks/**`, `docs/**`. Không commit.

## Deliverable

- Receipt: `coordination/reports/aweb07-identity-security-settings-2026-10-04.md` — route/state matrix, real-vs-unavailable từng mục, gaps owner (LOCAL/OIDC/DEP).

## Lane

- **cc_1** — `term_b89fe355-f097-4f25-90bd-98720a3ed978`. Dispatch 2026-10-04 13:52.
