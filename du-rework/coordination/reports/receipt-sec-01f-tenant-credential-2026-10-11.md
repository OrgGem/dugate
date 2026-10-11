# SEC-01F tenant credential fetchers receipt

Date: 2026-10-11
Scope: du-rework
Lease: `orchestrator/services/orchestrator/src/app/admin/section-dispatch.ts` and one dedicated offline test
Status: implementation complete; independent verification pending

## Changes

- Added a fail-closed credential guard for the Businesses section. A viewer or an operator without a mapped tenant credential receives HTTP 403 before a fetch runs.
- Tenant operators now load the business catalog from `GET /api/v1/admin/tenants/:tenantId/businesses` using the tenant ID and bearer credential from the live session. The rendered catalog escapes all upstream values and supports the route cursors. Platform admins retain the existing global businesses fetcher and platform token.
- Audit reads now require a resolvable platform or tenant credential. Tenant operators pass the session tenant through the audit fetch input and the outgoing `tenantId` query parameter; a query-supplied tenant cannot widen their scope. Platform admins retain the platform token and existing query behavior.
- Profiles, connectors, and API keys resolve credentials through the shared helper. Their admin-only access and platform token behavior remain unchanged.
- Added `orchestrator/services/orchestrator/tests/sec-01f-tenant-credential-fetchers-offline.test.ts` for tenant route fencing, audit tenant pinning, pre-fetch denials, platform-admin businesses behavior, and admin-only fetcher credentials.

## Verification

- `pnpm exec jest --runInBand --runTestsByPath tests/sec-01f-tenant-credential-fetchers-offline.test.ts` — PASS, 1 suite and 5 tests.
- `pnpm run typecheck` — PASS, exit 0.
- `pnpm exec jest --runInBand --runTestsByPath tests/sec-or-01-legacy-read-scope-offline.test.ts tests/admin-shell-live-pane.test.ts` — exit 0; the shell live-pane suite passed 6 tests and the SEC-01 suite was skipped by Jest.
- A supplemental run including `tests/admin-audit-route.test.ts` had 2 failures in that older suite. Those cases expect an operator session with no tenant mapping to reach the audit fetcher and return HTTP 200. SEC-01F intentionally denies that access with HTTP 403 before fetching. The existing audit test file is outside this lease and was not changed.
- Confirmed the new test and receipt contain zero ASCII double-quote characters. `git diff --check` reported no whitespace errors.

## Coordination boundary

The runtime inspection showed the active Codex terminal, but no request or dispatch ID was available. This receipt records implementation and owner-side smoke results only. SEC-01F remains pending independent verification and is not marked closed. No git add, commit, push, or gate action was performed.
