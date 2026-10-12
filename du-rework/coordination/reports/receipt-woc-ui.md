# WOC11 admin UI receipt

The WOC11 admin UI is implemented in `orchestrator/apps/admin-web`. The business detail view now keeps business intake enablement separate from the default-version pointer and renders worker inventory under each version. The profile screen keeps standalone profiles available and adds a platform-admin profile-group editor for whole-group create, replace, reload, and rollback.

Business enablement uses the lifecycle revision CAS BFF route. Worker counts are displayed only when measured; accepted-task scope and its epoch are explained, active leases are compared with capacity, and backlog remains version-scoped. Profile groups preserve business/version/manifest/function identity, use selected-version function catalogs, disable unavailable descriptors with their reason, and reuse the existing active API-key selector, policy editor, and connector pins. Core endpoint choices come from the selected manifest catalog; workflow choices are its declared action IDs. Connector navigation links use React Router so the app's `/admin/` basename is applied. No provider credentials, backend contracts, migrations, or key configuration were changed in this UI scope.

Group list and read requests do not send an API-key ID. The server resolves the effective active root-tenant key from current child memberships; the returned `group.apiKey` hydrates the editor. Group create and full-replacement writes use the selected existing API key. Rollback sends only `targetRevision` and `expectedRevision`. The browser fixture used one active key and did not exercise revoked-key-to-replacement rotation; rotation behavior remains outside this UI smoke.

`@du/contracts` was already declared as `workspace:*` in `orchestrator/apps/admin-web/package.json`; this change made no package or lockfile edits.

## UI files

- Modified `orchestrator/apps/admin-web/src/features/businesses/business-detail-cockpit.tsx`
- Modified `orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx`
- Modified `orchestrator/apps/admin-web/src/features/businesses/state.ts`
- Modified `orchestrator/apps/admin-web/src/features/profiles/initial-bindings.tsx`
- Modified `orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx`
- Added `orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx`
- Added `orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts`
- Modified `orchestrator/apps/admin-web/src/lib/api/client.ts`
- Modified `orchestrator/apps/admin-web/src/lib/api/index.ts`
- Modified `orchestrator/apps/admin-web/src/lib/api/types.ts`
- Modified `orchestrator/apps/admin-web/tests/business-services-integration.test.mjs`
- Added `orchestrator/apps/admin-web/tests/profile-group-api-client.test.mjs`
- Added `orchestrator/apps/admin-web/tests/profile-group-state.test.mjs`
- Added `orchestrator/apps/admin-web/tests/fixtures/woc11-browser-fixture.mjs`

## Validation

- Focused UI tests: `node --experimental-strip-types --test orchestrator/apps/admin-web/tests/profile-group-state.test.mjs orchestrator/apps/admin-web/tests/profile-group-api-client.test.mjs orchestrator/apps/admin-web/tests/business-services-integration.test.mjs` — 9 passed, 0 failed. Raw output: `coordination/reports/raw/woc-ui-focused-tests-2026-10-12.txt`.
- Typecheck: `pnpm --filter @du/admin-web typecheck` — passed. Raw output: `coordination/reports/raw/woc-ui-admin-typecheck-2026-10-12.txt`.
- Production build: `pnpm --filter @du/admin-web build` — passed. Vite reported existing browser externalization warnings for `node:crypto` imports from `@du/contracts` and a 2.14 MB minified JS chunk warning. The built UI then started in headless Chrome without page errors. Raw output: `coordination/reports/raw/woc-ui-admin-build-2026-10-12.txt`.
- Connector-link repair: changed only the two leased links to React Router `Link` components targeting `/connectors`, allowing router `basename=/admin` to resolve the mounted route correctly. Typecheck/build and the 9 focused tests above were rerun after this change.
- Fixture syntax: `node --check orchestrator/apps/admin-web/tests/fixtures/woc11-browser-fixture.mjs` — passed. Raw output: `coordination/reports/raw/woc-ui-fixture-syntax-2026-10-12.txt`.
- Full admin-web suite: `node --experimental-strip-types --test` from `orchestrator/apps/admin-web` — 122 tests, 96 passed, 26 failed. The failures are in untouched suite areas: 22 operations tests fail with `TypeError: Cannot read properties of undefined (reading 'trim')` at `src/features/operations/state.ts:182:30`; one `tests/orv14-settings-full-ui-owner.test.mjs:87:3` assertion expects `/connectorsTenantId === tenantId/`; and three `tests/workflow-simulation-honesty.test.mjs` tests fail with `ReferenceError: workflow is not defined` in their `createSimulationResult` eval. These are recorded as unresolved suite failures; no baseline attribution is made. Raw output: `coordination/reports/raw/woc-ui-full-tests-2026-10-12.txt`.

## Headless browser smoke

Command: `node C:\Users\Gem\AppData\Local\Temp\woc11-playwright-smoke.mjs`. It launched a fresh disposable headless Playwright/Chrome context against the built UI and the local fixture started by `node orchestrator/apps/admin-web/tests/fixtures/woc11-browser-fixture.mjs` at `http://127.0.0.1:4178/admin/`. The fixture served only in-memory mock session, business, worker, API-key, connector, catalog, group, and CAS responses. It made no requests to a real backend, provider, or production environment. This is a mocked browser UI smoke, not backend E2E.

The smoke verified two workers nested under business A v1 and one under v2, worker status/health/count/running-capacity display, separate default-version and business enable actions, version-specific Core endpoint and declared workflow catalogs, an unavailable function disabled with a reason, multi-business group create/save/reload with an existing key and connector pin, a business disabled while the editor was open, and stale group revision handling. The intended stale write returned 409; the UI retained the draft and reloaded the complete current group. Browser `pageErrors` was empty. The fixture used one active key and does not verify key rotation. This remains a mock-only UI smoke, not backend E2E.

Raw browser log: `coordination/reports/raw/woc-ui-browser-smoke-2026-10-12.txt`.

Screenshots:

- `coordination/reports/raw/woc-ui-browser-businesses-2026-10-12.png`
- `coordination/reports/raw/woc-ui-browser-profile-group-2026-10-12.png`
- `coordination/reports/raw/woc-ui-browser-profile-group-cas-2026-10-12.png`

## Connector-link browser repair check

After rebuilding, started the local in-memory fixture with `node orchestrator/apps/admin-web/tests/fixtures/woc11-browser-fixture.mjs` and ran `node coordination/reports/raw/woc-ui-connector-link-browser-smoke-2026-10-12.mjs` in a fresh headless Chrome context. The script clicked `Manage connectors` from Initial connector bindings and `Connectors screen` from a selected function in the Profile Group editor. Both navigations rendered the Connectors screen at `/admin/connectors`, and the browser recorded no page errors. The fixture provided in-memory mock APIs only; the flow did not invoke a provider or a real backend.

Raw output: `coordination/reports/raw/woc-ui-connector-link-browser-smoke-2026-10-12.txt`.

Screenshots of each rendered destination:

- `coordination/reports/raw/woc-ui-connector-link-initial-bindings-2026-10-12.png`
- `coordination/reports/raw/woc-ui-connector-link-profile-group-2026-10-12.png`

SHA-256 hashes for the UI files, receipt, logs, and final screenshots are in `coordination/reports/raw/woc-ui-sha256s-2026-10-12.txt`.
