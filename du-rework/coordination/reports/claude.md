# Coordination Report — Claude (platform lane)

## Status: IN_PROGRESS (gates published; orchestrator vertical slice next)

- Date: 2026-09-20
- Lane: Foundation/contracts + Orchestrator + worker-sdk + integration

## Gates published (READY, with executable evidence)

| Gate | Path | Evidence |
|---|---|---|
| contracts-v1 | `coordination/gates/contracts-v1.md` | `@du/contracts@0.1.0` — typecheck clean, **70/70 tests** (5 suites) |
| workspace-ready | `coordination/gates/workspace-ready.md` | root `pnpm install` — 8/8 projects, single lockfile, **351 packages** |
| sdk-ready | `coordination/gates/sdk-ready.md` | `@du/worker-sdk@0.1.0` — typecheck clean, **23/23 tests** |

Plus `@du/observability@0.1.0` — typecheck clean, **16/16 tests**.

Test commands (all actually run 2026-09-20, Windows, Node 24, pnpm 9):

```
cd du-rework/packages/<pkg> && npx tsc --noEmit -p tsconfig.json && pnpm test
```

## Completed tasks

- P1-01 root workspace scaffold + `pnpm install` (ADR-13 recorded in `docs/15-decisions.md`: pnpm chosen because npm rejects `workspace:*`).
- P1 `@du/contracts` v1: 11 modules — version, errors (RFC 9457), manifest + validator (digest/canonicalization), json-schema-guard, operations (state machines + DTOs), runtime (claim/lease/checkpoint/spawn/wait/complete/fail/artifacts/grants/usage), queue (BusinessJobV1 + naming), connector (invocation wire), sdk (dispositions), public-api (submit/page/webhook), hashing.
- P1 `@du/observability`: correlation context (ALS), redaction, structured JSON logger, bounded-label in-memory metrics.
- P4 `@du/worker-sdk`: defineBusiness, RuntimeClient (fencing + ambiguous-report semantics), DefaultTaskContext (step/spawn/wait/progress/artifacts/connector facades), connector-invoker transport, worker lifecycle (claim → handler → disposition → report, lease heartbeats, graceful shutdown), BullMQ consumer (compiled; live-Redis test planned in runtime gate).
- Root dependency resolution for both peer request lists (see workspace-ready gate for the two overrides + actions requested from Antigravity).

## Blockers / peer notes

- **Antigravity**: root install needed two overrides because `packages/document-kit/package.json` requests `@types/mammoth` (does not exist on npm) and `pdf-lib@^1.17.9` (latest is 1.17.1; emits `%PDF-1.7`, relevant to your 4 failing PDF-split assertions). Overrides unblock the install without touching your files — please update your manifest at your next edit (details in `workspace-ready.md`). Gates are now READY: you may adopt `@du/contracts` + `@du/worker-sdk` exports per `contracts-v1.md` module map (note: connector slots use `acceptedCapabilities: string[]`; `defaultLimits` has no `maxRetries`).
- **Copilot**: `contracts-v1.md` lists the exact connector-lane wire exports you asked for (`InvocationRequest/Response/Grant*`, `UsageEvent*` — all from `@du/contracts` root import). `pg`/`ioredis` will be added to the root lockfile once declared in `services/connector/package.json` (single-lockfile rule).

## Next (per WORKLOAD-REBALANCE-01)

1. P2 orchestrator vertical slice in `services/orchestrator/**`: submit/outbox → claim/heartbeat/checkpoint → complete/result (smallest durable path), with Postgres+Redis from isolated docker infra (`infra/`, host ports 5433/6380 — existing containers untouched).
2. Publish `coordination/gates/runtime-ready.md` with actual runtime API tests.
3. Cross-service E2E once consumer lanes report adoption against the same contract version.

## Failures encountered (transparency)

- Earlier worker-sdk compile failures after contract tightening (`TaskHeartbeatAck.leaseExpiresAt`, string `resultRef`) — repaired this session; all green now.
- Root install initially blocked by peer manifest version errors — resolved via root overrides (my lane), not peer edits.

## 2026-09-20 — runtime-ready published (WORKLOAD-REBALANCE-02/03 critical path)

Status: READY_FOR_INTEGRATION for the runtime vertical slice.

Completed this turn (all in Claude-owned paths):

- P2 minimal durable vertical slice in `services/orchestrator/**`:
  submit + idempotency + transactional outbox (single tx: operation, root task,
  submission key, outbox row) → outbox sweeper (`FOR UPDATE SKIP LOCKED` inside
  a tx, deterministic BullMQ job IDs, 30s claim-until retry, due_at respected)
  → runtime claim (deliveryId replay, lease fencing, epoch bump) / heartbeat /
  checkpoint (RUN-04 replay + INPUT_HASH_MISMATCH) / progress / complete
  (resultHash = contentHash(resultRef)) / fail (retry budget → RETRY_PENDING +
  continuation outbox row) → public operation GET/list/result.
- Fixed in passing: claim/fail `FOR UPDATE OF t` (PG rejects locking the
  nullable LEFT JOIN side), fail-continuation payload is now a full
  BusinessJobV1 (SDK strict-parses it), saveStep ack carries `stepKey`,
  list envelope is `{items,nextCursor}`, result envelope carries
  `usage.measurement`, dev-fallback api key row seeded (FK), dispatcher uses
  `jobIdForDelivery` from contracts.
- Contract fix (recorded in `contracts-v1.md` change log + module map):
  `jobIdForDelivery()` now returns `du-{deliveryId}` (`:` folded to `-`) —
  BullMQ 5 rejects `:` in custom job IDs, the old convention was unexecutable.
  Verified zero consumers outside the orchestrator dispatcher. Contracts dist
  rebuilt (`packages/contracts/dist` — consumers resolve the built package).
- Tests: `services/orchestrator/tests/runtime.test.ts` — 6 tests against the
  real isolated PG (5433) + Redis (6380) from `infra/docker-compose.yml`,
  suite-start TRUNCATE for isolation, `autoDispatch:false` + explicit
  `dispatchOnce()` for determinism. Covers full slice, idempotency
  (replay/409), lease expiry + reclaim + stale-epoch 409, retry due_at gating
  + continuation payload validity, 422 input validation, 401 runtime auth.
- Gate: `coordination/gates/runtime-ready.md` READY with exact endpoints,
  queues, auth/config, connection details, passing commands, and honest slice
  limits (no fan-out/human-wait/cancel/deadline/artifacts/grants/usage yet).

Commands + actual results (Windows, Node 24):

```
cd du-rework/services/orchestrator && npx tsc --project tsconfig.json --noEmit  # exit 0
cd du-rework/services/orchestrator && npx jest --runInBand                       # 6/6, 3 consecutive runs + 1 run on pristine volumes
cd du-rework/packages/contracts && npx jest                                      # 70/70
cd du-rework/packages/worker-sdk && npx jest                                     # 23/23
cd du-rework/packages/observability && npx jest                                  # 16/16
```

Peer notes:

- Copilot: your `pg`/`@types/pg`/`ioredis` root-lockfile request is already
  satisfied (resolves from `services/connector`: pg@8.23.0, ioredis@5.11.1,
  @types/pg@8.23.1); no root install pending. Invocation-grant + usage-ingest
  endpoints are NOT in this slice — that integration stays next-wave.
- Antigravity: runtime-ready is READY; E2E boot instructions are in the gate
  (register manifest via runtime PUT with bearer token, enable, startWorker
  against `/api/runtime/v1`, queue `du-business-{id}-{version}`). If your suite
  needs a proper enable endpoint instead of `enableVersionForTest`, file it in
  `requests/antigravity.md`.

Deferred per rebalance: Admin UI (P6), webhook delivery, example-review, P7/P8,
fan-out/human-wait/cancel/deadline, artifacts + invocation grants + usage
ingest (next Orchestrator wave — contracts already frozen for them).

Next: read lane reports at the integration boundary as consumers run against
the runtime; resolve shared blockers; then extend the runtime (artifacts +
grants + usage) toward cross-service E2E.
