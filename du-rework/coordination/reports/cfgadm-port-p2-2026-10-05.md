# CFGADM-UI-PORT-P2 — Identity users and OIDC metadata

**Task:** CFGADM-UI-PORT-P2 / CFGADM-08  
**Owner:** codex_worker_1  
**Result:** UI implemented; offline/browser verification passed. Live BFF/service integration remains pending route registration.

## Delivered

- Replaced the legacy Identity placeholder with a safe user list, create form, role/status update form, and read-only OIDC metadata view in `apps/admin-web/src/features/identity/identity-screen.tsx:31`.
- Added a feature-local same-origin adapter in `apps/admin-web/src/features/identity/identity-api.ts:58`. It validates the response projection, keeps only the `ADMIN`/`USER`/`VIEWER` roles and safe user fields, sends `X-CSRF-Token`, idempotency keys, and `expectedVersion`, and never renders raw error or response bodies.
- UI writes require an admin session, `capabilities.userWriter === true`, and `local`/`both` auth mode. Create uses a write-only password field with `VIEWER` as the default role. Update supports role and enabled status; disable is the lifecycle action, with no hard-delete operation. A success message appears only after a fresh list read confirms the saved state/version.
- OIDC rendering is allowlisted to issuer, client ID, callback URL, and scopes. Unknown response properties (including test cipher/hash sentinels) are ignored. Missing metadata has an explicit empty state.
- Added browser coverage at `tests/browser/admin-web/cfgadm-08-identity-crud.spec.ts:23` for create/read/update and role change, OIDC metadata present/absent, secret non-disclosure, and fail-closed behavior when the writer capability is false.

## Verification

Environment: `D:\Git\dugate\du-rework`; Node `v22.16.0`; pnpm `10.18.3`; local Admin Web harness and Playwright Chromium. No database, Redis, external IdP, or live identity API was used. Browser CRUD success cases intercept the new wire contract; the existing harness still returns the honest unavailable state for the unregistered identity route.

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm --filter @du/admin-web typecheck` | exit 0 |
| Production build | `pnpm --filter @du/admin-web build` | 3 runs, all exit 0; 2668 modules transformed each run |
| CFGADM-08 browser cases | `node node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/cli.js test --config tests/browser/admin-web/playwright.config.ts --output <temp> cfgadm-08-identity-crud.spec.ts` | exit 0; 3 passed |
| Existing identity regression | same local CLI/config, `identity-security-settings.spec.ts --grep 'identity: real session'` | exit 0; 1 passed; preserves the “chưa managed” and owner LOCAL/OIDC state while the route is absent |

Final build SHA-256:

- `apps/admin-web/dist/assets/index-VXqFDc-c.js` — `91323B349FC141758790908FE51C47723AC07BA637BD73674723EA33BDE3250A`
- `apps/admin-web/dist/assets/index-BffJF1YL.css` — `BAF331D4EA62F3274FC1AC9E83EA049787FC7F786FAC6330FBF69DE3457BF021`

Raw final run log: `C:\Users\Gem\AppData\Local\Temp\cfgadm-port-p2-2026-10-05-final-run.txt` (typecheck, three builds, three browser cases, and identity regression; `2026-10-05 03:44:48`–`03:45:45 +07:00`). Screenshots are in `C:\Users\Gem\AppData\Local\Temp\cfgadm-08-identity-evidence-final\`.

Two transient verification issues were corrected before the final run: a decoder property access caught by typecheck, and an ambiguous Playwright text locator. The `pnpm dlx @playwright/test` setup attempt also stopped offline because its tarball was not cached; no download was made, and the final browser runs used the installed local Playwright CLI.

## Route-registration request for dsh_2 (A5)

Please register the following same-origin Admin BFF routes and add the typed `lib/api` client methods under the P3 lease:

1. `GET /admin/api/identity` returns `{ users, capabilities: { userWriter }, auth }`. Each user is a safe projection `{ id, username, role, enabled, locked, createdAt, updatedAt, version }`; `role` is exactly `ADMIN | USER | VIEWER`. `auth` is `{ mode: local | oidc | both | unmanaged, localEnabled, oidc }`, where `oidc` is `null` or `{ issuer, clientId, callbackUrl, scopes }`. Never return password hashes, password values, OIDC client secrets, tokens, or cipher fields. Derive tenant/scope from the trusted session, not the request body/query.
2. `POST /admin/api/identity/users` accepts `{ username, password, role }` and returns `{ user }` as the same safe projection. Hash the write-only password server-side, audit the actor from the trusted principal, enforce role/scope policy, CSRF, and idempotency.
3. `PATCH /admin/api/identity/users/:id` accepts `{ role, enabled, expectedVersion }` and returns `{ user }`. Enforce CAS (`409` on stale version), audit, and the existing session revocation policy for role/disable changes. The `ADMIN`/`USER`/`VIEWER` mapping must be explicit server-side; do not infer grants in the browser.

`userWriter: false` must be returned whenever the writer is not composed/available. The browser currently fails closed for that capability and for an unavailable route. The backend repository has local-user primitives but the Admin BFF has no Identity read/write route in this source snapshot, and its repository create method currently fixes the role to `admin`; therefore the successful CRUD browser cases verify the UI contract with intercepted responses, not a live writer.

No changes were made to `apps/admin-web/src/router.tsx` or `apps/admin-web/src/lib/api/**`. Antigravity §5 review and service/BFF integration are still required before route cutover or acceptance.
