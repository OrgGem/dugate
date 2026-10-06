# Workload rebalance 03 — production last mile without shared-path conflicts

Date: 2026-09-20. This packet follows completed workload rebalance 02. It keeps the ownership map in `coordination/README.md` unchanged and does not depend on an unpublished `runtime-ready.md` gate.

## Verified starting point

- Copilot has concrete PostgreSQL/Redis adapters, a composition root, a process entrypoint, and 25 passing Connector/client tests plus opt-in durable tests. The production composition still falls back to management methods returning empty/not-configured responses and runtime `invoke`/`cancel` methods that throw `runtime composition is not configured`.
- Antigravity has adopted the Worker SDK and passes 128 tests. `document-core` exports `startDocumentCoreWorker`, but its Docker command runs `dist/index.js`, which only exports symbols and does not start a worker process.
- Claude owns and is actively implementing the Orchestrator runtime. Neither lane below may edit Claude-owned paths or assume unpublished runtime endpoints.

## Copilot — replace production Connector fallbacks

Work only in `services/connector/**`, `packages/connector-client/**`, `coordination/reports/copilot.md`, and `coordination/requests/copilot.md`.

1. Replace `createDefaultHttpDependencies` placeholder management/runtime behavior with concrete Connector-owned services. Production startup must never expose an apparently healthy service whose invoke path only throws `runtime composition is not configured`.
2. Add an adapter registry for the existing JSON and multipart adapters and a production HTTP provider transport based on `fetch`. Enforce provider timeout/abort, response-size bounds, safe redirect behavior, and secret-safe errors/logging. Do not add provider-specific code.
3. Resolve the pinned connector revision through `PostgresConnectorConfigRepository`, select the declared adapter, verify active credential/revision state, then call the existing `invokeAdapter` path with durable ledger and quota. Preserve invocation ID/input-hash replay semantics and UNKNOWN behavior.
4. Implement concrete runtime `get` and supported cancellation semantics against the durable ledger. If the provider cannot be cancelled, persist/return the explicit local outcome defined by existing contracts rather than claiming remote cancellation.
5. Wire Connector-owned management operations to the repository for redacted list/get, immutable revision creation, credential rotation/revocation, disable, and controlled test invocation. Keep secrets write-only and encrypted/opaque according to the current repository boundary.
6. Add a black-box opt-in integration suite inside `services/connector/tests/**`: start the real composition against PostgreSQL `5433` and Redis `6380`, start the existing mock provider, invoke over HTTP, verify replay after Connector restart, shared quota across two compositions, redacted management output, and persisted status. Keep infra read-only.
7. Add a startup assertion/test that fails closed when durable runtime dependencies or required security configuration are absent. Update README and Copilot report so they describe implemented behavior rather than planning placeholders.

Acceptance: no `NOT_CONFIGURED`/`runtime composition is not configured` fallback remains on the production entrypoint path; current tests remain green; strict typecheck and the new opt-in suite pass. Record any missing shared auth/usage contract in `requests/copilot.md` instead of editing shared packages.

Do not edit root manifests/lockfile, contracts, Worker SDK, Orchestrator, infra, or Antigravity paths.

## Antigravity — make Document Core an executable worker service

Work only in `businesses/document-core/**`, `packages/document-kit/**`, `coordination/reports/antigravity.md`, and `coordination/requests/antigravity.md`.

1. Add an executable `document-core` process entrypoint that parses and validates `RUNTIME_URL`, `RUNTIME_TOKEN`, `REDIS_URL`, optional `CONNECTOR_URL`, concurrency, heartbeat interval, worker instance ID, image digest, and shutdown grace period. Never print the runtime token.
2. Start `startDocumentCoreWorker` from that entrypoint and implement idempotent SIGTERM/SIGINT handling that stops intake, drains within the configured grace period, and exits with the correct status on startup/shutdown failure.
3. Change the owned package scripts and Docker command to run the executable entrypoint. Ensure the built image cannot exit successfully immediately after merely importing `dist/index.js`.
4. Add unit tests for environment parsing, invalid/missing configuration, secret redaction, start failure, and idempotent shutdown using injected process/worker boundaries.
5. Add an opt-in Redis smoke test inside `businesses/document-core/tests/**` that uses the real BullMQ consumer at Redis `6380` and a local fake runtime HTTP server. Prove queue consumption, claim, completion, and graceful drain for at least one action without requiring Claude's Orchestrator. Do not modify `@du/worker-sdk` to make the test pass.
6. Replace the stale planning-placeholder text in the owned `document-core` and `document-kit` READMEs with current build/run/config/test instructions and a truthful boundary between local/SDK evidence and pending cross-service E2E.
7. Preserve the existing 128 tests and strict typechecks. Record new commands/results and any SDK/runtime incompatibility in the Antigravity report/request files.

Acceptance: the Document Core image starts a real BullMQ worker using validated configuration, shuts down cleanly, and has executable smoke evidence. `runtime-ready.md` remains the gate for real cross-service E2E.

Do not edit root manifests/lockfile, contracts, Worker SDK, Orchestrator, Connector, infra, or central docs/tasks.

## Conflict and integration rules

1. Copilot and Antigravity may run concurrently because their write paths do not overlap.
2. PostgreSQL/Redis ports from Claude-owned Compose are read-only test dependencies; neither lane edits `infra/**`.
3. Do not add cross-service tests to shared `du-rework/tests/**` until Claude publishes `runtime-ready.md`.
4. Do not repair a missing shared contract locally by inventing a wire DTO. Write an exact request in the lane's coordination request file.
5. Preserve all concurrent workspace changes; no reset, clean, stash, rebase, broad stage, or broad format operation.
