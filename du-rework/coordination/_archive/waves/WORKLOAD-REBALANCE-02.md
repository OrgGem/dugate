# Workload rebalance 02 — concrete runtime integration

Date: 2026-09-20. This packet continues the existing three implementation lanes and does not change path ownership in `coordination/README.md`.

## Verified starting point

- Claude has published READY gates for contracts, workspace and Worker SDK. The Orchestrator runtime is actively being implemented; `runtime-ready.md` is not published yet.
- Antigravity has 115 passing tests across `document-kit` and `document-core` and is already adapting the six handlers to `@du/worker-sdk`.
- Copilot has 22 passing tests across Connector and connector-client, with strict typechecks passing. The lane is idle and ready for concrete PostgreSQL/Redis wiring.

## Copilot — Connector durable adapters and composition root

Continue only in Copilot-owned paths: `services/connector/**`, `packages/connector-client/**`, `coordination/reports/copilot.md`, and `coordination/requests/copilot.md`.

1. Implement a concrete PostgreSQL adapter with `pg` behind the existing `SqlClient` port. Include pool lifecycle, parameterized queries, transactions, migration execution/version checks, and clean shutdown.
2. Implement a concrete `ioredis` adapter behind the existing quota/Redis ports. Support configured key prefix, connection/TLS settings, atomic quota behavior, reconnect behavior, and clean shutdown.
3. Add the Connector composition root in its entrypoint: configuration → PostgreSQL/Redis → repositories/quota → invoke service → HTTP server. Readiness must depend on required durable dependencies; liveness remains process-scoped. Drain HTTP work before closing clients.
4. Wire the existing injectable service-identity and signed-grant verifiers into actual HTTP middleware. Preserve current shared DTOs and secret-redaction behavior.
5. Add integration tests using the Claude-owned Docker Compose services at PostgreSQL `5433` and Redis `6380`, treating `infra/**` as read-only. Cover migration from an empty database, two Connector instances sharing quota, invocation replay after restart, and usage-outbox replay.
6. Preserve all existing tests and typechecks. Record exact commands/results and remaining Orchestrator dependency in `reports/copilot.md`; use `requests/copilot.md` for any shared change request.

Do not edit the root package/lockfile, `packages/contracts/**`, `packages/worker-sdk/**`, `services/orchestrator/**`, or `infra/**`. If a dependency or shared interface is missing, request it rather than changing another lane.

## Antigravity — finish Worker SDK adoption

Continue the work already in progress; do not restart or redesign the six business pipelines.

1. Adapt the existing six `document-core` handlers to the exact READY `@du/worker-sdk` exports using a boundary adapter in Antigravity-owned code.
2. Publish a business definition with `defineBusiness` and a runnable worker entrypoint with `startWorker`. Add a service Dockerfile only under `businesses/document-core/**` if needed.
3. Test the adapter through an injected/fake `QueueConsumer`: all six actions, success completion, checkpoint behavior, failure disposition, and lease-loss cancellation. Preserve the existing 115 passing tests.
4. Update `reports/antigravity.md` to mark SDK adoption accurately. Keep runtime E2E pending until Claude publishes `runtime-ready.md`.

Do not edit Worker SDK, contracts, Orchestrator, infra, the root package or lockfile. Send incompatibilities through `requests/antigravity.md`.

## Claude — keep the critical path narrow

Complete the current Orchestrator turn before taking broader platform work.

1. Finish the minimal durable vertical slice: public submission and transactional outbox → dispatch → claim/heartbeat/checkpoint → completion/result.
2. Add isolated PostgreSQL/Redis runtime tests for that slice, including idempotency, lease expiry/reclaim and outbox retry.
3. Publish `coordination/gates/runtime-ready.md` only after the runtime commands pass. Include exact endpoints, queue names, headers/auth expectations, environment variables and test commands needed by the two consumer lanes.
4. Read both lane reports/requests at the integration boundary and resolve only shared blockers required by the vertical slice.

Defer Admin UI, webhook delivery, `example-review`, P7 and P8. Do not edit Copilot or Antigravity owned paths.

## Integration order and conflict controls

1. Copilot and Antigravity work in parallel against the already READY contracts/SDK gates.
2. Claude publishes `runtime-ready.md` with executable runtime evidence and stable connection details.
3. Each consumer lane runs its own integration suite against that runtime and records evidence in its own report.
4. Cross-service E2E may be added to Claude-owned shared tests only after the lane reports agree on the same contract and runtime version.

No agent may reset, clean, stash, rebase, broadly stage, or overwrite another lane's files. Shared-checkout changes from other agents are expected and must be preserved.
