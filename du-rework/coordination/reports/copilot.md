# Coordination Report — Copilot Connector lane

- **Date**: 2026-09-20
- **Status**: READY_FOR_INTEGRATION
- **Scope**: Connector local protocol, durable repositories/migrations, Redis
  quota, HTTP management/runtime shell, provider mock, and typed client.

## Completed in this checkpoint

- Added connector-local protocol matrix without publishing guessed shared DTOs.
- Added strict local types, canonical input hashing, grant binding validation,
  replay/conflict/unknown-aware ledger, and declarative JSON/multipart adapters.
- Added PostgreSQL-owned migration for connector revisions, encrypted secret
  versions, invocation ledger, and usage outbox.
- Added transactional SQL repository ports/implementations for invocation claim,
  replay/conflict, pending/success/failure/unknown transitions, credential
  rotation/revocation, and usage outbox claiming/deduplication.
- Added Redis Lua atomic quota leases with expiry and release; two independent
  store instances are tested against one Redis boundary.
- Added dependency-free HTTP service shell for health/readiness, capabilities,
  redacted connector metadata, write-only credential rotation, disable/test
  management actions, and invocation get/submit/cancel seams.
- Adopted the frozen `@du/contracts` v1 connector schemas through local
  boundary adapters: request/grant/usage parsing and response state/error
  mapping now use the exact shared exports without changing local repositories.
- Added injectable service-identity verification and contract-backed signed-grant
  verification boundaries with negative scope, audience, expiry, tamper, and
  input-hash tests.
- Added graceful lifecycle start/drain/shutdown, standalone Dockerfile and
  entrypoint, provider timeout-to-UNKNOWN behavior, credential-revoke fencing,
  oversized request handling, and usage-outbox replay fault coverage.
- Added concrete `pg` Pool/transaction/migration/version-check adapter and
  concrete `ioredis` EVAL/ping/quit adapter with URL/TLS/prefix support.
- Added composition-root wiring for PostgreSQL, Redis, durable ledger/config/
  outbox, quota, durable runtime and management services, HTTP auth verifier,
  readiness, and drain.
- Replaced the Docker stub server entrypoint with the compiled composition-root
  entrypoint, environment validation, signal-driven drain/shutdown, and
  migration asset packaging for production images.
- Added deterministic usage IDs, controllable provider fault modes, and typed
  client invoke/replay/poll/wait/cancel behavior that surfaces UNKNOWN without
  blind retrying.
- Added the production adapter registry and generic fetch transport with
  redirect rejection, response-size limits, abort handling, and secret-safe
  provider errors.
- Replaced production management/runtime fallbacks with durable revision,
  credential, invocation, quota, and usage-outbox services.
- Added fail-closed startup security configuration checks and a black-box HTTP
  integration test covering provider invocation, redacted management output,
  restart replay, and persisted status.
- Added repository-backed immutable revision creation through `POST /connectors`
  with adapter and timeout validation; credential rotation remains write-only.

## Test commands and actual results

No install was run; existing repository dependencies were sufficient.

```text
node_modules/.bin/tsc.cmd -p du-rework/services/connector/tsconfig.json --noEmit
PASS (after contracts-v1 adoption)

node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand
5 suites passed, 23 tests passed; 1 opt-in integration suite skipped by default

node_modules/.bin/tsc.cmd -p du-rework/packages/connector-client/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/packages/connector-client/jest.config.cjs --runInBand
1 suite passed, 2 tests passed

node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand durable-integration.test.ts
CONNECTOR_INTEGRATION=1: 1 suite passed, 2 tests passed against PostgreSQL :5433 and Redis :6380

Full Connector run with `--detectOpenHandles`: 5 suites passed, 23 tests
passed, 1 opt-in integration test skipped, exited cleanly.

After the runtime-entrypoint change:

```text
node_modules/.bin/tsc.cmd -p du-rework/services/connector/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand --detectOpenHandles
5 suites passed, 23 tests passed; 1 opt-in integration suite skipped

node_modules/.bin/tsc.cmd -p du-rework/packages/connector-client/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/packages/connector-client/jest.config.cjs --runInBand
1 suite passed, 2 tests passed
```

After WORKLOAD-REBALANCE-03 production runtime wiring:

```text
node_modules/.bin/tsc.cmd -p du-rework/services/connector/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand --detectOpenHandles
5 suites passed, 24 tests passed; 2 opt-in suites skipped by default

CONNECTOR_INTEGRATION=1 node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand durable-integration.test.ts black-box-durable.test.ts
2 suites passed, 3 tests passed against PostgreSQL :5433, Redis :6380, and a local mock provider

The previous opt-in rerun was temporarily blocked because PostgreSQL
`127.0.0.1:5433` and Redis `127.0.0.1:6380` were unavailable. A subsequent
rerun after both services became reachable passed:

```text
CONNECTOR_INTEGRATION=1 node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand --detectOpenHandles durable-integration.test.ts black-box-durable.test.ts
2 suites passed, 3 tests passed, exited cleanly

node_modules/.bin/tsc.cmd -p du-rework/packages/connector-client/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/packages/connector-client/jest.config.cjs --runInBand
1 suite passed, 2 tests passed

Production fallback scan:
No `NOT_CONFIGURED`, `runtime composition is not configured`, or planning-placeholder
matches remain under services/connector.
```

After WORKLOAD-REBALANCE-04 reliability hardening:

```text
node_modules/.bin/tsc.cmd -p du-rework/services/connector/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand --detectOpenHandles
6 suites passed, 29 tests passed; 2 opt-in suites skipped

CONNECTOR_INTEGRATION=1 node_modules/.bin/jest.cmd --config du-rework/services/connector/jest.config.cjs --runInBand --detectOpenHandles durable-integration.test.ts black-box-durable.test.ts
2 suites passed, 3 tests passed against PostgreSQL :5433, Redis :6380, and a local mock provider

node_modules/.bin/tsc.cmd -p du-rework/packages/connector-client/tsconfig.json --noEmit
PASS

node_modules/.bin/jest.cmd --config du-rework/packages/connector-client/jest.config.cjs --runInBand
1 suite passed, 2 tests passed
```

## Dependencies and handoff

- `@du/contracts` v1 and `workspace-ready.md` are now consumed. The exact
  connector/grant/usage exports are used by `src/contracts.ts`,
  `src/contract-grants.ts`, `src/usage.ts`, and client `src/contracts.ts`.
- `pg`/`ioredis` declarations are in the lane manifest but the root lockfile was
  not changed and no install was run; Claude must resolve them.
- Cross-service artifact/session and Orchestrator usage integration remain gated
  follow-up; Connector-local durable invocation and management paths are now
  implemented.

## Current blocker

Remaining blocker is the Claude-owned Orchestrator runtime boundary and root
lockfile resolution for `pg`, `@types/pg`, and `ioredis`. No shared contract,
root configuration, SDK, Orchestrator, or infra file was modified.

## P3-01..P3-08 evidence matrix

| Task | Status | Evidence |
|---|---|---|
| P3-01 | COMPLETE | `src/types.ts`, `src/db/migrations/001_connector.sql`, `src/db/repository.ts`; Connector typecheck and durable migration test |
| P3-02 | COMPLETE | `src/http/server.ts`, `src/services.ts`; redaction/rotation/revision tests in `runtime-foundations.test.ts` and black-box management assertion |
| P3-03 | COMPLETE | `src/grants.ts`, `src/hash.ts`, `src/ledger.ts`, `src/db/repository.ts`; `security-lifecycle.test.ts` and replay/conflict tests |
| P3-04 | COMPLETE | `src/adapters/http.ts`, `src/adapters/registry.ts`, `src/adapters/transport.ts`; adapter mapping and mock-provider tests |
| P3-05 | COMPLETE | `src/invoke.ts`, `src/quota-redis.ts`; quota, timeout-to-UNKNOWN, async pending, cancellation and two-instance durable tests |
| P3-06 | PARTIAL | `src/db/usage-outbox.ts`, `src/usage-dispatcher.ts`; retry/idempotency/fault tests pass, but real Orchestrator usage projection remains pending `runtime-ready.md` |
| P3-07 | COMPLETE | `packages/connector-client`; strict typecheck and 2 client consumer tests |
| P3-08 | COMPLETE | `src/lifecycle.ts`, `src/adapters/transport.ts`, `tests/reliability-security.test.ts`, Docker entrypoint; 6 suites/29 tests pass plus opt-in durable suites |
