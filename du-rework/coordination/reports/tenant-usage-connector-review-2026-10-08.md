# Independent review — tenant roster / usage 422 / connector knownConnectorIds (2026-10-08)

**Task:** independent review of the three frontend/BFF fixes in `du-rework` (review only).
**Reviewer:** OC lane (read-only). **Compliance:** no file modified, no commit, no push; this receipt
is the only artifact written. Scope: `du-rework` only.
**Method:** source reading with exact file:line, then re-running the focused suites on Node **v24.21.0**
(`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64`) from the package directories; raw logs under
`coordination/reports/raw/tenant-usage-connector-review-2026-10-08/`.

**Overall verdict: 3/3 fixes PASS** (no FAIL findings). Four advisory/coverage notes in §5. This is a
review verdict only — no ACCEPTED tick, no ledger change.

## 1. Tenant roster + selection — PASS

| Question | Verdict | Evidence |
|---|---|---|
| Tenant operator sees exactly its own row, not others | **PASS** | Scope is derived from the credential: route `admin.ts:413-431` calls `authorizeAuditTenantRead(principal, '')` (`admin.ts:419`) → tenant operator returns its own `tenantId` (`rbac.ts:71-83`, foreign id → 403 at `:79-81`). I re-ran `tenant-list-bff-offline.test.ts:173-191`: operator query with a **foreign** `tenantId` still yields 1 row and the upstream request is exactly `/api/v1/admin/tenants?limit=10` with the tenant bearer. |
| Platform sees the whole roster | **PASS** | `scope === ''` → `listTenantPage(db, null, …)` (`admin.ts:420`), no WHERE clause (`tenant-list.ts:123`), full page. Test `tenant-list-bff-offline.test.ts:145-171` asserts 2 rows + `total: 2` with the platform bearer. |
| Scope in SQL or JS post-filter | **PASS (SQL)** | `tenant-list.ts:117-138`: scope becomes a bound parameter in the WHERE clause (`if (scope !== null) clauses.push('id = ' + bind(scope))`, `:123`); the count is scoped too (`:153-156`). Rows are returned straight from the query — there is **no JS row filter** after fetch. |

## 2. Cursor / keyset — PASS (one LOW note, §5.1)

| Question | Verdict | Evidence |
|---|---|---|
| Can a tenant read another tenant's cursor to switch scope? | **PASS — scope unchanged** | The scope clause is always ANDed with the cursor boundary (`tenant-list.ts:129-136`), so returned rows stay inside the credential's scope; `total` also stays scoped (`:153-156`). A foreign boundary can only produce an empty page. See §5.1 for the one-bit ordering observation. |
| SQL injection through limit/cursor | **PASS** | `limit`: `parseInt` then clamp 1..`ADMIN_LIST_LIMIT_MAX` (`tenant-list.ts:83-87`), bound as `$n` (`:133`). Cursor: strict canonical base64url + UUID regex (`:55-71`), parsed allow-list `['limit','cursor']` only (`:79-97`, contract `public-api.ts:623`), bound as `$n::uuid` (`:130-131`). Operators (`>`/`<`) come from a boolean, never from input. |

## 3. BFF — PASS

| Question | Verdict | Evidence |
|---|---|---|
| Forward `tenantId`/`sort` from the browser query? | **PASS — no** | `TENANT_PARAM_ALLOWLIST = ['limit','cursor']` (`handle.ts:73`) is the only set copied to upstream (`handle.ts:419-422`). Test asserts the exact upstream path with `tenantId`/`sort` dropped: `tenant-list-bff-offline.test.ts:166-170` (platform) and `:186-190` (operator, even when the caller sends a foreign `tenantId`). |
| Secret echo | **PASS — no** | `relayUpstream` re-serializes the parsed body and sets its own headers; upstream response headers are never copied (`upstream.ts:140-176`). Errors are sanitized: non-5xx keeps only a regex-checked code + bounded field errors (`envelope.ts:58-86`), 5xx collapses to a fixed 502 with no upstream text (`envelope.ts:64-65`). Tenant wire is exactly `{id,name,state}` (`tenant-list.ts:166-168`, contract `.strict()` `public-api.ts:627-633`). Credential selected by principal only (`upstream.ts:67-73`); viewer/unscoped 403 before upstream (`handle.ts:398-407`, test `:134-143` with zero upstream requests). |

## 4. TenantSelect — PASS

| Question | Verdict | Evidence |
|---|---|---|
| NAME or raw UUID | **PASS — names** | Options render `tenant.name` (state suffix when not ACTIVE) — `tenant-select.tsx:137-140`; IDs are internal values only (`:116`, `:120-121`), and the trigger uses the base-ui `SelectValue` (`select.tsx:8`), which renders the selected item's label (the name), not the raw value. |
| "All" where it must not exist | **PASS** | Issue-API-key usage passes **no** `allowAll` (default false, `tenant-select.tsx:40`) — `api-keys-screen.tsx:198-204`; the issue button is disabled until a tenant is chosen (`:213`). Usage grants All only to platform sessions (`usage-screen.tsx:94`) and selecting All nulls the tenant → Load disabled + explicit alert (`:112-114`). Operations/secrets/security pass `allowAll` intentionally (platform-wide read surfaces, `operations-screen.tsx:159`, `secrets-screen.tsx:320`, `security-screen.tsx:115`). |
| Load failure state | **PASS** | `loadState==='failed'` → placeholder “Tenant list unavailable”, `role="alert"` text, select disabled; a value not present in the loaded roster resolves to `null`, so no raw UUID is ever shown (`tenant-select.tsx:89-100`, `:124`, `:148`). |

## 5. Usage — PASS (one adjacency, §5.4)

| Question | Verdict | Evidence |
|---|---|---|
| Any path left for a platform session to call usage without `tenantId`? | **PASS — no data path** | BFF route: empty scope → 422 `usage requires a tenantId for platform sessions` **before** upstream (`operations.ts:216-219`); all other principals: unscoped is 403 earlier (`:100-103`), operator falls back to own scope / foreign → 403 (`rbac.ts:79-81`). UI: Load disabled + alert (`usage-screen.tsx:112-114`), auto-load guard `:46`. Tests: `aweb06-bff-operations.test.ts:279-286` (platform no-tenant → 422 + **zero** upstream requests), `:288-297` (operator own scope + foreign 403), `:299-311` (from/to required, then `tenantId` forwarded). Upstream defense-in-depth: `public.ts:189-193` requires `tenantId` for admin principals (422 otherwise). |

## 6. Connector `knownConnectorIds` — PASS (mandatory condition met)

| Question | Verdict | Evidence |
|---|---|---|
| URL/header/secret leakage | **PASS — IDs only** | Route returns `Object.keys(ctx.config.connectorBaseUrls ?? {})` and the three booleans only (`admin.ts:573-584`, `:581`). Contract is `.strict()` booleans + `z.array(z.string().min(1))` and documents “no configuration values” (`connector-management.ts:48-56`). Frontend parser is strict on the exact key set and validates each id as a non-empty string (`state.ts:97-102`, `:153-165`); suggestions come from capabilities when management is off (`state.ts:168-178`, screen `connectors-screen.tsx:283`, datalist `:492-494`). Test injects a URL with userinfo + query token into the config and asserts the response equals the exact ID-only body **and** `JSON.stringify(response)` contains neither `private.example` nor `do-not-leak` (`p745-connector-management-proxy.test.ts:175-200`), plus the empty/composed variants (`:202-216`). BFF relays verbatim (test `bff-connectors-actions.test.ts:359-371`). No URL/header/credential field exists in the capability schema or the route body. |

## 7. Test quality — PASS

- **No skipped/TODO**: 0 hits for `test.skip|xit|describe.skip|TODO|FIXME` across the four suites and
  `usage-screen-offline.cjs`; the only `.skip` hit in the Playwright spec is an assertion about
  skipped **rows** of the reader (`connectors-wire.spec.ts:218`), not a skipped test.
- **Assertions are real**: exact upstream request paths + bearer (`tenant-list-bff-offline.test.ts:166-170`,
  `:186-190`), zero-upstream assertions for denials (`:142`, `aweb06…:285,296,303`), exact bodies
  (`p745…:189-197`, `bff-connectors-actions…:363-371`), URL/credential negative strings
  (`p745…:198-199`), UI props/call-count invariants (`usage-screen-offline.cjs:55-79`), screen source
  wiring checks (`connectors-wire.spec.ts:111-113`).
- **Re-run evidence (Node v24.21.0, exit codes literal):**

| # | Command (package cwd) | Result | Exit |
|---|---|---|---|
| 1 | `pnpm exec jest --runInBand --runTestsByPath tests/tenant-list-bff-offline.test.ts tests/aweb06-bff-operations.test.ts` (orchestrator/services/orchestrator) | 2 suites / **15 passed** | **0** |
| 2 | `pnpm exec jest --runInBand --runTestsByPath tests/p745-connector-management-proxy.test.ts tests/bff-connectors-actions.test.ts` (same cwd) | 2 suites / **29 passed** | **0** |
| 3 | `node orchestrator/services/orchestrator/tests/usage-screen-offline.cjs` (du-rework) | UI harness PASS (platform gating, selection, All guard, prefill/lock) | **0** |
| 4 | `pnpm exec tsc --noEmit -p tsconfig.json` (orchestrator/apps/admin-web) | clean | **0** |
| 5 | `pnpm exec tsc --noEmit -p tsconfig.json` (orchestrator/services/orchestrator) | clean — **the earlier receipt caveats are resolved** (usage receipt's missing-export error and connector receipt's `handle.ts:403` error no longer reproduce on this tree) | **0** |
| 6 | `pnpm exec playwright test --config admin-web/playwright.config.ts admin-web/connectors-wire.spec.ts` (tests/browser) | **17 passed** | **0** |

Raw logs + `SHA256SUMS.txt`: `coordination/reports/raw/tenant-usage-connector-review-2026-10-08/`.

## 8. Advisory notes (no FAIL; none block the three fixes)

1. **LOW — cursor boundary subquery is unscoped** (`tenant-list.ts:131`): the `(SELECT lower(name) FROM tenants WHERE id = $cursorId)` reads the boundary tenant's name without the caller scope. Rows and counts stay fully scoped, but a caller who already knows a foreign tenant UUID can probe one ordering bit (own name vs that tenant's name) via empty/one-row pages. Hardening: append the scope predicate to the subquery (`… AND id = $scope`) when `scope !== null`.
2. **Coverage — no runtime test for the roster SQL/cursor module**: `listTenantPage` / `encode|decodeTenantListCursor` / `parseTenantListQuery` have no direct suite; the BFF test stubs the upstream (so scoping is proven for the BFF layer and by source reading, not against a real DB). Recommend a focused isolated-PG test for scope + cursor replay + over-limit clamp.
3. **Coverage — TenantSelect itself is untested**: `usage-screen-offline.cjs:10` mocks the component, and no component test exists (grep across `apps/admin-web` + `tests/browser` = 0 hits). Current behavior is source-reviewed PASS; a small render test for name labels + failed/empty states would lock the assertions made here.
4. **Adjacency — overview fetcher**: `overview-section-data.ts:627,630` can still build a tenant-less `/api/v1/usage` call for a platform overview window; the upstream then answers 422 (`public.ts:191-192`), so it degrades to the overview's error/unavailable triage with **no unscoped data**. This is outside the fixed BFF route/UI; noted for completeness only.

**Verdict: PASS / PASS / PASS** (tenant roster, usage 422, connector knownConnectorIds). No ACCEPTED
tick is claimed; acceptance remains with the coordinator/main verifier.

## Advisory progress — tenant-list SQL/cursor offline coverage (2026-10-08)

- Added `orchestrator/services/orchestrator/tests/tenant-list-cursor-codec-offline.test.ts`.
  It covers next/prev codec round-trips (line 94), long-name exclusion from the opaque token
  (line 100), cursor replay under a changed SQL scope and count parameter isolation (line 111),
  limit clamps (line 135), and forged-cursor rejection without throwing (line 141). Its fake DB
  evaluates the roster scope, `(lower(name), id)` boundary, ordering, and limit without PostgreSQL.
- Fail-first run from `orchestrator/services/orchestrator`:
  `node node_modules/jest/bin/jest.js --runInBand tests/tenant-list-cursor-codec-offline.test.ts`
  — **exit 1**, 1 failed assertion. The draft expected the cursor UUID twice in page params;
  inspection confirmed the SQL correctly reuses `$2`, so the test expectation was corrected.
- Re-run of the same command — **exit 0**, 1 suite / 6 tests passed.
- Scope for this progress: test plus this receipt only. No product source changed; no commit or
  push. This is owner smoke evidence and does not claim independent verification or acceptance.
