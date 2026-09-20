# Coordination Requests — Copilot Connector lane

## Date: 2026-09-20

`contracts-v1.md` is READY. The exact exports consumed are:

- `@du/contracts`: `InvocationRequestSchema`, `InvocationResponseSchema`,
  `InvocationGrantClaimsSchema`, `UsageEventSchema`, `ConnectorErrorCodes`.
- `@du/contracts` types: `InvocationRequest`, `InvocationResponse`,
  `InvocationGrantClaims`, and `UsageEvent`.

Local persistence types remain internal; HTTP boundaries map local lowercase
states to contract uppercase states and map local errors to contract
`retryable` responses.

## Continuation dependency requests

The durable implementations currently depend on local ports and therefore do
not require an immediate install. For concrete runtime wiring after the
workspace gate, resolve these through the single root package manager:

- `pg` `^8.12.0` and `@types/pg` `^8.11.6` for `SqlClient` production wiring.
- `ioredis` `^5.4.1` if selected for Redis client integration; quota requires
  atomic `EVAL`.

Please resolve `pg`/`@types/pg` and `ioredis` in the root pnpm lockfile at the
next root install. Do not add nested lockfiles. Concrete DB/Redis wiring is now
implemented and tested; the remaining blocker is cross-service auth/usage
integration. This lane did not run the root install or modify shared DTOs.

## Rebalance 02 evidence

Concrete adapters now exist in `src/db/pg-client.ts` and
`src/redis-client.ts`; composition wires them through `src/composition.ts`.
The opt-in durable test passed migration/version checks against PostgreSQL
`127.0.0.1:5433` and shared quota against Redis `127.0.0.1:6380`.

The only root action requested is lockfile resolution for the declared `pg`,
`@types/pg`, and `ioredis` dependencies. Runtime-ready remains blocked on
Claude's cross-service invocation/grant and usage integration boundary.

## Rebalance 03 evidence

The production composition no longer exposes empty management methods or a
`runtime composition is not configured` invoke path. It now uses the durable
revision/credential repository, adapter registry, bounded fetch transport,
durable invocation ledger, Redis quota, and usage outbox. Startup fails closed
when service-identity, grant-signing, or credential-encryption secrets are
missing.

The new opt-in black-box suite starts the real Connector composition against
PostgreSQL `127.0.0.1:5433` and Redis `127.0.0.1:6380`, starts a local mock
provider, invokes over HTTP, verifies redacted management output, restarts the
Connector, and verifies durable replay without a second provider call.

No shared auth or usage contract change is requested. Remaining integration
work is Claude-owned Orchestrator wiring and root lockfile resolution.

The Connector management surface now also supports immutable revision creation
through the durable repository (`POST /connectors`); no shared path changes are
needed. After PostgreSQL `5433` and Redis `6380` became reachable again, the
opt-in durable and black-box suites passed: 2 suites and 3 tests, including
restart replay and shared Redis quota.

## Rebalance 04 dependency note

The optional `HttpUsageSink` posts the validated existing `@du/contracts`
`UsageEvent` with an idempotency key equal to `eventId`. It is configured only
when `USAGE_SINK_URL` and `USAGE_SINK_TOKEN` are both present; otherwise the
Connector starts without a delivery loop. The exact Orchestrator usage endpoint
and authentication convention remain runtime-gate dependencies, so no shared
DTO or endpoint was invented here.
