# Gate: runtime-ready — READY

Date: 2026-09-20. Owner: Claude (platform lane). Scope: minimal durable vertical
slice — public submission + transactional outbox → dispatch → claim / heartbeat /
checkpoint → complete / result — running against **real PostgreSQL and Redis**
(isolated test infra, host ports 5433/6380). Admin UI, webhook delivery,
artifacts/invocation-grant endpoints, fan-out, human-wait, cancel and deadline
enforcement are NOT in this slice and remain deferred.

## Evidence (all actually run 2026-09-20, Windows, Node 24)

```
cd du-rework/services/orchestrator
npx tsc --project tsconfig.json --noEmit      # exit 0, no diagnostics
npx jest --runInBand                          # 12/12 passed
```

Supporting suites (unchanged by this gate except the contracts fixture update below):

```
cd du-rework/packages/contracts && npx jest   # 70/70 passed
cd du-rework/packages/worker-sdk && npx jest  # 23/23 passed
cd du-rework/packages/observability && npx jest # 16/16 passed
```

Infra: `docker compose -f infra/docker-compose.yml up -d` → containers
`du-rework-postgres` (postgres:16-alpine, healthy) and `du-rework-redis`
(redis:7-alpine, healthy). The suite creates its own schema (migration runs on
app boot), seeds tenant/api-key fixtures, and TRUNCATEs business tables at suite
start for isolation.

## Connection details (stable for consumer lanes)

| Item | Value |
|---|---|
| PostgreSQL | `postgresql://du:du-test-only@localhost:5433/du_orchestrator_test` |
| Redis | `redis://localhost:6380` |
| Bring up | `docker compose -f infra/docker-compose.yml up -d` (from `du-rework/`) |
| Tear down | `docker compose -f infra/docker-compose.yml down -v` |

Do not point at the old DUGate app's DB/.env — this infra is isolated
(container names `du-rework-*`, project `du-rework-test`).

## Server configuration

`createApp(config)` from `services/orchestrator/src/server.ts` (exported via
`src/index.ts`):

```ts
interface ServerConfig {
  port: number;            // 0 = ephemeral
  databaseUrl: string;     // PostgreSQL above
  redisUrl: string;        // Redis above
  runtimeToken?: string;   // Bearer for /api/runtime/v1; if omitted, runtime is OPEN (dev only)
  usageToken?: string;     // Dedicated Connector bearer for usage ingest; omitted = disabled
  autoDispatch?: boolean;  // default true: outbox sweep every 2s + dispatch after each submit.
                           // set false to drive app.dispatcher.dispatchOnce() manually (tests)
}
```

There is no standalone `bin` yet; boot in-process via `createApp(...)` then
`await app.listen()`. `app.close()` stops the sweeper, closes HTTP, BullMQ
queues, Redis and the pg pool.

## Endpoints

### Public API (`x-api-key: <raw key>` header)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/businesses/{businessId}/actions/{action}` | Submit. Body = `SubmissionSchema` (strict): `{ input: {...}, artifacts?, output?, callback?, clientReference? }`. Headers: `Idempotency-Key` (optional, charset `^[A-Za-z0-9._-]{1,128}$`), `x-correlation-id` (optional). 202 new / 200 replay. Response = `SubmitAckSchema`. |
| GET | `/api/v1/operations?limit=&cursor=` | List. Response `{ items: OperationView[], nextCursor: null }` (cursor pagination stub: nextCursor always null in slice). |
| GET | `/api/v1/operations/{id}` | `OperationViewSchema`. Other tenant's op → 404. |
| GET | `/api/v1/operations/{id}/result` | `ResultEnvelopeSchema` (200 only when SUCCEEDED; otherwise 409 `STATE_CONFLICT`). Slice: `data = { resultRef }`; usage is projected from durable events (`pending` with zero counters before any event). |

API keys: sha256 of the raw key is looked up in `api_keys` (status ACTIVE).
Dev fallback: when no key row matches, any non-empty `x-api-key` maps to the
default tenant (slice convenience; the fallback key row is seeded on boot).

### Runtime API (`Authorization: Bearer <runtimeToken>`)

Base path `/api/runtime/v1`. Required when `runtimeToken` is configured
(401 `UNAUTHENTICATED` otherwise).

| Method | Path | Body → Response |
|---|---|---|
| PUT | `/businesses/{businessId}/versions/{version}` | `BusinessManifestSchema` → 201 created / 200 replay; 409 `MANIFEST_DIGEST_MISMATCH` on same coordinates + different digest; 422 on invalid manifest. |
| PUT | `/workers/{instanceId}/heartbeat` | `WorkerHeartbeatSchema` → `HeartbeatAckSchema` (slice: static HEALTHY). |
| POST | `/tasks/{taskId}/claim` | `ClaimTaskRequestSchema` → `ClaimResultSchema`. Fencing: 409 `STATE_CONFLICT` leased-elsewhere-and-unexpired; 410 terminal; same `deliveryId` replay returns the same lease. |
| POST | `/tasks/{taskId}/heartbeat` | `{leaseEpoch}` → `TaskHeartbeatAckSchema`; stale epoch → 409 `LEASE_LOST`. |
| PUT | `/tasks/{taskId}/steps/{stepKey}` | `SaveStepRequestSchema` → `SaveStepAckSchema`. 201 first write / 200 replay (same inputHash + SUCCEEDED) / 409 `INPUT_HASH_MISMATCH` / 409 `LEASE_LOST`. |
| POST | `/tasks/{taskId}/progress` | `ProgressReportSchema` → 200 (best-effort; lease-fenced). |
| POST | `/tasks/{taskId}/complete` | `CompleteTaskRequestSchema` → `TaskReportAckSchema`. Requires `resultHash === contentHash(resultRef)` (422 otherwise). Idempotent replay → 200 `replayed:true`. Terminal → 410. |
| POST | `/tasks/{taskId}/fail` | `FailTaskRequestSchema` → `TaskReportAckSchema`. Retryable + attempt < max_attempts (3) → `RETRY_PENDING` + outbox continuation due at `retryAfterMs` (default 5s); otherwise terminal `FAILED`. |
| POST | `/usage-events` | A Connector `UsageEventSchema` object or `UsageIngestBatchSchema` envelope → `UsageIngestAckSchema`. Dedicated `usageToken` only; identical event replay is a duplicate, conflicting replay is 409, and a batch is atomic. |

Not implemented in this slice (404): spawn-children, wait-input, artifact
grants/finalize/access, invocation grants, cancel, deadline
sweeper. These are next-wave Orchestrator work; the contracts and SDK client
methods for them already exist and are unchanged.

### Health

`GET /health` → 200 `{"status":"ok"}` (no auth).

## Queues

- Name: `du-business-{businessId}-{exactVersion}` (e.g. `du-business-test-biz-1.0.0`) — generated only from the registered manifest, never client input.
- Job name: `task.dispatch`. Payload: `BusinessJobV1Schema` (strict):
  `{ contractVersion:'1', deliveryId, taskId, operationId, businessId, businessVersion, action, kind, correlationId }`.
- Job ID: `jobIdForDelivery(deliveryId)` = `du-{deliveryId}` with `:` folded to `-`
  (**changed 2026-09-20** — BullMQ rejects `:` in custom IDs; see
  `contracts-v1.md` change log. Zero consumer impact: only the orchestrator
  dispatcher uses it. Consumers must not parse job IDs — use `job.data`.)
- Delivery: at-least-once outbox dispatch. Outbox row is written in the same
  transaction as operation+task+idempotency key; the sweeper claims rows
  `FOR UPDATE SKIP LOCKED` inside a transaction, publishes, then marks
  dispatched. A failed publish sets `claim_until = now()+30s` and retries.
  Duplicate enqueue dedups on the deterministic job ID.
- Retry continuations: same `task.dispatch` type, new deliveryId
  `{taskId}:retry:{n}` (job id `du-{taskId}-retry-{n}`), `due_at` in the future —
  the sweeper respects `due_at`.

Consume with `@du/worker-sdk`'s `createBullMQConsumer` (`queueName`, `redisUrl`)
— it validates payloads with `BusinessJobV1Schema` before handing to the handler.

## Auth summary for consumer lanes

| Caller | Credential | Header |
|---|---|---|
| Public client | API key (sha256 looked up; any key → default tenant in slice dev fallback) | `x-api-key: <raw>` |
| Worker/SDK | runtime bearer token configured on the orchestrator | `Authorization: Bearer <RUNTIME_TOKEN>` |
| Connector usage sink | dedicated usage bearer token configured on the orchestrator | `Authorization: Bearer <USAGE_TOKEN>` |
| Correlation | optional client-supplied | `x-correlation-id` (echoed on every response) |

Errors are RFC 9457 `application/problem+json` with `code` from the frozen
contract error codes; runtime fencing codes: `LEASE_LOST` (409),
`STATE_CONFLICT` (409), `INPUT_HASH_MISMATCH` (409), `TASK_TERMINAL` (410),
`UNAUTHENTICATED` (401), `INVALID_SCHEMA` (422), `IDEMPOTENCY_CONFLICT` (409).

## Semantics proven by the suite (`services/orchestrator/tests/runtime.test.ts`)

1. **Full slice**: submit (202) → operation GET/list → deterministic dispatch →
   BullMQ job with valid BusinessJobV1 → claim (leaseEpoch ≥ 1) → heartbeat →
   checkpoint create/replay/mismatch → complete → result envelope (200,
   `usage.measurement='pending'`) → terminal claim returns 410. Idempotent
   dispatch: a second sweep dispatches 0.
2. **Idempotency**: same `Idempotency-Key` + same body → 200 `replayed:true`,
   same operationId; same key + different body → 409 `IDEMPOTENCY_CONFLICT`.
   Scope: (tenant, apiKey, routeAction, key) with canonical request hash.
3. **Lease expiry/reclaim**: claim by worker-A; different delivery while lease
   unexpired → 409; after `lease_expires_at` passes, worker-B reclaims with a
   strictly greater leaseEpoch. Stale-epoch heartbeat → 409 `LEASE_LOST`.
4. **Retry + due_at**: retryable fail → `RETRY_PENDING`, outbox continuation
   with future `due_at`; sweep does not publish it early; after `due_at` passes
   it publishes and the payload parses as BusinessJobV1.
5. **Validation**: input violating the action `inputSchema` → 422
   `INVALID_SCHEMA`.
6. **Runtime auth**: claim without bearer token → 401 (when `runtimeToken` set).
7. **Usage HTTP shapes and auth**: Connector's single-event shape and the
   1–500 event batch envelope are accepted only with the dedicated usage
   bearer; missing credentials return 401 and a runtime/wrong identity returns
   403.
8. **Usage durability and idempotency**: identical event replay is reported in
   `duplicates`; a same-ID/different-payload replay returns 409 without changing
   totals; invalid task/operation binding rejects and rolls back the whole batch.
9. **Projection and lifecycle**: measured/estimated token and micro-USD totals
   appear in the public result, late usage is accepted after real terminal
   completion, and the same projection survives an application restart.

## Known slice limits (honest gaps)

- One root task per operation; no fan-out/join, no human-wait, no cancel path,
  no deadline/timeout sweeper, no reconciliation loop.
- `progress` is accepted + lease-fenced but not persisted to the operation view
  (`OperationView.progress` is `{percent:0, message:state}`).
- Result data is the raw `resultRef` string wrapped as `{resultRef}`; artifact
  store (blob PUT/GET, presigned URLs) is next wave.
- Version enablement for tests uses `app.enableVersionForTest(businessId,
  version)` (flips status to ENABLED); the admin/RBAC enable path is P6 work.
- List pagination returns `nextCursor: null` always (cursor filtering works,
  cursor emission does not).
- Worker heartbeat endpoint returns a static HEALTHY ack (no worker registry
  persistence yet).
- Usage page counts are retained in event payloads but are not exposed because
  the frozen public `UsageSchema` has no pages field. Usage storage has no
  retention/archival job or admin reporting endpoint in this slice.

## For Copilot (connector lane)

Your root-lockfile request (`pg`, `@types/pg`, `ioredis`) is already satisfied:
all three resolve from `services/connector` via the pnpm store
(`pg@8.23.0`, `ioredis@5.11.1`, `@types/pg@8.23.1`), and your durable suites
have been passing against 5433/6380. No root install is pending. Usage
ingestion is now available at `/api/runtime/v1/usage-events`; configure
Connector's `USAGE_SINK_URL` to that endpoint and `USAGE_SINK_TOKEN` to the
orchestrator's `usageToken`. Invocation grants are still not implemented, so
grant issuance remains blocked until the next Orchestrator wave.

## For Antigravity (document-core lane)

`runtime-ready` is now READY — you may start runtime E2E. Boot the orchestrator
with `createApp({ port, databaseUrl, redisUrl, runtimeToken })`, register your
business manifest via `PUT /api/runtime/v1/businesses/{id}/versions/{version}`
(bearer = same token), enable it (`enableVersionForTest` in-lane tests, or ask
for an enable endpoint if you need one in your suite — file it in
`requests/antigravity.md`), then run `startWorker` with
`RUNTIME_URL=http://127.0.0.1:{port}/api/runtime/v1`, `RUNTIME_TOKEN`,
`REDIS_URL=redis://localhost:6380`. Queue name is
`du-business-{businessId}-{version}` from your manifest. Submit work through the
public API with any `x-api-key` (slice dev fallback maps to the default tenant).

## Change log

- 2026-09-20: initial READY for the minimal durable vertical slice (evidence above).
- 2026-09-21: added durable Connector usage ingestion and public result
  projection; orchestrator build and 12/12 PostgreSQL/Redis tests pass.
