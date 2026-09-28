# OpenAPI descriptions (P1-03, code-derived, human-readable)

Status: `[ ]` P1-03 stays unchecked. This file is prose derived route-by-route
from `services/orchestrator/src/server.ts` and
`services/connector/src/http/server.ts` with schema names from
`packages/contracts/src/*`. There is a machine-readable companion,
`docs/21-openapi.json` (OpenAPI 3.0.3), but there is still NO request/response
example validator, so the P1-03 acceptance
("Validator checks request/response examples, pagination/status/auth")
is not met. Anything listed as ABSENT below has no route in the code
and must not be treated as an offered contract. The two files drift apart:
this file is the prose of record and carries the nuance, `docs/21` is the
parameter list. Where they disagree, this file is correct and `docs/21` is a
defect — reported in D-EVID-A22, not silently reconciled.
Conventions: auth `x-api-key` = tenant caller (fail-closed R08-01);
`Authorization: Bearer <adminToken>` = admin; `Bearer <runtimeToken>` =
worker; `Bearer <usageToken>` = connector usage identity. Problem shape
`{type,title,status,code,detail,correlationId,errors?}`.

## 1. Public surface (orchestrator server.ts)

| Method + path | Auth | Request schema | Success | Errors | Source |
|---|---|---|---|---|---|
| GET /health, GET /api/v1/health | none | none | 200 `{status:ok,db,redis,activeLeases}`; 503 `{status:degraded,...}` | 503 degraded | server.ts 315-341 |
| POST /api/v1/businesses/:id/actions/:action | x-api-key | SubmissionSchema (contracts operations.ts 204) + Idempotency-Key header, X-Correlation-Id | 202 `{operationId,state,stateVersion,replayed,correlationId,links}`; 200 replayed | 400 undeclared action; 401; 403 unauthorized action (PRF-01); 404 no active version; 409 idempotency conflict; 422 schema | server.ts 559-589; submission.ts 61,86,90,116,144,235,239 |
| GET /api/v1/operations?limit&cursor&state&tenant&id&sort | x-api-key; admin bearer is an alternate auth path on the **same** contract (ADM-UX-02) | allow-listed, **six** names: `limit` 1-100 default 20 (clamped, never 422), `state` UI enum RUNNING/COMPLETED/FAILED/TIMED_OUT, `tenant` exact id, `id` case-insensitive substring, `cursor` keyset token, `sort` `<field>:<direction>` over the 6-value allow-list. Parsed by `parseOperationsListQuery` — **not** by a zod schema (see note below) | 200 `{items: OperationView[], nextCursor, prevCursor, total, limit}`; `total` = COUNT(*) of the **filtered** population | 401; 403 `tenant` outside caller scope; 422 invalid `state`/`tenant`/`id`/`cursor`/`sort` | **symbols** (numeric ranges go stale — see note 5): `server.ts` `parseOperationsListQuery`, `parseOperationsListSortParam`, `bindOperationsCursor`, `listOperationsPage`; `contracts/public-api.ts` `OPERATIONS_LIST_QUERY_PARAMS`, `OPERATIONS_LIST_SORT_*`, `parseOperationsListSort` |
| GET /api/v1/operations/:id?wait=<s> | x-api-key | wait seconds, polls to terminal max 30s | 200 OperationView (facade.ts 32) | 401; 404 cross-tenant | server.ts 602-616; facade.ts 32,66 |
| GET /api/v1/operations/:id/result | x-api-key | none | 200 ResultEnvelope `{schemaVersion,data,artifacts,usage,warnings}` (operations.ts 165) | 401; 404; 409 not SUCCEEDED; 410 expired | server.ts 619-643; facade.ts 95 |
| POST /api/v1/operations/:id/cancel | x-api-key | optional reason | 202; 200 replayed | 401; 404; 409 terminal | server.ts 646-652 |
| POST /api/v1/operations/:id/resume | x-api-key | resume body (CAS expectedStateVersion) | 202; 200 replayed | 401; 404; 409 stale/terminal; 422 invalid | server.ts 656-663 |
| GET /api/v1/usage/summary?from&to | x-api-key | from/to ISO query (required) | 200 UsageSummary `{tenantId,from,to,rows[],totals}` rows by provider/model, unattributed bucket | 401; 422 missing from/to | server.ts 361-371; usage.ts 62-120 |
| GET /api/v1/connectors/:id/test | x-api-key | none; no caller headers forwarded, no upstream body echoed | 200 `{connectorId,ok,latencyMs}` | 401; 404 unknown connector; 502 CONNECTOR_UNHEALTHY/UNAVAILABLE | server.ts 378-385; connectors.ts 49-80 |

Operations-list contract (ADM-UX-02, extended by W-ADMUX02-SORT-ALLOWLIST-1). The five-field envelope, the direction-bearing cursor and the allow-listed query parameters are also documented in docs 06 §GET /operations. Five properties are load-bearing and easy to mis-state.

1. `state` on the wire accepts **only** the UI enum `RUNNING|COMPLETED|FAILED|TIMED_OUT`; a machine state such as `QUEUED` is a 422, and each UI value is expanded server-side into a set of wire states (`RUNNING` covers seven).
2. `total` is a `COUNT(*)` over the filtered population, never `items.length`, and it does not vary with the sort — reordering a set does not resize it.
3. The cursor carries **its own direction and its own ordering** in the base64url payload `<ISO>|<uuid>|<field>:<direction>[|p]` — four slots at most. The trailing `p` is the backward marker, because the route exposes a single `?cursor=` parameter and a previous-page link would otherwise be indistinguishable from a forward one. The third slot **names the ordering the position belongs to** (`created_at:desc` when `?sort=` is absent): the same `(key, id)` pair is a different page boundary in every sort, so a position that does not carry its ordering cannot be trusted. Legacy tokens `<ISO>|<uuid>` and `<ISO>|<uuid>|p`, minted before the sort parameter existed, still decode and read as `created_at:desc` — the only order they could ever have named — so every pre-existing deep link pages exactly as before.
4. `sort` is validated by `parseOperationsListSort` in contracts, which the route calls rather than re-implementing, so the published schema and the route cannot disagree about what a legal sort is. The allow-list is `OPERATIONS_LIST_SORT_FIELDS` (`created_at`, `updated_at`, `deadline_at`) x `OPERATIONS_LIST_SORT_DIRECTIONS` (`asc`, `desc`), giving exactly six wire values; an absent or empty `sort` is `created_at:desc`, the pre-parameter order. Parsing trims, lowercases and splits on the **last** colon, so a value carrying an extra colon is rejected rather than truncated into something that passes; anything else outside the allow-list is 422 `INVALID_SCHEMA` and never a silent fallback to the default. The `ORDER BY` column comes from a lookup keyed by the already-validated field, so caller text is never SQL text. `deadline_at` is the one nullable column: its key is COALESCEd over an **inline literal sentinel** (`'0001-01-01T00:00:00.000Z'::timestamptz` for `desc`, `'9999-12-31T23:59:59.999Z'::timestamptz` for `asc`) — a Const node written into the ORDER BY text itself, never a bound `$n` placeholder: migration 0019's four expression indexes match only this exact Const form (the parameterised shape degraded to Seq Scan + Sort with all four indexes dead, measured by T-35 and reconfirmed in the W-INGEST-0019-2 review); the value comes from a compile-time constant keyed by the already-validated direction, never caller text; and the cursor predicate reuses the same string, so ORDER BY and keyset boundary cannot diverge. The sentinel keeps NULLs at the END of the walk because a row-value keyset predicate is never true against NULL — without it page 1 is correct and every deadline-less operation silently disappears from page 2 onward, behind a 200 and a plausible-looking page.
5. The Source column for the operations rows cites **symbols, not line numbers**. `server.ts` was 3,086 lines at 13:2x and 3,101 within the same hour while its owner worked on T140-A1, so a numeric range in this table is a statement about a tree state that no longer exists. Docs 06 already made the same call for the same reason.

**MISMATCH T140-A1 — RESOLVED IN SOURCE, live acceptance still OPEN (D-EVID-A27, after Reviewer Turn 180). The token does now carry the sort identity, and the route refuses a mismatch.** `decodeOperationsListCursor` splits the payload on `|` into two to four parts, pops a trailing `p` as its own part (it is not a legal `field:direction`, so the two shapes cannot be confused), and parses what remains through `parseOperationsListSort`; a token with no ordering slot is a pre-sort token and reads as the default. `parseOperationsListQuery` then throws **422 `INVALID_SCHEMA`** when `decoded.sort.field !== sort.field || decoded.sort.direction !== sort.direction`, with a message naming both orderings and the remedy (drop `cursor` to start the new ordering at its first page). Rejected rather than ignored on purpose: a caller that changes sort and still sends a cursor to keep paging would silently receive page 1 of the new order, which reads as a loop to the caller and as a normal page to the operator. A malformed cursor — non-uuid id, ISO that does not round-trip, empty slot, two ordering slots, unknown `field:direction`, longer than `LIST_CURSOR_MAX_LEN` (128) — is **also** 422 `INVALID_SCHEMA`, never a silent fall back to page one. `bindOperationsCursor` is unchanged: it still compares `(sortKeySql, id)` against `($N::timestamptz, $M::uuid)`; what changed is that a mismatched cursor is refused before it is bound.
**The OPEN paragraph this replaces is preserved as history and is not rewritten as acceptance.** Re-reading the source during D-EVID-A22 found no sort field inside the token and no rejection path — that was the finding, and Reviewer Turn 140 raised it as T140-A1 (owner contracts/Platform/Admin UI), requiring the policy be settled **before** documentation wording is treated as contract. Packet `W-ADMUX02-SORT-CURSOR-BIND-1` answered it in source; the wire policy above was read directly out of `services/orchestrator/src/server.ts` (`encodeOperationsListCursor`, `decodeOperationsListCursor`, `parseOperationsListQuery`, `parseOperationsListSortParam`, `bindOperationsCursor`) and `packages/contracts/src/public-api.ts` (`OPERATIONS_LIST_SORT_FIELDS` = `created_at`/`updated_at`/`deadline_at`, `OPERATIONS_LIST_SORT_DIRECTIONS` = `asc`/`desc`, `OPERATIONS_LIST_SORT_VALUES`, `parseOperationsListSort`, `formatOperationsListSort`, `LIST_CURSOR_MAX_LEN`) — **not copied from the Reviewer**. The evidence level is unchanged by the fix: Turn 180 adjudicates T140-A1 as **IMPLEMENTED, offline VERIFIED, live acceptance OPEN** — no live receipt yet for a cross-sort 422, a legacy token, a six-sort walk, or a query plan on the new sorts, and the three offline suites (`operations-list-cursor-sort-binding`, `admin-operations-sort-wiring`, `admin-keyset-explain`) carry 55 literal `it`/`test` declarations of which 8 sit inside `.each` blocks, so declaration count is not the executed count. T140-D1 stays PARTIAL: the current-review pointer and the current-state prose are repaired, live acceptance is not.
**MISMATCH CLOSED (D-EVID-A15, after W-CONTRACT-ALIGN-1 / Reviewer Turn 80).** The drift recorded here earlier is gone: `packages/contracts/src/public-api.ts` now **owns** this contract and the route **imports** it. Canonical exported symbols, all verified in source: `OPERATIONS_LIST_QUERY_PARAMS` (the five names `limit, cursor, state, tenant, id` — the comment states this array *is* the allow-list, not a hint), `OPERATIONS_LIST_LIMIT_DEFAULT` (20) and `OPERATIONS_LIST_LIMIT_MAX` (100), `LIST_CURSOR_MAX_LEN` (128, shared with the admin shell), `OPERATIONS_STATE_FILTER_VALUES` + `OperationsStateFilterSchema` (the operator enum), `OPERATIONS_STATE_FILTER_WIRE_STATES` (the expansion to wire states, `RUNNING` covering seven), `OPERATIONS_LIST_TOKEN_PATTERN` / `OPERATIONS_LIST_SOLID_HEX_PATTERN` / `isOperationsListFilterToken()`, the strict request schema `ListOperationsQuerySchema` and the strict five-field response schema `OperationsListPageSchema`, plus the builder `operationsListPage()`. `server.ts` imports those values and emits through `operationsListPage({...}) satisfies OperationsListPage`, so no producer can hand-shorten the envelope. Two supersessions are deliberate: `pageOf()` was **deleted** rather than kept for compatibility, because it advertised the replaced two-field envelope and had **zero** consumers; and `PageQuerySchema` is retained but is explicitly documented as the **generic** cursor+limit page request, **not** the operations-list schema — so the symbol named in this file's request column is no longer the right citation. Divergence is locked in both directions by test: a mutation is caught, and reading a parameter outside `OPERATIONS_LIST_QUERY_PARAMS` is now a **compile error** through the `AllowListedQuery` seam rather than a silent accept.
**SUPERSEDED IN PART (Reviewer Turn 140, D-EVID-A22). The A15 paragraph above is preserved as accepted history and is not rewritten.** What changed is the array it quotes: `OPERATIONS_LIST_QUERY_PARAMS` is now **six** names, not five — W-ADMUX02-SORT-ALLOWLIST-1 appended `sort`, with `OPERATIONS_LIST_SORT_FIELDS`, `OPERATIONS_LIST_SORT_DIRECTIONS`, `OPERATIONS_LIST_SORT_VALUES`, `OPERATIONS_LIST_SORT_DEFAULT_FIELD`/`_DIRECTION`/`_DEFAULT`, `OPERATIONS_LIST_NULLABLE_SORT_FIELDS` (route-side) and the shared `parseOperationsListSort()` / `formatOperationsListSort()` joining the export surface. A15 remains correct about everything it was scoped to — the five-parameter operations contract it reviewed — and the `AllowListedQuery` compile-error seam it credited now also covers `read("sort")`. The drift Turn 140 raised as **T140-D1** is precisely this: A15 was accepted, the contract then grew a parameter, and the documents did not follow. Δ36 stays CLOSED at A15 scope; T140-D1 is a **new** finding, not a reopening of A15.

ABSENT on public surface (in docs 06 but no route in server.ts):
GET /api/v1/businesses, GET schema, POST /docs/{action} facade,
POST /api/v1/artifacts, GET /api/v1/artifacts/{id} metadata. Do not publish
as contract until implemented.

**`GET artifact metadata/download` left this list in D-OPENAPI-ENC-RESULT (2026-09-28); the `download` half of that entry was wrong.** `server.ts` implements `GET /api/v1/artifacts/:id/download` (CR-12/MM-02) with the two RESULT-WIRE-01 variants — 200 raw bytes plus the artifact MIME, or 200 JSON `{schemaVersion, encrypted, delivery, artifactId, mimeType}` — and `docs/21-openapi.json` now carries that path together with the delivery schemas. The `metadata` half is still absent: no `GET /api/v1/artifacts/{id}` route exists in `server.ts`, so only `/download` left the list.

## 2. Admin surface (orchestrator server.ts)

| Method + path | Auth | Request | Success | Errors | Source |
|---|---|---|---|---|---|
| PUT /api/v1/admin/businesses/:id/versions/:version/enable | admin bearer | none | 200 `{businessId,version,ENABLED}` | 401; 404 unregistered version | server.ts 666-683 |
| PUT /api/v1/admin/businesses/:id/versions/:version/activate | admin bearer | none | 200/202 | 401; 404 | server.ts 690-696 |
| PUT /api/v1/admin/businesses/:id/versions/:version/deactivate | admin bearer | none | 200/202 | 401; 404 sole-version drain fail-closed | server.ts 702-708 |
| POST /api/v1/admin/profile-bindings | admin bearer | `{apiKey,profileId?,businessId,businessVersion,action,connectorBindings}` apiKey hashed, never stored raw | 201 revision | 401; 422 apiKey required / schema | server.ts 714-729 |
| POST /api/v1/admin/operations/sweep-deadlines | admin bearer | none (test/dev trigger) | 200 `{timedOut}` | 401 | server.ts 732-736 |

ABSENT on admin surface (in docs 07 under /api/internal/v1 but no route):
ABSENT on admin surface (in docs 07 under /api/internal/v1 but no route):
POST enable/drain/retire verbs, /profiles CRUD, /api-keys create/revoke,
/connectors proxy CRUD, /usage pages, replay. Base /api/internal/v1
itself has no route; real base is /api/v1/admin/*. Operator endpoints have
view-models only, no service route.

`/audit` has been removed from that ABSENT list and is now documented as present (D-EVID-A22). `GET /api/v1/admin/audit` exists (ADM-BASE-01, ADM-UX-02 extension W-ADMUX02-EXT-1) and reads the real ledger table `admin_audit_events` from migration 0010. It answers the **same five-field page envelope** as the operations list — `{items, nextCursor, prevCursor, total, limit}` — and the `{tenantId, events}` shape it used to return is gone. Its own allow-list is `limit`, `cursor`, `tenant`, `severity`, `action`; it does **not** accept `sort`, `state` or `id`, so its ordering remains created-at keyset. The tenant scope comes from the credential, never the query parameter alone: a platform principal may narrow to any tenant, a tenant operator is pinned to its own tenant and gets 403 on a foreign one, and a request with no tenant in scope returns an honest empty 200 page rather than platform-global rows. Events whose `tenant_id` is NULL (business enable/activate/drain, deadline sweep) never match a tenant predicate by design and belong to a future platform-wide view, not to any tenant pane. Live behaviour of this route is evidenced by T-CODEX-TEST-29 (11/11, exit 0); see `docs/28-test-inventory.md` §8.19.

## 3. Runtime surface (orchestrator server.ts)

All require runtime bearer (401 otherwise). Schemas in contracts runtime.ts.

| Method + path | Request schema | Success | Source |
|---|---|---|---|
| POST /api/runtime/v1/usage-events (connector identity, usageToken; 403 on wrong identity) | UsageEventSchema / UsageIngestBatchSchema (runtime.ts 248,265) | 200 ack `{accepted,duplicates}` | server.ts 348-356 |
| PUT /api/runtime/v1/businesses/:id/versions/:version | BusinessManifest | 201 created; 200 replay | server.ts 451-457 |
| PUT /api/runtime/v1/workers/:id/heartbeat | WorkerHeartbeatSchema (runtime.ts 13) | 200 `{health,leaseExpiresAt,capacity}` | server.ts 460-463 |
| POST /api/runtime/v1/tasks/:id/claim | ClaimTaskRequestSchema (runtime.ts 32) | 200 ClaimResult | server.ts 467-474 |
| POST /api/runtime/v1/tasks/:id/heartbeat | TaskHeartbeatRequestSchema (runtime.ts 92) | 200 ack | server.ts 478-484 |
| PUT /api/runtime/v1/tasks/:id/steps/:stepKey | SaveStepRequestSchema (runtime.ts 101) | 201; 200 replay | server.ts 489-495 |
| POST /api/runtime/v1/tasks/:id/progress | ProgressReportSchema (runtime.ts 117) | 200 {} | server.ts 499-505 |
| POST /api/runtime/v1/tasks/:id/complete | CompleteTaskRequestSchema (runtime.ts 159) | 200 | server.ts 509-515 |
| POST /api/runtime/v1/tasks/:id/fail | FailTaskRequestSchema (runtime.ts 165) | 200 retry or terminal | server.ts 519-525 |
| POST /api/runtime/v1/tasks/:id/children | SpawnChildrenRequestSchema (runtime.ts 131) | 202 | server.ts 529-535 |
| GET /api/runtime/v1/tasks/:id/children | none | 200 join view | server.ts 539-545 |
| POST /api/runtime/v1/tasks/:id/wait-input | WaitInputRequestSchema (runtime.ts 144) | 200 waitId | server.ts 549-555 |
| POST /api/runtime/v1/tasks/:id/artifacts | ArtifactUploadGrantRequestSchema (runtime.ts 187) | 201 grant | server.ts 388-395 |
| POST /api/runtime/v1/artifacts/:id/finalize | ArtifactFinalizeRequestSchema (runtime.ts 202) | 200 READY | server.ts 399-404 |
| POST /api/runtime/v1/artifacts/:id/access | ArtifactAccessRequestSchema (runtime.ts 208) | 200 grant | server.ts 408-416 |
| POST /api/runtime/v1/tasks/:id/invocation-grants | InvocationGrantRequestSchema (runtime.ts 227) | 201 grant; 503 unconfigured; 409 lease/binding/hash conflicts | server.ts 421-428 |
| PUT /api/runtime/v1/artifacts/blob/:key?grant= ; GET same | raw bytes / grant query | PUT 204; GET 200 base64 octet-stream; 403 bad grant; 405 | server.ts 432-448 |

ABSENT on runtime surface (in docs 07 but no route):
GET /tasks/:id/context (execution snapshot). Do not publish until implemented.

## 4. Connector surface (services/connector/src/http/server.ts)

Service auth: connector:manage for /connectors*, connector:invoke otherwise;
health probes unauthenticated.

| Method + path | Request | Success | Errors | Source |
|---|---|---|---|---|
| GET /health/live | none | 200 `{ok:true}` | - | http/server.ts 80 |
| GET /health/ready | none | 200 `{ok:true}`; 503 not ready | 503 | http/server.ts 81-84 |
| GET /capabilities | service auth | 200 capability catalog | 401 | http/server.ts 85 |
| GET /connectors | service auth | 200 redacted revisions | 401 | http/server.ts 86-89 |
| POST /connectors | `{connectorId,adapter,config,credentialRef,state?}` | 201 redacted revision | 400 invalid fields | http/server.ts 90-111 |
| POST /invocations | InvocationRequestSchema (contracts connector.ts 27) | 200 completed; 202 pending; contract response (connector.ts 61) | 400; 401 grant; 403 binding; 409 hash/disabled/unknown; 429 quota; 502/504 provider | http/server.ts 122-129; errmap 216-240 |
| GET /invocations/:id | scoped auth | 200 state/result/usage | 404 | http/server.ts 112-121 |
| POST /invocations/:id/cancel | `{reason<=500 chars}` | 202 | 400 bad reason | http/server.ts 130-138 |
| POST /connectors/:id/credentials/rotate | `{secret}` write-only | 204 | 400 missing secret | http/server.ts 139-147 |
| POST /connectors/:id/disable | none | 204 | 401 | http/server.ts 148-152 |
| POST /connectors/:id/test | none | 200 `{ok,errorCode?}` | 401 | http/server.ts 153-156 |

Note: connector rotate/disable/revisions exist ONLY on the connector
service; the orchestrator proxies only the test probe (section 1), so they
are absent from the platform surface by design.

## 5. Machine-readable contract — reconciliation note (2026-09-28)

`docs/21-openapi.json` (OpenAPI 3.0.3) now exists and is **code-derived**
from `services/orchestrator/src/server.ts`,
`services/connector/src/http/server.ts` and `packages/contracts`.
It covers public / admin / runtime / connector surfaces listed in §1-4.
Previous prose "no openapi.yaml/json exists" is superseded.

Reconciliation vs prose (§1-4 and `docs/06`):

| Check | Result |
|---|---|
| `GET /api/v1/artifacts/{id}/download` | **200** (raw bytes / encrypted JSON), no 302 — synced with [06-public-api.md](06-public-api.md) and [09-system-architecture.md](09-system-architecture.md) §5 |
| `GET /api/v1/operations` sort | 6-value allow-list (`created_at`/`updated_at`/`deadline_at` × `asc`/`desc`), `sort` binding + cursor `field:direction` slot — synced |
| `GET /api/v1/operations` error `UNSUPPORTED_STORAGE_BACKEND` (422) | Documented at submission layer ([06](06-public-api.md) + [09](09-system-architecture.md) §1) |
| `POST /api/v1/businesses/{id}/actions/{action}` | Canonical generic path present |

Remaining open for P1-03 acceptance: request/response **example validator**
(pagination / status / auth) and live verification of new sort / cursor
binding — see `docs/21-openapi.json` description and
[06b-api-spec-overview.md](06b-api-spec-overview.md) §7 checklist.
Run `npx @redocly/cli lint docs/21-openapi.json` and `jq '.paths | keys'`
to cross-check drift.
