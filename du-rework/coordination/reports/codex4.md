# W48-CX4 — P8-06 OPS-08

- Date: 2026-09-24
- Scope: Static review of Compose, image packaging, health, shutdown, migrations, and recovery paths; prepare deployment architecture and backup/restore operator scripts.
- Boundary: Changes are limited to `du-rework/infra/**` and this requested report. No core service, orchestrator, connector, or root legacy deployment source was edited.
- Database: No DB window, database command, service startup, or deployment was used.
- Acceptance: P8-06 remains `[ ]`; OPS-08 has not passed a live deployment or recovery rehearsal.

## Findings

1. `du-rework/infra/docker-compose.yml` is a test-only PostgreSQL/Redis fixture. It hardcodes `du-test-only`, binds 5433/6380 to the host, and fixes container names. The root `docker-compose.yml` is for the legacy DUGate app: production defaults include `MIGRATION=true`, `SEED=true`, default seed credentials, and `mock-service`; it is not an appropriate `du-rework` deployment.
2. `du-rework` has no Orchestrator Dockerfile or standalone process entrypoint. `createApp()` exposes lifecycle methods, but there is no production launcher to install SIGTERM/SIGINT handling. A Compose service cannot currently start the Orchestrator as a managed process from repository packaging.
3. The Orchestrator has an explicit one-shot `migrate/status/verify` CLI and its normal app boot verifies migrations without applying them. Connector `composition.start()` applies schema migrations on every service start; there is no one-shot/verify mode, so migration ownership is not serialized for production scale-out.
4. Connector exposes `/health/live` and `/health/ready`; ready checks database and Redis. Orchestrator `/health` and `/api/v1/health` are dependency readiness checks (database and Redis), not process-only liveness. Document Core has SIGTERM/SIGINT handlers and a configurable worker stop grace; Orchestrator's app close drains leases and closes dependencies, but no packaged process calls it on signals.
5. Connector requires service identity on non-health routes. The Document Core `createConnectorInvoker` sends only JSON content type, without Authorization or service identity. This blocks worker-to-Connector invocation pending a core contract fix and integration proof.
6. Private S3 artifact persistence and the Elasticsearch collector path are still deployment-plan implementation gates. PostgreSQL backup scripts alone cannot provide application-consistent artifact recovery. Existing architecture marks RPO/RTO as proposed targets, not measured results.

## Delivered

- Added `du-rework/infra/deployment-architecture.md` with isolated host/service boundaries, private networking, startup and migration order, health/shutdown contracts, rollback policy, and explicit production gates.
- Added `du-rework/infra/scripts/backup-postgres.sh`: custom-format dump via a protected libpq service file (no password in process arguments), archive readability check, SHA-256 sidecar, restrictive umask, and overwrite refusal.
- Added `du-rework/infra/scripts/restore-postgres.sh`: checksum validation, `du_restore_*` target name guard, typed target confirmation, transactional restore without destructive drops, and dispatch/provider hold instruction.
- Did not add a production Compose file because the current runtime packaging and service authentication/migration contracts cannot support a truthful deployable configuration. The architecture describes the target Compose boundary and records prerequisites.

## Evidence and verification limits

- Static reads: root `docker-compose.yml`, `Dockerfile`, `docker-entrypoint.sh`; `du-rework/infra/docker-compose.yml`; Connector and Document Core Dockerfiles/entrypoints; Orchestrator and Connector health, lifecycle, and migration source; worker config/lifecycle; `du-rework/docs/12-operations.md`; `du-rework/architecture/06-aws-deployment.md`; `du-rework/architecture/08-operations.md`; `du-rework/tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md`.
- Git Bash syntax check: `bash -n` on each new script, both exit 0. No application tests/build, Compose startup, DB, Redis, backup, or restore command was run. Scripts are prepared for operator rehearsal only; no database recovery is claimed.

## Required follow-up before P8-06 closeout

- Platform owner: package an Orchestrator process entrypoint with signal handling and validated runtime configuration.
- Connector/SDK owners: align service identity and worker invocation; add a serialized one-shot Connector migration path and read-only readiness verification.
- Storage/observability owners: complete private S3 artifact storage and central log collection required by G-DATA.
- Deployment/integration owner: pin all image digests and run multi-container readiness, migration, graceful shutdown, and isolated backup/object restore rehearsals with measured RPO/RTO and recorded results.

# W48-CX4 — R1-D Invocation Lifecycle & Replay Safety

- Date: 2026-09-25
- Scope: R1-D survey, implementation, and offline verification for MM-06/07/08, WR24-08, and FR24-08/11/23, focused on `du-rework/services/connector` and `du-rework/packages/connector-client`.
- Boundary: Runtime/client changes stay in Connector and connector-client; test changes stay in their package test directories; this report remains at the requested rework path. No database window or real DB/Redis/provider was used.
- Status: Offline R1-D checks pass within the stated scope. Real PostgreSQL/Redis durability and provider idempotency remain an integration gate.

## Initial survey findings (before implementation)

1. **Replay guard is present for ordinary first-dispatch `IN_FLIGHT` and `CANCELLED`, but the async recovery state needs an explicit contract.** `services/connector/src/invoke.ts` returns `INVOCATION_UNKNOWN` for an `IN_FLIGHT` row without a poll lease, and returns `CANCELLED` for a cancelled row before reaching transport dispatch. `claimPendingPoll` also fences due polls. However, an expired poll lease is itself stored as `IN_FLIGHT`; the recovery branch can claim it and continue to another POST using the same provider idempotency key. Treat this as async poll recovery, distinct from a second initial inference, and decide whether the requirement's “never redispatch IN_FLIGHT” is literal for this state too. The current adapter supports POST replay only when the provider declares idempotency-key replay; it has no provider status-GET contract (`services/connector/docs/ADR-001-async-provider-polling-contract.md`).
2. **Some ambiguous outcomes are persisted, but durable 409/reconciliation is not fully proved.** `PostgresInvocationLedger.markUnknown()` writes `UNKNOWN` and `INVOCATION_UNKNOWN`; transport failures/timeouts call it from `invoke.ts`. By contrast, the durable first-claim contention test expects an HTTP 409 `INVOCATION_UNKNOWN` while the stored row remains `IN_FLIGHT`, not `UNKNOWN` (`services/connector/tests/black-box-durable.test.ts`). A process crash after provider acceptance but before `markUnknown()` can also leave the initial `IN_FLIGHT` row without a poll lease. The ledger API has no explicit resolve/reconcile operation, so restart replay can preserve an ambiguous response but cannot yet prove authoritative outcome reconciliation. Separately, `packages/connector-client/src/sdk-invoker.ts` maps `INVOCATION_UNKNOWN` to wire `UNKNOWN` only for status 0; HTTP 409 is mapped to `FAILED`, losing the reconciliation signal.
3. **Quota lease renewal is absent.** `QuotaStore` exposes only `acquire` and `release`; `RedisQuotaStore` has acquire/release scripts but no owner-fenced renewal. A long provider call can outlive the quota lease and free a shared-account slot while its side effect is still running. Current timeout setup clamps the configured provider timeout against the remaining invocation deadline, and recalculates the abort delay at send time. The success path should also be tested when transport ignores abort and resolves after the deadline; it currently proceeds to normalize and complete that response without a post-send deadline/abort check.
4. **WR24-08 usage delivery has useful idempotency/retry pieces but needs a bounded-stall case.** Usage event IDs are deterministic and the HTTP sink sends the ID as an idempotency key. The outbox dispatcher defers failed events and parks exhausted attempts. Its batch awaits all sink sends with `Promise.all` and the sink has no request timeout, so one never-resolving send can hold that batch open; include a hanging-sink case in the harness plan.

## Harness design from survey

Add a focused suite such as `services/connector/tests/r1-d-lifecycle-offline.test.ts`; do not require PostgreSQL, Redis, network access, or a real provider. Use a manual clock, a shared atomic in-memory quota fake, a persistent-across-reconstruction fake ledger/outbox, and an instrumented transport with barriers, send count, idempotency-key capture, and optional abort-ignoring behavior. Recreate the Connector/invoker over the same backing fakes to model process restart. Existing offline suites already cover several component cases, but mostly use in-memory state; the gated durable suite is a separate integration evidence gate and was not run here.

| Case | Setup and assertions |
|---|---|
| Initial `IN_FLIGHT` replay | Pause the first provider send after it is counted; replay the same ID/hash concurrently and after reconstructing the invoker. Expect stable 409 `INVOCATION_UNKNOWN`, no second initial send, and no new usage event. Replay with a changed hash must remain an input conflict. |
| `CANCELLED` replay | Seed/cancel a durable fake record, reconstruct, replay; expect `CANCELLED`, zero sends, and no quota reacquisition. |
| Async `PENDING` and expired poll lease | Seed 202/PENDING with a due time, reconstruct invokers, and race claims. `PENDING` poll claims and expired poll recovery now use separate `POLLING` state; assert one CAS winner, stable invocation idempotency key, fencing of the stale poller, and bounded persisted attempts. Initial `IN_FLIGHT` never redispatches. |
| Ambiguous outcome across restart | Have the provider record acceptance, then drop the response/trigger timeout. Assert durable `UNKNOWN`, stable invocation/provider IDs, 409 `INVOCATION_UNKNOWN` after reconstruction, and no blind send. Add a crash point after provider acceptance but before the ledger write; it must not silently repeat inference. Require a defined authoritative reconciliation transition and exactly one usage event before this criterion passes. |
| 409 client mapping | Pass HTTP 409 + `INVOCATION_UNKNOWN` through connector-client; expect wire `UNKNOWN`, preserve invocation ID, and classify for reconciliation rather than provider retry. Include status 0 and a terminal non-unknown 409 as controls. |
| Shared quota and renewal | Share one account key across two invokers/tenants. Hold one provider call beyond its initial short lease while advancing fake time; verify owner-fenced renewal keeps the aggregate cap occupied, renewal never exceeds deadline, a competing call gets no lease, and stale/released leases cannot renew. Renewal failure aborts the provider request and stores an ambiguous outcome. |
| Timeout clamp | Cover configured timeout shorter/longer than remaining deadline, delay during quota acquisition, and deadline expiry before send. Observe abort timing at send; make a transport ignore abort and resolve late, then assert the late response cannot turn an expired/ambiguous invocation into `SUCCEEDED`. |
| Usage delivery bound | Make one sink request hang while another event is valid; assert a bounded request/drain timeout, retry/defer behavior, and that one stuck event does not permanently prevent later batch progress or duplicate usage billing. |

Offline fake tests can verify state-machine and call-count behavior, but cannot prove PostgreSQL durability or Redis Lua atomicity. Keep a separate gated acceptance run for two real Connector instances, PostgreSQL/Redis restart, lease expiry/renewal, provider-side idempotency, and usage outbox recovery. No such run was performed for this report.

## Pre-implementation evidence inventory

- `services/connector/tests/connector.test.ts`: cancelled replay, due `PENDING` polling, expired poll lease fencing, concurrent `IN_FLIGHT` replay, timeout/unknown paths, and quota acquisition failure.
- `services/connector/tests/p8-03-convergence.test.ts`: disconnect/timeout unknown outcomes and in-memory usage retry/poison-event cases.
- `services/connector/tests/black-box-durable.test.ts`: gated restart cases; the first-claim replay currently asserts the row is `IN_FLIGHT`, while cancelled replay and poll-lease recovery have separate cases.
- `packages/connector-client/tests/sdk-invoker.test.ts`: no explicit HTTP 409 `INVOCATION_UNKNOWN` mapping case found during static search.
- No tests/build, DB, Redis, provider, or network command was run during the initial static survey.

## R1-D implementation and offline verification

- Added `services/connector/tests/r1-d-lifecycle-offline.test.ts`, a 9-test offline harness. It rebuilds process-facing ledger adapters over shared in-memory backing state and uses fake time, quota, and provider transport; no real persistence service is involved.
- Separated initial dispatch (`IN_FLIGHT`) from async poll ownership (`POLLING`). `IN_FLIGHT` replay always returns `INVOCATION_UNKNOWN`; `CANCELLED` replay returns `CANCELLED`. Neither path acquires quota or sends to the provider. Due `PENDING` claims and expired poll recovery use a fenced `POLLING` lease; provider retries retain the same idempotency key and the durable poll attempt limit remains 16. Migration `005_connector_polling_state.sql` converts existing poll-leased `IN_FLIGHT` rows to `POLLING` while leaving initial claims unchanged.
- Persisted `UNKNOWN` replay remains ambiguous and makes no provider call. Connector GET maps stored `IN_FLIGHT`/`UNKNOWN` to the `UNKNOWN` response without changing the ledger row. Connector-client now maps HTTP 409 `INVOCATION_UNKNOWN` to wire `UNKNOWN` instead of `FAILED`, preventing blind inference retry.
- Added quota renewal to the store contract, in-memory store, and Redis Lua store. Redis renewal checks the lease owner ID and unexpired score atomically. The in-flight provider request renews its lease before expiry, clamps every renewal at the invocation deadline, and aborts/records `UNKNOWN` if ownership cannot be renewed.
- Provider timeout is recomputed from remaining deadline at send time. A response that arrives after abort/deadline is stored as `UNKNOWN`, not `SUCCEEDED`.
- Usage sink requests now receive an abort signal and a bounded send timeout (10 seconds by default). Shutdown drain cancels outstanding sends at its own timeout; timed-out events remain deferred in the outbox, so a stuck sink no longer holds batch progress indefinitely.

### Test results

- R1-D harness: **1 suite passed, 9 tests passed**.
- Connector offline suite: **11 suites passed, 82 tests passed, 3 tests skipped, 0 failures**. This run excluded PostgreSQL/Redis integration files and the unrelated `network-boundaries.boundary.test.ts`; three existing localhost HTTP tests were skipped because this runner cannot connect to `127.0.0.1`.
- Connector-client offline suite: **3 suites passed, 24 tests passed, 1 suite/test skipped, 0 failures**.
- Connector and connector-client TypeScript checks (`tsc --noEmit`): both **passed**. `git diff --check` returned 0; Git emitted only LF-to-CRLF normalization notices.
- A broader offline diagnostic that included `network-boundaries.boundary.test.ts` had **14 failures** in its unrelated open FIX-CR-01/FIX-CR-08 SSRF and streamed-body probes. The relevant R1-D suites pass when that separate boundary suite and the database-dependent suites are excluded.
- No PostgreSQL/Redis test, migration application, provider call, or external network call was run. The in-memory restart harness validates state/call-count rules; it does not substitute for a real two-instance persistence rehearsal.

# W48-CX4 / Cycle 78 - R1-D Verification & Live Migration Preparation

- **Date:** 2026-09-25.
- **Reviewer baseline:** R1-D offline harness 9/9; Connector offline 82/82; connector-client offline 24/24. This report does not rerun or change those results.
- **Task:** static safety review of du-rework/services/connector/src/db/migrations/005_connector_polling_state.sql and preparation of a Tester-owned live PostgreSQL/Redis run request.
- **Status:** request drafted at [du-rework/docs/29-run-request-queue.md](../../docs/29-run-request-queue.md), section R1-D-C78-LIVE-005. No migration receipt exists from this Codex turn; live application and verification remain pending Tester/DB-window execution.

## Migration safety review

Migration 005 replaces connector_invocations_state_check to include POLLING, maps only IN_FLIGHT rows with an existing poll_lease_token to POLLING, and rebuilds connector_invocations_expired_poll_lease_idx for POLLING rows with a token. This preserves first-dispatch IN_FLIGHT rows that have no poll lease.

PgSqlClient.migrate() executes each SQL file and writes its version receipt in the same BEGIN/COMMIT; exceptions invoke ROLLBACK. On a consistent schema, rerunning migration 005 converges because it drops the named constraint/index before recreating them and its data update only matches old IN_FLIGHT poll leases. The normal receipt path prevents repeated work. However, the runner performs an unlocked read-before-write of the receipt, so concurrently starting multiple Connector instances can race. The run request therefore uses one migration runner before scaling.

The migration is not lock-free: it drops/adds a check constraint, runs a row update, and recreates a non-concurrent index. Apply it in a controlled window. There is no checked-in down migration. A manual reverse transaction is included in the request: stop all new Connector processes; map all POLLING rows back to IN_FLIGHT; restore the old state check and partial-index predicate; remove only the 005 receipt; verify old definitions; then deploy the old application. A recovery point is required, and provider-side effects cannot be reversed by SQL rollback.

## Tester run request and evidence requirements

The request targets the isolated services from du-rework/infra/docker-compose.yml (PostgreSQL 16, Redis 7). It applies through the same PgSqlClient.migrate() path used at Connector startup, checks the durable migration receipt and schema/data postconditions, then runs tests/black-box-durable.test.ts with CONNECTOR_INTEGRATION=1 against those containers. The suite contains six live cases covering first-claim 409 replay, CANCELLED, due/expired poll recovery across Connector reconstruction, and credential-wide quota leases. The queued expected count is 6/6, no skips, exit 0. A pre-existing 005 receipt must be retained and recorded; it must not be deleted to manufacture a new apply.

The six-case live suite does not cover a durable UNKNOWN reconciliation transition, Redis lease-renewal timing, or timeout-clamp boundaries; those remain offline-harness evidence only. The run request keeps those proof boundaries explicit.

Tester evidence requested: claimed/released DB-window timestamps; exact revision and SQL SHA-256; verified target/container identities and health; pre/post migration receipt plus constraint/index definitions and invocation-state counts; backup or explicit disposable-test-data confirmation; exact command/exit code and Jest summary; redacted logs and any deviation. Failure at any gate stops the run and preserves the state for the DB-window owner. The queue explicitly forbids volume deletion and blind retries.

## Execution boundary

This is static review and runbook preparation only. No database or Redis connection, migration apply, backup/restore, integration suite, build, or test command was run for Cycle 78. The reviewer-requested live receipt and PostgreSQL/Redis verification are still outstanding; the existing offline counts do not satisfy that live gate.

# W48-CX4 - R1-D Multi-Instance Connector Quota & Egress Bounds

- **Date:** 2026-09-25.
- **Scope:** `du-rework/services/connector` runtime quota lease renewal and usage outbox egress; offline tests only.
- **Status:** implemented and verified offline. No PostgreSQL/Redis or live provider was used.

## Changes

- Invocation quota leases now use a bounded default window of 30 seconds, capped further by the request deadline. Smaller explicit lease windows remain supported. The production `DurableConnectorRuntime` path, which does not set a special test lease value, now renews long-running provider calls periodically instead of reserving the whole invocation deadline as a single lease.
- Periodic renewals run before expiry and are owner-fenced by the shared quota store. Their request wait is bounded to at most 1 second and 80% of the remaining lease/deadline budget (minimum timer resolution 1 ms). A rejected, invalid, or stalled in-call renewal aborts provider egress and leaves the invocation ambiguous for reconciliation; it does not continue past quota ownership. The expired carried-lease pre-dispatch renewal is bounded by the same 1-second maximum and remaining invocation deadline.
- `UsageOutboxDispatcher` clamps per-event send timeout to 1–30 seconds (10-second default), drain timeout to at most 30 seconds, and batch size to at most 25. Aborted/timed-out sends are deferred in the outbox; their failure does not block other events in the batch. The offline test checks timeout abort, later-event progress, and the fan-out cap.
- The multi-replica offline test now uses two independent quota-store client facades over one shared atomic backing store. It holds one provider call open across the original 100 ms expiry, observes at least two renewals, verifies a second replica still cannot acquire the shared account slot, and verifies renewal failure aborts before expiry. A separate case pins the production default lease window at 30 seconds.

## Verification

- `tests/r1-d-lifecycle-offline.test.ts`: **1 suite passed, 11 tests passed, 0 skipped**, exit 0.
- `tests/reliability-security.test.ts -t usage`: **1 suite passed, 7 tests passed, 2 filtered out**, exit 0.
- Connector typecheck (`pnpm lint`, `tsc --noEmit -p tsconfig.json`): **passed**, exit 0.
- A combined invocation of the two suites also surfaced one failure outside these changes: `reliability-security.test.ts` expects `validateProviderUrl('http://127.0.0.1:8080', { allowPrivateNetworks: true })` to resolve, but it rejects with `INVALID_INPUT`. No provider URL adjudication code was changed; this failure is not counted as a pass and is left outside this task's quota/outbox scope.
- No live Redis Lua test, DB test, live Connector restart, or provider network request was run. The shared backing store demonstrates multi-instance lease ownership offline; Redis server/Lua behavior remains a separate live-integration check.

# W48-CX4 / Cycle 84 - R1-D Migration 005 Handoff, Shared IP Policy, and Replica Recovery

- **Date:** 2026-09-25.
- **Task:** refresh the Tester run request for `005_connector_polling_state.sql`; align Connector URL validation with the shared contracts IP policy and its `allowPrivateNetworks` option; add an offline multi-replica recovery case.
- **Status:** implemented and verified offline. Migration apply and live PostgreSQL/Redis verification remain pending the Tester-owned DB window.

## Migration 005 run request

Added `R1-D-C84-LIVE-005` to [docs/29-run-request-queue.md](../../docs/29-run-request-queue.md). It re-queues the detailed `R1-D-C78-LIVE-005` procedure rather than creating a competing apply path. The handoff requires one migration runner, preserves existing receipts, keeps the isolated `du_orchestrator_test` target, requires pre/post SQL evidence and a usable recovery point, and records the exact six-case live suite outcome. Migration 005 drops and recreates its named state check and partial index, and only maps `IN_FLIGHT` rows with a poll token to `POLLING`; the runner applies each SQL file and its receipt in the same transaction. The manual reverse transaction is documented as a controlled rollback, not an automatic down migration. No DB window was claimed and no migration was applied.

## Shared provider URL/IP policy

- `adjudicateUrlDestination` now accepts `allowPrivateNetworks` and delegates to a shared address predicate used for both IP literals and resolved DNS answers. `validateProviderUrl` no longer bypasses address or DNS checks when the flag is enabled. The pinned connector fetch applies the same policy at connect time.
- The explicit opt-in permits RFC1918, loopback, and IPv6 ULA destinations, including recognized IPv4-embedded IPv6 forms. It still rejects unspecified, link-local/cloud metadata, CGNAT, benchmarking, multicast, and reserved ranges. Domain names continue through DNS resolution, and every answer must pass; an empty answer set fails closed.
- Added direct contracts policy cases and connector boundary cases for opt-in/default behavior, mixed DNS, metadata denial, and an allowed loopback request through the pinned transport. This also fixes the pre-existing reliability test expectation for explicitly enabled `127.0.0.1`.

## Multi-replica recovery case

`tests/r1-d-lifecycle-offline.test.ts` now models replica A losing its process after a durable `IN_FLIGHT` claim and account-wide lease. Replica B cannot redispatch that ambiguous invocation while the lease is live. After lease expiry, B can acquire quota and complete separate new work; replaying A's old invocation still returns `INVOCATION_UNKNOWN`, with no second provider send. The test uses independent client facades over in-memory shared ledger/quota backends and does not require DB or Redis.

## Verification

- Contracts offline suite: **7 suites, 80 tests passed**, zero failures; contracts typecheck (`pnpm lint`): **passed**.
- Connector lifecycle and reliability suites: **2 suites, 21 tests passed**, zero failures. The R1-D suite now has **12/12** passing tests, including the additional replica recovery case.
- Connector network-boundary suite: **1 suite, 41 tests passed**, zero failures. This includes the policy vector table, mixed-DNS checks, metadata denial under opt-in, and loopback through the pinned transport.
- Connector typecheck (`pnpm lint`): **passed**. These suites used in-memory stores, scripted DNS, and a loopback-only synthetic listener; no DB/Redis container, migration, or external provider was contacted.
- Repository-wide `git diff --check` exited nonzero on whitespace in unrelated `components/HeaderNav.tsx` and `coordination/MONITORING-LOG.md`. Those files were not changed for Cycle 84; untracked files are not covered by Git's diff check.

# W48-CX4 / Cycle 87 - Connector Graceful Shutdown Drain and Deadline

- **Date:** 2026-09-25.
- **Task:** drain Connector HTTP/runtime work during shutdown, enforce the drain deadline, preserve D(2) `timeoutMs: 0` as an explicit test teardown override, and add offline in-flight shutdown tests.
- **Status:** implemented. Production entrypoint retains the configured `DRAIN_TIMEOUT_MS` (30-second default); timeout-zero is only selected by an explicit shutdown caller.

## Implementation

- `createConnectorServer` now counts active route-handler promises as well as sockets. The request count remains active if a client disconnects while its runtime operation is still in progress, so lifecycle shutdown cannot close PostgreSQL/Redis just because the socket went away.
- `ConnectorLifecycle.shutdown()` is idempotent and supports `shutdown({ timeoutMs })`. It stops invocation acceptance, closes the listener, drains route handlers and the usage dispatcher concurrently against the same deadline, then closes dependencies. If the deadline expires it force-closes active HTTP connections before closing dependencies. Invalid negative/non-finite overrides are rejected.
- `shutdown({ timeoutMs: 0 })` skips grace waiting and force-closes connections for test teardown. It does not alter the production default. `UsageOutboxDispatcher.drain(0)` immediately cancels active sink sends so this override cannot accidentally fall back to its 30-second default.
- The Connector README documents the production drain and D(2) boundary.

## Offline shutdown tests

`tests/security-lifecycle.test.ts` now exercises shutdown through a real Connector HTTP server bound only to loopback and fixture runtime/dependencies:

- The accepted invocation remains active during shutdown; dependencies stay open until it completes and the HTTP response is delivered.
- The configured 25 ms deadline force-closes a stuck request and allows shutdown to close dependencies.
- An explicit timeout-zero override returns promptly despite an active request.

## Verification and boundary

- Focused lifecycle, composition, and reliability-security suites: **3 suites, 22 tests passed**, exit 0. This includes timeout-zero cancellation for a stuck usage send. Connector typecheck (`pnpm lint`): **passed**.
- Standalone Connector network-boundary suite: **1 suite, 41 tests passed**, exit 0; loopback egress works in the isolated run.
- A full Connector `pnpm test -- --runInBand` attempt exited 1 (**9 suites passed, 3 failed, 2 skipped; 128 passed, 7 skipped**). The existing `p8-03-convergence.test.ts` contains an unguarded live PostgreSQL projection case despite its offline-only file comment; it attempted the default DB target and its first `INSERT INTO operations` failed with `relation "operations" does not exist`. Its scoped cleanup ran in `finally`; no migration was applied. The same broad batch also had loopback `ETIMEDOUT` failures in the network-boundary and reliability-security suites; those focused suites passed independently. Do not cite the broad batch as offline-suite PASS evidence.
- The shutdown tests and typecheck require no PostgreSQL/Redis. No migration or live Connector deployment was run.

# W48-CX4 / Cycle 88 - Connector Compose Health and Shutdown Integration

- **Date:** 2026-09-25.
- **Scope:** P8-06 deployment packaging contract, Compose health integration, and runbook update. Cycle 88 edits are limited to `infra/` and operational documentation; Connector runtime code was reviewed but not changed.
- **Status:** Compose and runbook integration prepared and statically validated. No container, database window, or Redis service was started.

## Contract review and changes

- The existing Connector Dockerfile builds from the `du-rework` workspace root, installs/builds the Connector workspace, copies all SQL migration files into `dist/db/migrations`, and enters through `entrypoint.sh`. The shell entrypoint uses `exec node ./dist/entrypoint.js`, allowing Node to receive SIGTERM/SIGINT and invoke Cycle 87's lifecycle drain. `DRAIN_TIMEOUT_MS` defaults to 30 seconds.
- Connector startup runs pending migrations before opening its listener. The opt-in Compose service therefore must be used only with disposable local data or under the approved migration run request and recovery-point procedure. This review did not invoke startup or migration code.
- `GET /health/live` is process liveness. `GET /health/ready` checks PostgreSQL and Redis and returns 503 on dependency failure. Current readiness reflects dependencies rather than the drain flag; the runbook now requires upstream traffic withdrawal before SIGTERM.
- Added a `connector` Compose profile in `infra/docker-compose.yml`. Default `up` remains the existing PostgreSQL/Redis-only stack. The opt-in Connector uses the workspace-root build context, waits for both dependency healthchecks, probes `/health/ready` using Node's built-in fetch, binds port 8081 and dependency ports to loopback, and sets a 40-second stop grace around the 30-second drain. Its three required security secrets are passed from environment variables and have no usable defaults. The profile is a single-replica local fixture, not a production topology.
- Updated `infra/README.md` and the Connector operational section in `docs/17-operational-runbooks.md` with the local startup/health/stop procedure, secret setup, migration side effect, signal behavior, retained-volume warning, and production readiness gaps. The runbook explicitly says it was not rehearsed live. Backup/restore rehearsal remains outstanding.

## Verification and boundary

- `docker compose -f infra/docker-compose.yml --profile connector config --quiet`: **passed**; local Compose model validation only, no engine/container start.
- Connector TypeScript check (`pnpm --filter @du/connector lint`): **passed**.
- Focused offline suites (`tests/composition.test.ts`, `tests/security-lifecycle.test.ts`): **11 passed, 1 failed**. Composition suite passed. The existing timeout-zero shutdown case failed because its synthetic loopback `fetch` timed out connecting to `127.0.0.1`; this matches the environment-specific loopback failures already recorded in Cycle 87 and is not reported as a pass.
- No Docker image build, container, DB/Redis connection, migration, live health probe, backup, or restore was run. The runbook's profile commands are for a separately authorized disposable-data/DB-window rehearsal.

# W48-CX4 / Cycle 90 - P8-07 Operational Runbooks & Recovery Drills

- **Date:** 2026-09-25.
- **Scope:** Detailed operator procedures for outbox dispatcher stalls, UNKNOWN provider response loss, BullMQ queue age and worker drain, S3 artifact outage/failover, and provider credential rotation/revocation. Updated `docs/17-operational-runbooks.md`; no service/runtime code changed.
- **Status:** Documentation completed and workspace typecheck passed. The procedures are readiness guidance; no live recovery drill or production control was executed.

## Runbook coverage

- **Outbox dispatcher stall:** Separates task delivery, webhook delivery, and Connector usage outboxes because their retry/idempotency contracts differ. Adds a payload-free read-only backlog/age query, identifies the Orchestrator health fields and 30-second enqueue deferral, and directs recovery through healthy service-owned dispatch/queue-integrity mechanisms. Webhook rows have no verified operator redrive route; preserve delivery IDs and escalate rather than reset state.
- **UNKNOWN provider response loss:** Correctly treats `INVOCATION_UNKNOWN` as HTTP 409 and an ambiguous provider effect. The procedure inspects only durable identifiers/state, queries provider evidence through protected tooling, preserves UNKNOWN when evidence is inconclusive, and prohibits blind redispatch, a new invocation ID, or direct ledger/Redis edits. The current snapshot has no operator reconciliation endpoint, so provider-completed cases remain an explicit Connector-owner escalation gap.
- **BullMQ queue age and worker drain:** Uses BullMQ-aware queue state, pinned business/version, task samples without payloads, and Orchestrator health/queue-integrity signals. Documents dependency recovery, correct-version worker replacement, controlled version deactivation, graceful worker close, drain verification, and rollback while preserving durable jobs/leases.
- **S3 artifact outage/failover:** Adds artifact-specific signals and read-only backend/state inspection; distinguishes transient same-bucket restoration from missing pinned versions and integrity failures. Documents canary verification and rollback preconditions. The service selects one configured bucket and has no cross-bucket locator remap/failover operation; that scenario is a stop-and-escalate gate pending G-DATA implementation and rehearsal, not an executable cutover.
- **Credential rotation/revocation:** Documents secret-aware Connector rotation, overlap, canary and provider-side revocation receipts, emergency disable behavior, UNKNOWN handling for in-flight calls, and encryption-key limitations. The separate public API-key create/revoke routes are not verified in this snapshot; the runbook now marks that as a release gap and removes direct SQL mutation instructions.

## Verification and boundary

- `pnpm lint`: **passed** (exit 0); TypeScript `tsc --noEmit` completed for all 13 workspace projects that expose a lint script, including Connector, Orchestrator, and Connector Client.
- No test suite was run; this task requested lint/typecheck verification.
- No PostgreSQL/Redis/S3 connection, provider call, migration, credential mutation, queue operation, backup/restore, or live recovery drill was run. Alert names and budgets in the document are explicitly described as proposed/configuration-dependent until verified in monitoring.
- Operational readiness remains gated on UNKNOWN reconciliation tooling, cross-bucket artifact remap/failover and restore rehearsal, a supported API-key create/revoke path, provisioned alert rules, and backup/restore exercises.

# W48-CX4 / Cycle 95 - Artifact Storage Runbook and Compose Syntax

- **Date:** 2026-09-25.
- **Scope:** Align the artifact storage runbook with DATA-01/02 `ArtifactStorageFacade`, S3 and PostgreSQL adapters; validate the Connector Compose profile and its Redis prefix; run workspace lint/typecheck.
- **Status:** Documentation and syntax checks complete. No application code or running container was changed.

## Artifact operations update

- Replaced the stale PostgreSQL-only description in `docs/runbooks/artifact-storage.md` with the current per-artifact backend contract: S3 pinned object versions with metadata/size/SHA-256 validation, and PostgreSQL blob storage with the content hash as generation ID.
- Added outage triage, privacy-safe metadata queries, integrity-failure handling, S3 restore checks, and backup/restore criteria for both storage backends.
- Documented the PostgreSQL fallback boundary precisely: the backend is selected at startup and there is no automatic per-request failover. A PostgreSQL-only mode can accept new PostgreSQL-backed artifacts, but cannot read existing S3-backed rows while the S3 client is absent. The runbook requires pausing affected work and owner approval; it prohibits changing stored backend metadata or copying data ad hoc. Returning to S3 mode composes the S3 and PostgreSQL facades, so PostgreSQL-backed artifacts remain readable.
- Cross-bucket locator migration remains an escalation gate; this runbook does not claim that capability is implemented.

## Compose and typecheck receipts

- `infra/docker-compose.yml` already quotes `REDIS_KEY_PREFIX` as `"du:connector:test:"`; no syntax edit was necessary. Parsing the rendered Compose JSON retained the exact scalar `du:connector:test:`.
- `docker compose -f infra/docker-compose.yml --profile connector config --quiet`: **passed**.
- `docker compose -f infra/docker-compose.yml --profile connector ps --all`: **passed**, read-only. It listed PostgreSQL and Redis containers already running (created about two hours before this check); no container was started or stopped. Their current published-port display was `0.0.0.0`, while the checked Compose file declares loopback binds (`127.0.0.1`). Record this as existing-container/config drift for the environment owner to reconcile; this task did not alter the running stack.
- `pnpm lint`: **passed** (exit 0); TypeScript `tsc --noEmit` completed for all 13 workspace projects exposing a lint script.
- No test suite, database query, migration, S3 request, provider call, credential mutation, or data-plane recovery was run.

# W48-CX4 / Cycle 96 - SEC-INT-02 Vault/OIDC Operations Runbook

- **Date:** 2026-09-25.
- **Scope:** Added `docs/runbooks/vault-oidc-operations.md` and linked it from `docs/runbooks/README.md`. No live Vault/IdP, DB/Redis, container, credential, or application deployment operation was performed.
- **Status:** Draft rehearsal plan prepared. SEC-00 decisions and SEC-INT-01/02 integration evidence remain prerequisites for production enablement.

## Runbook coverage

- **Vault bootstrap:** Documents the default KV v2 `secret` mount and `du/connector` prefix, the exact `orchestrator-writer` and `connector-reader` policy files, least-privilege capabilities, service identity separation, audit-device precondition, and the no-identity rule for worker/browser. Mount and auth method changes are gated on SEC-00 approval.
- **Unseal/outage/renewal:** Adds read-only status/mount/audit triage, guarded KV v2 setup, auto-unseal/KMS and Shamir custodial recovery, failure classification, fail-closed behavior, bounded renewal and re-authentication guidance, and metadata-only reconciliation for ambiguous writes. Expired tokens are not treated as renewable.
- **Revocation/rollback:** Provider-side revocation is first for compromised provider keys; privileged Vault token/version actions remain separate from app policies. Planned rollback is allowed only to a still-valid, non-compromised pinned version; emergency rollback to compromised material is prohibited.
- **OIDC provider and environment template:** Captures IdP client, issuer/allowlist, HTTPS callback, Authorization Code + PKCE S256, RS256 and server-side claims requirements. The `.invalid` sample contains only non-secret values and file references; variable names are explicitly marked as reference-only until application wiring is approved.
- **Audit/observability:** Adds a sink matrix covering ProblemDetails, Admin HTML/browser state, logs/collectors, metrics, traces, jobs/outbox/Redis, webhook/usage, revision/audit records, and Vault audit. SEC-INT-01 sentinel scans remain required.
- Added the runbook to the operational runbook index. The document states that generated policies/in-memory fixtures are not proof of real Vault deployment or end-to-end OIDC integration.

## Verification and boundary

- `pnpm lint`: **passed on the final full-workspace run** (exit 0); `tsc --noEmit` completed for all 13 workspace projects with lint scripts.
- The first lint invocation reported Connector revision-row type diagnostics (`ACTIVE | DISABLED` versus the VAULT-01 lifecycle union). On inspection the current source query types matched `PENDING | ACTIVE | RETIRED`, and the subsequent full rerun passed. No source-code edit was made in this task.
- No tests were run, per the live-test prohibition. No Docker command, DB/Redis container access, database query, migration, Vault/IdP request, unseal, token issuance/renewal, or secret operation was performed.
- SEC-INT-02 clean deployment rehearsal, real policy/auth positive-negative matrix, renewal/expiry and outage/rollback evidence, sink-sentinel scans, and owner sign-off remain outstanding before G-SEC/P8 closure.

# W48-CX4 / Cycle 97 - P8-06 Operations Checklist and Recovery Drills

- **Date:** 2026-09-25.
- **Scope:** Added `docs/ops/p8-06-ops-checklist.md` with pre-release deployment checks, actual service health semantics, migration/backup/shutdown gates, four isolated recovery drill procedures, and a post-drill evaluation template.
- **Status:** Checklist prepared; P8-06 is still open pending production packaging and reviewed deployment/recovery evidence. The checklist does not represent a completed live drill.

## Checklist coverage

- Documents Orchestrator `/health` and `/api/v1/health` as combined DB/Redis readiness (not liveness), including the 200 plus `status: degraded` queue-integrity case; Connector `/health/live` and `/health/ready`; and worker registration/heartbeat readiness without an HTTP probe.
- Records deployment blockers from `infra/deployment-architecture.md`: no packaged Orchestrator entrypoint/signal handlers, Connector migrations currently run at startup without a one-shot migration owner, worker-to-Connector identity integration proof outstanding, and current Compose assets are not production topology.
- Adds pre-release package, secret/configuration, health, migration, graceful shutdown, backup/restore, and release decision checkpoints.
- Defines guarded, synthetic-only drills for stuck task dispatch outbox, BullMQ worker drain, S3 outage plus the limited PostgreSQL-only fallback/recovery contract, and DB disconnect/reconnect. Each drill specifies expected evidence and prohibits hand-editing durable DB/Redis/queue state.
- Includes a reusable post-drill report template and explicit GO/NO-GO exit gate.

## Verification and boundary

- `pnpm lint`: **passed** (exit 0); TypeScript checks completed for all 13 of 14 workspace projects that expose a lint script.
- The first run surfaced an existing Orchestrator type error in the Vault credential metadata projection. Updated `services/orchestrator/src/modules/connector-credentials/workflow.ts` to explicitly return the masked source fields (`kind`, mount, path, key, pinned version), excluding the Vault account and unneeded version property. The final full-workspace run passed.
- No test suite was run. No Docker/Compose command, container access, health request, DB/Redis connection, migration, backup/restore, S3 operation, or live drill was performed.
- P8-06 remains gated on a production Orchestrator process/liveness package, serialized Connector migration ownership, worker/Connector identity reconciliation, and approved isolated deployment, shutdown, backup/restore, and recovery-drill receipts.

# W48-CX4 / Cycle 98 - P8-08 Release Readiness Audit

- **Date:** 2026-09-25.
- **Scope:** Added `docs/18-release-readiness-audit.md`, reconciling P8-01..08 acceptance, published live/offline evidence for MM-05/MM-10b, BR-12, DATA-01/02/04, VAULT/OIDC, egress, and the S3/Vault/OPS runbooks, plus current G6 blockers and compatibility-report corrections.
- **Decision:** **NO-GO; G6 not passed.** P8-08's audit artifact is delivered, but the release gate remains open. The report does not alter task-board history or authorize cutover.

## Audit findings

- Recorded the latest Tester MM-05 receipts as live scenario evidence: `p8-02c-mm05-rearm` **5/5 ×3** and `p8-02b` **6/6 ×3**; preserved the latest review's remaining re-arm eligibility race and queue-health uncertainty/staleness concerns. MM-10b's earlier live receipt is **6/6 ×3**.
- Distinguished Cycle 95 BR-12 implementation/offline evidence (**4/4**, Worker SDK claim context **30/30**, contracts **80/80**) from missing current-build live HTTP/multi-service proof; noted the newer per-business token source path and stale review/traceability disposition.
- Recorded DATA-01/02 (**38/38** and **8/8**) and DATA-04 (**69/69**, plus Cycle 96 selected metadata regressions) as offline-only evidence; migrations, versioned S3, cross-service publication, restore, and G-DATA remain unverified.
- Recorded OIDC fake-IdP **23/23** and session-store **17/17** offline evidence. The latest located OIDC-03/Admin live matrix is **11/12, exit 1**: X2 leaked the foreign operation UUID in its 404 title; the requested build gate also failed before the live-test typecheck. No later passing Tester receipt was located.
- Updated egress assessment to reflect the later `@du/egress` source hardening (no unpinned global-fetch fallback, unsupported bodies fail closed) and Cycle 97's offline **91/91** aggregator; did not carry the older complex-body finding forward as current source state.
- Classified S3 artifact, Vault/OIDC operations, and P8-06 OPS checklist as documentation/preparation, not deployed integration or live drill receipts. Migration 005 has a run request but no apply/schema-verification receipt.
- Reconciled P8 summary marks against current acceptance banners and independent review. Explicitly noted the P8-03 summary/detail mismatch, P8-01/05/06/07 gaps, G-SEC/G-DATA/G-ADMIN-OPS requirements, and withdrawn legacy facade/long-poll compatibility claims in the older readiness report.

## Verification and boundary

- `pnpm lint`: **passed** (exit 0); TypeScript checks completed in all 13 workspace projects that define a lint script (13 of 14 workspace projects).
- No tests were run. No DB window, database/Redis connection, container/Compose operation, live health request, migration, Vault/IdP/S3 access, backup/restore, or recovery drill was performed.
- All historical counts in the audit are cited receipts; this audit did not rerun or independently reproduce them. G6 remains **NO-GO** until current-source fixes, release-gate evidence, and owner sign-off are complete.

# W48-CX4 / Cycle 99 - P8-01 Traceability Matrix and Test Inventory Reconciliation

- **Date:** 2026-09-25.
- **Scope:** Reconciled recent offline/live receipts, open evidence gaps, operational documents, and release disposition in docs/35 and docs/28. Historical fleet totals are explicitly labeled as a dated snapshot; no new aggregate was inferred.
- **Evidence basis:** Published Tester, Reviewer, Codex-New, Codex-5, Qwen-1/2/3, and prior Codex-4 receipts. Counts in the two documents are named command/suite receipts, not reruns.

## Reconciled areas

- BR-12: recorded 4/4 focused claim-boundary, Worker SDK 30/30 and contracts 80/80 offline evidence, while retaining the latest reviewer finding for other cross-business worker-token runtime routes.
- VAULT-01..05 and OIDC-01..04: recorded focused offline counts and skip qualifiers; marked VAULT-04 browser proof absent; preserved OIDC-03 LIVE-005 at 11/12, exit 1, with the preflight build failure and the latest session precedence, tenant-scope, and audit-transaction findings.
- DATA-01..04: recorded 38/38, 8/8, 14/14, and 69/69 focused offline receipts, along with the later worker-SDK 146/147 default-suite red and missing real S3/PostgreSQL proof.
- Webhook reclaim and egress: recorded the later 91/91 five-suite offline aggregate (superseding 88/88) and retained the queued PostgreSQL reclaim proof and missing Orchestrator shutdown-drain wiring.
- R1-D/MM-06/07/08: added the 9/9, 82/82 with 3 skipped, 24/24 with 1 skipped, 11/11, 7/7 with 2 filtered, and expanded 12/12 receipts, distinctly from the absent Migration 005 apply/rollback receipt.
- MM-05/MM-10b: preserved Tester live receipts p8-02c 5/5 ×3, p8-02b 6/6 ×3, MM-10b 6/6 ×3, and p8-02-fault-recovery 20/20 with the latest review caveats.
- P8-06 checklist, P8-07 dashboards, and P8-08 release audit are classified as documentation/preparation. The audit disposition remains NO-GO / G6 not passed.

## Verification and boundary

- pnpm lint: **exit 0**, all 13 of 14 workspace projects that define a lint script completed.
- Markdown link check for docs/28 and docs/35: **77 targets checked, 0 broken**.
- git diff --check scoped to docs/28 and docs/35: **exit 0**.
- Whole-worktree git diff --check returned exit 1 on unrelated existing whitespace in components/HeaderNav.tsx, coordination/MONITORING-LOG.md, and coordination/dispatch-receipts.md; those files were outside this task and were not edited.
- No tests were run. No DB window, DB/Redis connection, container or Compose command, migration, live health request, S3/Vault/IdP access, or release drill was performed.

# W48-CX4 / Cycle 100 - P8-01 Traceability and Test Inventory Refresh

- **Date:** 2026-09-25.
- **Scope:** Updated `docs/35-acceptance-baseline.md` and `docs/28-test-inventory.md` with the final W48-QW1-LIVE-006 receipt and recent Cycle 99-100 offline achievements. Counts are reported by named receipt; no overlapping test counts were added together.
- **LIVE-006:** Tester report confirms the final ADM-BASE-02 / OIDC-03 matrix **12/12 PASS**, build exit 0, test exit 0. It supersedes the earlier LIVE-005 11/12 failure and initial LIVE-006 compile failure. The run belongs to the prior Tester-owned live window; this documentation task did not open a DB window or use DB/Redis.
- **Offline achievements:** PR-Q3-11 shutdown.ts/main.ts six-suite matrix **97/97** (build/lint exit 0); VAULT-04 credential actions **20/20**; LOG-01 logger/redaction **22/22**; BR-12 privilege narrowing **18/18**. OIDC-04 flow **7/7** and Admin Shell mount **6/6** are also inventoried as offline evidence.
- **Disposition:** Preserved remaining scope: broader OIDC session/tenant and browser evidence, independent post-fix BR-12 review and live multi-service proof, Vault browser flow, production observability sinks, Compose `dist/main.js` alignment and live shutdown smoke. The separate broad Orchestrator receipts remain non-green (Qwen-1: 38/40 suites, 1012/1016 tests; Qwen-2: 38/40 suites, 1013 passed with two suite failures); they are not combined. G6 remains NO-GO.

## Verification and boundary

- `pnpm lint`: **exit 0**, all 13 workspace projects defining lint scripts completed (13 of 14 projects).
- Markdown local-link check for docs/28 and docs/35: **89 targets checked, 0 broken**.
- Whitespace check of the Cycle 100 additions in the two inventory documents and this report: **0 trailing-whitespace lines**.
- No tests were run by Codex for this documentation update. No DB window was opened; no DB/Redis connection, container/Compose operation, live test, migration, or recovery drill was performed.

# W48-CX4 / Cycle 126+ — Reviewer 120–125 Evidence Reconciliation

- **Date:** 2026-09-25.
- **Scope:** Reconciled Tester-2 Batches 7–8 into the evidence inventory and acceptance baseline, corrected the current `tasks/README.md` headline to the Reviewer canonical row counts, checked local Markdown links, and ran workspace lint.
- **Evidence source:** [Reviewer Cycle 120–125 audit](review.md), [Tester-2 receipt](tester2.md). These are copied receipts, not reruns by Codex.

## Batch 7–8 receipts and safety qualifiers

- **Batch 7 — Document-Core:** Safe PowerShell command was `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`. Receipt: **37 suites passed, 3 failed; 474 tests passed, 13 failed, 3 skipped; exit 1**. The live PostgreSQL/Redis multi-container suite and DB-writing usage-projection test were filtered out and Redis smoke was disabled. Tester-2 reports no DB window, DB/Redis connection, or database writes. The three Jest skips are not passes; filtered live behavior remains unverified. The receipt supplies summary output, not raw Jest stdout.
- **Batch 8 — Example-Review:** `pnpm --filter @du/example-review test:unit` intentionally excluded three DB/Redis `*.integration.test.ts` suites. Receipt: **5 unit suites passed, 8 failed compilation (13 unit suites total), 64 executed tests passed**. The compile failures are TS2739 missing `readWithMetadata`, `readStream`, and `writeStream` in test artifact facades. Tester-2 reports no DB window, DB/Redis connection, or database writes. The receipt summary does not state an explicit process exit code or include raw Jest stdout. Excluded live suites are unverified, not passing.
- **Batches 1–8 Reviewer aggregate at the Cycle 120–125 snapshot:** **97 passing suite executions, 11 failed suite executions, 2 skipped suites; 1,291 passing test executions, 13 failed test executions, 11 skipped test executions.** Repeated executions are not unique cases. This prior aggregate and its red Batch 7–8 package status are retained as history; final retests supersede those two batch results below. Batch 5's 2 skipped suites / 8 skipped tests and Batch 7's 3 skipped tests remain skips, never passes. See [inventory §8.8](../../docs/28-test-inventory.md#L435) and [baseline §12.11](../../docs/35-acceptance-baseline.md#L598).
- Reviewer also scopes Runtime **97/97** and RR-Q3-4 **2/2** to pre-`DU_LIVE_INFRA`-guard receipts. Current guard-on live runs still require a Tester-owned window; default skipped hooks do not verify live behavior.

## Canonical task headline

- P0–P8: **57 `[x]` / 3 `[~]` / 11 `[ ]` = 71 rows**, 80.3% ticked.
- Separate SEC/ADM/OIDC/VAULT/SEC-INT scope: **0 `[x]` / 0 `[~]` / 16 `[ ]`**.
- Combined P0–P8 + SEC: **57 `[x]` / 3 `[~]` / 27 `[ ]` = 87 rows**, **57/87 ticked (65.5%)**. This is a row-status ratio, not a readiness score; open release gates remain. The current headline is in [tasks/README.md](../../tasks/README.md#L3), with canonical detail in [the Reviewer audit](review.md#L22).

## Verification and boundary

- **Markdown local-link check:** Ran the PowerShell command below from `D:\Git\dugate\du-rework` against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/README.md`, and this report. Result: **224 local targets checked, 45 line anchors checked, 0 broken; exit 0**.
- **Workspace lint:** From `D:\Git\dugate\du-rework`, `pnpm lint` — **exit 0**. `pnpm -r run lint` covered 13 of 14 workspace projects with lint scripts; all 13 `tsc --noEmit -p tsconfig.json` jobs passed: contracts, observability, document-kit, browser, login, egress, worker-sdk, example-review, document-core, orchestrator, connector, connector-client, and integration.
- Verification commands:

```powershell
$files = @('docs/28-test-inventory.md','docs/35-acceptance-baseline.md','tasks/README.md','coordination/reports/codex4.md')
$left = [regex]::Escape([string][char]91)
$right = [regex]::Escape([string][char]93)
$open = [regex]::Escape([string][char]40)
$close = [regex]::Escape([string][char]41)
$pattern = '(?<!!)' + $left + '[^\]]+' + $right + $open + '(?<target>[^)]+)' + $close
$broken = [System.Collections.Generic.List[string]]::new()
$checked = 0
$anchors = 0
foreach ($file in $files) {
  $source = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $file))
  foreach ($link in [regex]::Matches([System.IO.File]::ReadAllText($source), $pattern)) {
    $target = ($link.Groups['target'].Value.Trim() -split '\s+', 2)[0].Trim('<','>')
    if ($target -match '^(https?:|mailto:|tel:|data:|//)') { continue }
    $parts = $target -split '#', 2
    $relative = [System.Uri]::UnescapeDataString($parts[0])
    $resolved = if ([string]::IsNullOrWhiteSpace($relative)) { $source } else { [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $source) $relative)) }
    $checked++
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { $broken.Add("$file -> $target (missing file)"); continue }
    if ($parts.Count -gt 1 -and $parts[1] -match '^L\d+$') {
      $anchors++
      if ([int]$parts[1].Substring(1) -gt [System.IO.File]::ReadAllLines($resolved).Length) { $broken.Add("$file -> $target (line anchor out of range)") }
    }
  }
}
"Files scanned: $($files.Count)"
"Local targets checked: $checked"
"Line anchors checked: $anchors"
"Broken targets: $($broken.Count)"
$broken
if ($broken.Count -gt 0) { exit 1 }
```

- Lint output: **Scope: 13 of 14 workspace projects**; every listed lint job completed successfully. No tests were run. No DB window, DB/Redis connection, container operation, migration, live test, commit, or push was performed.
- No test suites were run. No DB window, DB/Redis connection, container operation, migration, live test, commit, or push was performed.

# W48-CX4 / Cycle 126+ — Tester-2 Batch 7–8 Green Receipt Update

- **Date:** 2026-09-25.
- **Scope:** Reconciled the final Tester-2 retests in [receipt Batch 7](tester2.md#L128) and [receipt Batch 8](tester2.md#L151) into [docs/28 §8.9](../../docs/28-test-inventory.md), [docs/35 §12.12](../../docs/35-acceptance-baseline.md). Earlier failures remain in the Tester-2 report and the Cycle 120–125 audit sections as superseded history.

## Latest safe receipts

- **Batch 7 — Document-Core:** Same safe command and filters as the initial receipt: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`. Final receipt: **40/40 suites passed; 487 tests passed, 3 skipped (490 total); exit 0**. Updating `sdk-consumer.test.ts` resolved the prior failures. The multi-container DB/Redis suite and DB-writing usage projection case remained filtered; Redis smoke was disabled. The three skipped tests remain skipped, and the excluded live paths remain unverified. Tester-2 reports no DB window, PostgreSQL/Redis connection, or database writes.
- **Batch 8 — Example-Review:** `pnpm --filter @du/example-review test:unit` passed **13/13 unit suites, 119 tests, exit 0** after fixing the ArtifactFacade test fixtures. The three PostgreSQL/Redis integration suites remain excluded from `test:unit` and were not verified. Tester-2 reports no DB window, service connection, or database writes.
- **Updated Batches 1–8 aggregate:** Replacing the prior Batch 7/8 receipts in the Reviewer total yields **108 passing suite executions, 0 failed suite executions, 2 skipped suites; 1,359 passing test executions, 0 failed test executions, 11 skipped test executions**. Arithmetic: suites `97 + (40-37) + (13-5) = 108` passes and `11 - 3 - 8 = 0` failures; tests `1,291 + (487-474) + (119-64) = 1,359` passes and `13 - 13 = 0` failures. These are repeated executions, not unique cases. Batch 5's 2 skipped suites / 8 skipped tests and Batch 7's 3 skipped tests are not passes; Batch 8's excluded live integration suites are outside the executed unit scope and are not counted.

## Verification and boundary

- **Markdown local-link check:** Reran the PowerShell inline verifier from the preceding Cycle 126 verification section over the same four files (`docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/README.md`, and this report). It checks local file targets and explicit line anchors against actual file line counts. Result: **240 local targets and 59 line anchors checked, 0 broken; exit 0**.
- **Workspace lint:** `pnpm lint` — **exit 0**. It ran `pnpm -r run lint` over **13 of 14** workspace projects defining lint scripts; all 13 TypeScript checks passed: contracts, observability, document-kit, browser, login, egress, worker-sdk, document-core, example-review, orchestrator, connector, connector-client, and integration.
- No test suites were run by Codex. No DB/Redis window or connection, container operation, commit, or push was performed.

# W48-CX4 / Reviewer Finding 3 — README Evidence Banner Correction

- **Date:** 2026-09-25.
- **Change:** Updated [tasks/README.md current banner](../../tasks/README.md#L3) to remove the stale claim that Batches 7–8 are red. It now records Batch 7 **40/40 safe suites passed** (487 tests passed, 3 skipped) and Batch 8 **13/13 unit suites passed** (119 tests passed), while keeping filtered/excluded live DB/Redis paths marked unverified.
- **Metric separation:** The [eight-package safe matrix](tester2.md#L176) remains **1,130 tests passed** (90 suites passed, 1 suite and 4 tests skipped, 0 failures). Separately, the [Batches 1–8 repeated-run aggregate](../../docs/28-test-inventory.md#L453) is **1,359 passing test executions**, with 108 passing suite executions, 2 skipped suites and 11 skipped test executions. The latter counts repeated executions; these metrics have different scopes and are not interchangeable.
- **Link check:** Reran the PowerShell local-target and line-anchor checker documented in the Cycle 126 section above after editing the banner. It scanned **4 Markdown files**, checking **244 local targets and 64 line anchors**, with **0 broken; exit 0**.
- No DB window, database/Redis connection, test run, container operation, commit, or push was performed. No lint command was requested or run for this banner-only change.

# W48-CX4 / Cycle 127 — OIDC-02 Live Redis Receipt Reconciliation

- **Date:** 2026-09-25.
- **Scope:** Added Tester-1's OIDC-02 live receipt to [test inventory §8.10](../../docs/28-test-inventory.md), [acceptance baseline §12.13](../../docs/35-acceptance-baseline.md), and the OIDC-02 rows in both inventories. Source: [Tester-1 receipt](tester.md#L6528).
- **Receipt:** From `services/orchestrator`, Tester-1 ran `npx.cmd jest tests/oidc02-multi-replica-offline.test.ts --runInBand` with `DU_LIVE_INFRA=1` and `REDIS_URL=redis://127.0.0.1:6380`, during the claimed **12:31:11.992–12:31:18.887 +07** window. Result: **1 suite, 16/16 passed, exit 0**—13 offline cases plus all three live Redis cases.
- **Verified live scenarios:** SHARE (session minted on replica A authenticates at B), REVOKE (replica B observes both same-principal sessions revoked by A), and EXPIRY (idle and absolute expiration against the real clock).
- **Qualifier:** Tester-1's output includes Jest's post-completion open-handle warning. Its process audit found unrelated Connector Jest runners but no remaining OIDC-02 Jest process. The passing receipt applies to the named suite and scenarios; broader browser/real-IdP and OIDC/G-SEC acceptance remain separate.
- This Codex-4 documentation update did not access DB/Redis or rerun tests.

## Verification

- **Markdown link check:** Ran the PowerShell local-target/line-anchor checker documented in the Cycle 126 section above over `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/README.md`, and this report. Result: **4 files, 255 local targets, 71 line anchors, 0 broken; exit 0**.
- **Lint:** `pnpm lint` — **exit 0**. It ran `pnpm -r run lint` over **13 of 14** workspace projects with lint scripts; all 13 TypeScript checks passed.

# W48-CX4 / SEC-INT-01 — Tester-1 Credential Lifecycle Receipt

- **Date:** 2026-09-25.
- **Scope:** Reconciled the Tester-1 live receipt into [test inventory §8.11](../../docs/28-test-inventory.md), [acceptance baseline §12.14](../../docs/35-acceptance-baseline.md), and the current SEC-INT-01 rows. Source: [Tester-1 receipt](tester.md#L6755).
- **Run:** CWD `D:\Git\dugate\du-rework`; `npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/sec-int-01-credential-lifecycle.integration.test.ts --runInBand`; `DU_LIVE_INFRA=1`, `DU_SECINT=1`. CLAIM **2026-09-25 13:12:30.938 +07:00**; RELEASE **13:12:44.993 +07:00**.
- **Result and scope:** **1 suite, 5/5 passed, ExitCode 0.** This exercised Orchestrator→Connector HTTP and PostgreSQL connector migrations 006/007 with the in-repository Vault dev fixture and token-renewal daemon. It does not prove external Vault deployment/auth or the separate provider-invocation follow-on.
- **Qualifier:** Jest emitted an open-handle warning after the passing summary; Tester-1 recorded successful command completion and immediate DB-window release. This Codex-4 turn only read the receipt and edited documentation; it did not access DB/Redis or run tests.

## Offline link-check receipt

- Ran the PowerShell local-target/line-anchor checker documented in the Cycle 126 section above against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/README.md`, and this report. Result: **4 files, 265 local targets, 78 line anchors, 0 broken; exit 0**.

# Cycle 138 — P8-01 Live Traceability Receipt Sync

- **Source receipt:** [Tester-1 P8-01 run](tester.md#L6781), corroborated by the [Cycle 132–137 Reviewer audit](review.md#L13). Claim **2026-09-25 13:14:39.296 +07:00**; release **13:14:48.821 +07:00**; suite `tests/integration/p8-01-traceability.integration.test.ts`; **1/1 passed, 8.348 s, ExitCode 0**.
- **Documentation:** Added the receipt and scope qualifier to [test inventory §8.12](../../docs/28-test-inventory.md#L472) and [acceptance baseline §12.15](../../docs/35-acceptance-baseline.md#L634), including their live-receipt tables. Both inventory documents are now v1.12.0.
- **Scope and hold:** This is one live `extract` action with persisted cancellation and cancel/audit trace join. The raw output includes a post-cancel `TASK_TERMINAL` fence log; the test does not assert a specific fence response. P8-01 remains `[ ]` in [the release task matrix](../../tasks/P8-release-readiness.md#L15) until the full BR/test/endpoint matrix and remaining action/endpoint trace scope are reconciled and any claimed terminal-fence behavior is explicitly asserted.
- **Offline link check:** Ran the PowerShell local Markdown target and `#L<number>` checker documented in the Cycle 126 verification block, against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/README.md`, and `coordination/reports/codex4.md`. Result before this receipt was added: **4 files, 278 local targets, 88 line anchors, 0 broken; exit 0**. A final post-report run is recorded below.
- **Final post-report link check:** Reran that same checker after adding this receipt. Result: **4 files, 283 local targets, 93 line anchors, 0 broken; exit 0**.
- **Workspace lint:** Command `pnpm lint` (script invokes `pnpm -r run lint`) completed **exit 0**. Output scope was **13 of 14 workspace projects**; all 13 configured `tsc --noEmit -p tsconfig.json` jobs completed successfully. This is an offline lint/typecheck only.
- **Boundary:** Codex-4 did not open a DB window, connect to DB/Redis, run live tests, commit, or push.

## Cycle 138 follow-up — BR-11 traceability matrix reconciliation

- **Matrix update:** Revised [§2 BR-11](../../docs/19-traceability-audit-matrix.md#L32) to cite the exact integration test and case, record the `extract` action and admin cancel endpoint, and identify the still-uncovered `ingest`, `analyze`, `transform`, `generate`, and `compare` action cells. Added [§9 live execution evidence](../../docs/19-traceability-audit-matrix.md#L239) with the linked operation → root task → invocation grant → Connector invocation/provider request ID → usage event → admin audit event assertions.
- **Tester receipt:** The live run was Tester-1-owned, CLAIM **2026-09-25 13:14:39.296 +07:00**, RELEASE **13:14:48.821 +07:00**, **1/1 passed, 8.348 s, ExitCode 0** ([Tester receipt](tester.md#L6781), [Reviewer audit](review.md#L13)). It is one `extract` action; `TASK_TERMINAL` / `fail report fenced` appears in raw output, but the test does not assert a specific fence response. P8-01 remains `[ ]` pending complete matrix reconciliation and remaining action coverage ([release task](../../tasks/P8-release-readiness.md#L15)).
- **Offline link check:** PowerShell local-Markdown checker over `docs/19-traceability-audit-matrix.md`, `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/P8-release-readiness.md`, `tasks/README.md`, and this report. It resolves relative and `file:///` local targets and validates numeric `#L` anchors; external web/mail/tel/data targets are skipped. Result before adding this receipt: **6 files, 306 local targets, 105 line anchors, 0 broken; exit 0**. Final post-report rerun: **6 files, 311 local targets, 110 line anchors, 0 broken; exit 0**.
- **Offline lint:** `pnpm lint` → `pnpm -r run lint`, scope **13 of 14 workspace projects**, all 13 TypeScript lint jobs completed; **exit 0**.
- **Boundary:** This documentation task did not open DB/Redis, run tests or migrations, commit, or push.

## Cycle 139 — Test inventory and acceptance baseline v1.13.0

- **Documents:** Updated [test inventory §8.13](../../docs/28-test-inventory.md#L484) and [acceptance baseline §12.16](../../docs/35-acceptance-baseline.md#L642) to v1.13.0. Added corresponding offline/live receipt rows and retained command-specific scope and skip qualifiers.
- **OIDC-02 live:** Tester-1's final two-process real-Redis drill ([receipt](tester.md#L6995)) claimed **15:00:51.876 +07:00**, released **15:01:13.043 +07:00**, built successfully and passed **1 suite / 10/10 tests, 0 skipped, Jest ExitCode 0**. Six cases were offline; all four live cases across two processes passed (login/session sharing, logout, rotation, idle expiry). Earlier failing/partial attempts remain in Tester history and are superseded for this final run. Tester noted a separate Orchestrator `test:unit` process after release whose owner/DB use was unverified; no OIDC open-handle warning was present.
- **Document-Core offline:** Tester-2 Step A ([receipt](tester2.md#L194)) passed **39 suites / 486 tests, 3 skipped, exit 0**; Step B ([receipt](tester2.md#L209)) passed **40 suites / 494 tests, 3 skipped, exit 0**. Both disabled Redis smoke and filtered BullMQ/multi-container and DB-writing usage-projection paths. They are separate snapshots, not additive; skips/exclusions remain unverified.
- **Tester-3 offline:** Worker SDK ([receipt](tester3.md#L35)) final full command passed **11 suites / 150 tests, exit 0** after an earlier 148/150 failure and focused retry. Example-Review ([receipt](tester3.md#L22)) passed **13 suites / 123 tests, exit 0**; preserve the actual 123 count versus expected 119, and keep the three excluded DB/Redis integration suites unverified.
- **VAULT-01 targeted offline:** Codex-6 Cycle 139 ([receipt](codex6.md#L70)) recorded a Connector `vault-account-isolation` + `secret-resolver` pair at **2 suites / 28 tests, exit 0**, and a distinct Orchestrator credential/Vault04/revision regression set at **3 suites / 47 tests, exit 0**. The 47 are not VAULT-01-only cases. The same Codex-6 snapshot recorded the full Connector unit command red (2 suites / 3 tests failed) and Orchestrator typecheck errors in S3 storage code; current Cycle 139 `pnpm lint` below passed the workspace. No deployed Vault acceptance is inferred.
- **Offline link check:** PowerShell Markdown-target/line-anchor checker ran against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/P8-release-readiness.md`, `tasks/README.md`, and this report; it resolves relative and `file:///` local paths and validates numeric `#L` anchors. Before adding this receipt: **5 files, 321 local targets, 118 anchors, 0 broken; exit 0**. Final post-report rerun: **5 files, 330 local targets, 126 anchors, 0 broken; exit 0**.
- **Workspace lint:** `pnpm lint` (runs `pnpm -r run lint`) completed **exit 0**, scope **13 of 14 workspace projects**, all 13 configured TypeScript lint jobs passed. Offline only; no tests were run by Codex-4.
- **Boundary:** Codex-4 did not open or connect to DB/Redis, run live tests/migrations, commit, or push.

## Cycle 150–155 — DATA-02 multipart evidence sync v1.14.0

- **Documents:** Updated [test inventory §8.14](../../docs/28-test-inventory.md#L498) and [acceptance baseline §12.17](../../docs/35-acceptance-baseline.md#L656) to v1.14.0. Added the DATA-02 multipart service-layer receipts and preserved the open acceptance gates.
- **Focused offline receipt:** Qwen-5 reports **3 suites / 63 passed, 0 failed, 0 skipped, ExitCode 0** (35 service, 13 internal-route, 15 S3-command cases) in the [lane report](qwen5.md#L93) and [raw output](qwen5-multipart-unit.log). The separate targeted regression was **11 suites / 137 passed, ExitCode 0** and includes those same 63 cases ([receipt](qwen5.md#L95)); counts are overlapping, not additive.
- **Reviewer qualifiers:** Cycle 150–155 records the broad Orchestrator unit snapshot as **red: 5 failed suites, 23 failed tests, 7 skipped, 1216 passed**, with loopback flakes varying across sweeps ([audit](review.md#L12)). Focused green receipts do not clear that aggregate. Migration `0015_artifact_multipart.sql` remains unapplied; the public `/api/v1/uploads` route, SDK multipart wiring, expiry-sweep scheduling and live S3/PostgreSQL lifecycle, replay, cleanup and RSS evidence remain open. DATA-02/G-DATA is implemented/offline-verified for the stated scope, not accepted.
- **Offline Markdown link check:** PowerShell local-link/line-anchor checker against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/P8-release-readiness.md`, `tasks/README.md` and this report; external URLs skipped, local targets and numeric `#L` anchors validated. Initial post-document-edit result: **5 files, 349 local targets, 140 line anchors, 0 broken; ExitCode 0**. Final post-report rerun: **5 files, 355 local targets, 145 line anchors, 0 broken; ExitCode 0**.
- **Workspace lint:** `pnpm lint` (`pnpm -r run lint`) completed **ExitCode 0**, scope **13 of 14 workspace projects**, all 13 configured TypeScript lint jobs passed. No test command was run.
- **Boundary:** Documentation and offline validation only. No DB/Redis/S3 connection, live test, migration, commit or push.

## Cycle 155 — Independent Tester-2 DATA-02 receipt

- **Documents:** Updated [test inventory §8.15](../../docs/28-test-inventory.md#L509) and [acceptance baseline §12.18](../../docs/35-acceptance-baseline.md#L666) to v1.15.0. Added Tester-2 as an independent corroborating receipt alongside Qwen-5; results from the repeated runs are not added as new test cases.
- **Tester-2 receipt:** [DATA-02 report](tester2.md#L233) records the same three multipart suites at **63 passed, 0 failed/skipped, exit 0**, and an 11-suite targeted regression at **137 passed, 0 failed/skipped, exit 0**. The regression includes the three multipart suites. Orchestrator `lint`/typecheck also passed, exit 0. Tester-2 states no DB window, no PostgreSQL `:5433` or Redis `:6380` connection, and zero DB writes.
- **Acceptance qualifier:** This is independent offline verification of the named fake-fixture scope; it does not close DATA-02/G-DATA. Existing holds remain: broad unit snapshot red, migration 0015 unapplied, public/SDK and expiry-sweep wiring incomplete, and live S3/PostgreSQL lifecycle evidence outstanding. See [Reviewer audit](review.md#L12).
- **Offline Markdown link check:** PowerShell local-link/line-anchor checker against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/P8-release-readiness.md`, `tasks/README.md` and this report. Initial post-document-edit result: **5 files, 357 local targets, 147 line anchors, 0 broken; ExitCode 0**. Final post-report rerun: **5 files, 361 local targets, 151 line anchors, 0 broken; ExitCode 0**.
- **Workspace lint:** `pnpm lint` (`pnpm -r run lint`) completed **ExitCode 0**, scope **13 of 14 workspace projects**, all 13 configured TypeScript lint jobs passed. Codex-4 ran no tests.
- **Boundary:** Documentation and offline validation only; no DB/Redis/S3 connection, live test, migration, commit, or push.

## D-EVID-A5 — A1–A5 evidence sync v1.17.0

- **Documents:** Updated [test inventory §8.16](../../docs/28-test-inventory.md#L517) and [acceptance baseline §12.19](../../docs/35-acceptance-baseline.md#L674) to v1.17.0. Receipt scopes distinguish offline/fake runs, DB-window execution, skip-mode and blocked live setup; no task row was ticked and no prior Reviewer report was edited.
- **Tester-1 live receipts:** P8-03 passed **1/1 suite, 7/7 tests, ExitCode 0** in its claimed PostgreSQL window ([receipt](tester.md#L7135)); it is suite-scoped and does not promote P8-03 to ACCEPTED. T-DATA-LIVE-1 found no S3 environment; later LIVE-2 brought MinIO to readiness with private/versioned bucket, but the PG/S3 suite was blocked at migration 0016 verification: **5/5 shared-setup failures, 0 test assertions**, with no migration or data writes ([LIVE-1](tester.md#L7171), [LIVE-2](tester.md#L7183)).
- **Qwen-3 reassigned lanes:** W49-Q3-24 is labeled `1R` and records an offline 55-suite aggregate with **3 suites / 4 tests failed, 9 skipped, 1235 passed; wrapper ExitCode 0**—still red due to two loopback-flake suites and mock-Vault TS2345 ([report](qwen3.md#L2793), [raw log](qwen3-orchestrator-unit-T-ORCH-AGG-1R.log)). Its targeted multipart **69/69**, Contracts **31/31**, and Worker-SDK **6/6** receipts remain scoped. W49-Q3-25 is also marked `1R`; skip-mode ×3 reported **6 passed / 7 skipped each run**, not live Redis evidence ([receipt](qwen3.md#L2841)).
- **Qwen-2 reassigned VAULT-01:** `W-VAULT01-BIND-1R` added **32 offline cases** (24 fake-DB, 8 schema pins); its three full Connector runs each report **19 passed / 2 live-gated suites skipped, 219 passed / 7 skipped tests, exit 0**. No real migration-008 apply is established ([§62](qwen2.md#L1333)).
- **Qwen-4R RSS:** Offline fake-transport suite passed **2/2 ×3**; its measured estimate is about **2× partSize live-set** and **5× high-water (~320 MiB at 64 MiB parts)**. The capacity budget recommendation remains for coordinator adjudication. The separate parseFile memo recommends option 2b (transfer-list) if parser-memory work is opened; no parser change or live S3/PG proof is claimed ([RSS verdict](qwen4r.md#L100), [memo](qwen4r.md#L153)).
- **Qwen-5R public DATA-02:** Public branch offline run **4 suites / 102 passed, 0 failed/skipped**, with repeat; branch and sweeper hook are offline implemented/verified. Δ1–Δ4 remain unadjudicated, migration 0016 is unapplied, and live public PG/S3 lifecycle remains blocked; DATA-02 stays open ([report](qwen5r.md#L8), [receipt](qwen5r.md#L72)).
- **Offline Markdown link check:** Reran the PowerShell local-target/line-anchor checker after the documentation and table edits across `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/P8-release-readiness.md`, `tasks/README.md`, and this report. External URLs were skipped; local paths, `file:///` targets, and numeric `#L` anchors were checked: **5 files, 424 local targets, 214 line anchors, 0 broken; ExitCode 0**.
- **Workspace lint:** `pnpm lint` (`pnpm -r run lint`) completed **ExitCode 0**, scope **13 of 14 workspace projects**, all 13 configured TypeScript lint jobs passed. No test command was run by Codex-4.
- **Boundary:** Documentation and offline validation only. Codex-4 did not connect to DB/Redis/S3, run tests, apply migrations, change Reviewer content, commit or push.

## Cycle 156–161 — Step C evidence reconciliation v1.16.0

- **Documents:** Updated [test inventory §8.14](../../docs/28-test-inventory.md#L498) and [acceptance baseline §12.17](../../docs/35-acceptance-baseline.md#L656) to v1.16.0. The DATA-02 rows now state that the Worker-SDK multipart branch is offline verified; public upload route, deployed expiry sweeper, migration 0015 and live S3/PostgreSQL lifecycle gates remain open.
- **Tester-3 Worker-SDK:** [Step C receipt](tester3.md#L65) reports Worker-SDK lint/typecheck and **12/12 suites, 171/171 tests, ExitCode 0**, including the network-boundary suite ([result](tester3.md#L75)). This verifies the SDK branch offline; the 171 already includes the multipart engine/facade tests and is not additive to Qwen-4's corroborating run. DATA-04/G-DATA still requires live end-to-end and measured RSS evidence.
- **Tester-3 Document-Core:** [Two selected safe suites](tester3.md#L78) passed **48/48** (`parser-budgets`) and **8/8** (`read-stream-acquisition`), totaling **2 suites / 56 passed, ExitCode 0**. Tester-3 reports no DB window, PostgreSQL/Redis connection, or DB writes ([boundary](tester3.md#L85)). The DB-writing P8-03 provider-convergence suite was deliberately not run; Qwen-4's separate 63/63 claim is not zero-DB proof. This is selected compatibility evidence, not a full Document-Core or end-to-end multipart gate ([Reviewer audit](review.md#L13)).
- **Offline Markdown link check:** PowerShell local-link/line-anchor checker against `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md`, `tasks/P8-release-readiness.md`, `tasks/README.md` and this report. Initial post-document-edit result: **5 files, 371 local targets, 161 line anchors, 0 broken; ExitCode 0**. Final post-report rerun: **5 files, 378 local targets, 168 line anchors, 0 broken; ExitCode 0**.
- **Workspace lint:** `pnpm lint` (`pnpm -r run lint`) completed **ExitCode 0**, scope **13 of 14 workspace projects**, all 13 configured TypeScript lint jobs passed. Codex-4 ran no tests.
- **Boundary:** Documentation and offline validation only; no DB/Redis/S3 connection, live test, migration, commit, or push.
