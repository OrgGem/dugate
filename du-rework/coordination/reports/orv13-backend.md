# UI13-BACKEND implementation receipt

**Status:** IMPLEMENTED; initial source freeze was followed by a VFY-driven scoped correction and refreeze at 2026-10-11 17:59 UTC. Independent VFY rerun is pending; this remains an owner receipt, not independent verification or acceptance.

**Scope:** Added the `BASIC_ADMIN_USAGE_V1` tenant-scoped persisted UsageEvent page through `GET /api/internal/usage/events` and BFF `GET /admin/api/usage/events`; typed `listUsageEvents` and `deleteOperation(operationId, idempotencyKey)` client methods; cursor-paginated tenant roster loading with generation fencing and retry/error state that retains the last tenant scope after transient failures. The rich public usage exporter remains unchanged. No COST provenance is synthesized.

**Frozen usage contract:** Query requires `tenantId`, ISO `from`, and `to`; supports `timeField=receivedAt`, `limit` 1–100 (default 50), `cursor`, `operationId`, and a paired `provider` + `model`; the window is at most 366 days. The opaque cursor is bound to tenant, window, clock, page size, and filters. The BASIC-only tie key is `(received_at, SHA-256(UTF-8 event_id))`; no raw or unbounded event ID is carried in the cursor. Cursor timestamps come from PostgreSQL's six-digit UTC rendering so keyset progress preserves `timestamptz` microseconds. The page promises `receivedAt` ascending; the rich public exporter retains its separate `(timestamp,event_id)` ordering and cursor. `AdminUsageEventPage` contains `tenantId`, `events`, `limit`, `hasMore`, optional `nextCursor`, `skippedInvalidEvents`, and `timeSemantics: {field:'receivedAt',order:'asc',timezone:'UTC'}`. `AdminUsageEventRecord` contains `eventId`, `operationId`, `taskId`, `invocationId`, nullable `provider`/`model`, `units`, nullable `costMicrousd`, nullable `costStatus` (`measured|estimated|unpriced`), `measurement`, ISO `occurredAt`, and `receivedAt`. A missing cost field or cost status stays null. Row attribution not present on the persisted wire is omitted.

**Authorization:** The internal read accepts only an internal-ingress GET. Trusted bearer auth retains its resolved platform/tenant principal. Cookie sessions are never elevated from role: admin/operator/viewer can read only with a server-bound tenant ID and are scoped as a tenant operator; tenantless cookies fail closed. Tenant mismatch and cursor mismatch are rejected before SQL. SQL binds the tenant through `operations` and verifies task identity.

**Owner checks (2026-10-11, UTC):**

- `cd /workspace/dugate/du-rework/orchestrator/services/orchestrator && ./node_modules/.bin/jest --runInBand --runTestsByPath tests/orv13-backend-usage-events.test.ts tests/orv13-usage-cursor-live.test.ts` — PASS, 7/7 owner tests; the separately gated live-PG suite was skipped in this run. Covers projection, null cost behavior, tenant-fenced keyset SQL, cursor binding/progress across malformed IDs, ISO final DTO validation, malformed-row diagnostics, query/window validation, bearer and cookie role/scope policy. Raw output: [malformed-projection-and-cursor-jest.txt](raw/orv13-backend/malformed-projection-and-cursor-jest.txt).
- `cd /workspace/dugate/du-rework/orchestrator/services/orchestrator && ./node_modules/.bin/tsc --noEmit -p tsconfig.json` — PASS; exit 0. Raw output: [orchestrator-typecheck.txt](raw/orv13-backend/orchestrator-typecheck.txt).
- Initial `admin-web` typecheck — BLOCKED by concurrent UI source errors in Operations and System Operations; this historical result was superseded by the later backend and cockpit typecheck passes documented in the [Compose backend receipt](orv13-compose-backend.md). The blocked raw log remains at [admin-web-typecheck.txt](raw/orv13-backend/admin-web-typecheck.txt).
- The root `pnpm --filter` test invocation was not used for evidence because this environment's pnpm wrapper attempted dependency recreation and stopped on ignored build scripts. Focused verification used the already-installed package-local binaries above.

**Historical open gate:** The original consumer/VFY handoff preceded later UI source and typecheck completion. Current backend acceptance remains subject only to the follow-up independent verification described below.

## VFY-UI13 correction and refreeze

Independent VFY reported that three persisted malformed rows (event ID over 128 characters, invalid provider attribution, and a `Date.parse`-valid non-ISO `occurredAt`) caused the BFF page to return 502 instead of returning HTTP 200 with `skippedInvalidEvents: 3`. VFY separately reproduced duplicate first-row pagination on real PostgreSQL at `limit=1`; its reported red does not specify exact receive timestamps. The original BFF red is retained in [the VFY main harness log](../../reports/raw/orv13-vfy/admin-ui/main-harness.log); the actual-PG repeated-page assertion is retained in [the VFY admin UI test](../../tests/workflow-api/orv13-vfy-admin-ui.test.ts:372). The owner-added live fixture uses `.000001`, `.000002`, and `.000003` timestamps, but this workspace could not connect to PostgreSQL. Independent VFY is preparing its own microsecond case. These findings remain pending independent rerun; the source corrections do not convert them into acceptance evidence.

The final BASIC DTO is now `safeParse`d, and invalid final rows increment `skippedInvalidEvents` and are omitted. `occurredAt` uses the DTO's ISO datetime validator. BASIC pagination uses the fixed SHA-256 tie key and exact six-fraction cursor timestamp described above; the rich public export path and shared rich cursor schema are unchanged. The unit regression covers all three malformed cases and malformed-boundary cursor progress.

Owner recheck on 2026-10-11:

- Focused owner Jest: PASS, 7 tests; raw output [malformed-projection-and-cursor-jest.txt](raw/orv13-backend/malformed-projection-and-cursor-jest.txt).
- Orchestrator TypeScript check: PASS; raw output [malformed-projection-typecheck.txt](raw/orv13-backend/malformed-projection-typecheck.txt).
- A live-only PostgreSQL fixture was added at `tests/orv13-usage-cursor-live.test.ts`; it checks core `sha256(bytea)`, inserts three disposable rows with microsecond-spaced `received_at`, and asserts three unique pages. The attempted local run could not connect to `localhost:5433`; it is environment-unavailable and not a pass. Raw attempt: [usage-cursor-live-jest.txt](raw/orv13-backend/usage-cursor-live-jest.txt). Independent VFY owns the actual isolated-PostgreSQL rerun.

Refrozen source hashes:

- `orchestrator/services/orchestrator/src/modules/usage/usage.ts`: `68277ad4a9dc4a872d47cbb5eeb95d9ba44ac2311edfd898872d4ebaaaa22349`
- `orchestrator/services/orchestrator/tests/orv13-backend-usage-events.test.ts`: `e19eb179fba95e8b499a60b5eefef63cd78ab40630d889f837f35d1157cc1bc9`
- `orchestrator/services/orchestrator/tests/orv13-usage-cursor-live.test.ts`: `e91f606221a4adbbbc22588ec4af35f7077f00237751989a1742c2af0ca21bbd`

**Open gate:** Independent verifier is rebuilding the refrozen source and will rerun the original BFF malformed-row 502 plus a full-page actual-PostgreSQL microsecond pagination case before backend acceptance. No Compose source, shared client, API surface, or deployment files changed in this correction.
