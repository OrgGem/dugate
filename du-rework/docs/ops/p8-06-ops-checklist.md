# P8-06 — Pre-release Operations Checklist and Drills

**Status:** rehearsal checklist; not production deployment evidence. Complete the
checklist against a named release and environment. A checked item must link to
reviewable evidence and an owner. The procedures below are for an approved,
isolated rehearsal only; they do not authorize actions against shared or
production infrastructure.

**Release:** `________________`  **Environment:** `________________`  
**Image digest(s):** `________________`  **Change / run ID:** `________________`  
**Service owner:** `________________`  **Operations approver:** `________________`

## Use and safety gates

- [ ] Name the target topology, region/network boundary, PostgreSQL and Redis
  endpoints and HA mode (managed failover endpoint or Sentinel), artifact
  backend, log sink, and ingress path. Confirm values against the approved
  environment inventory.
- [ ] Confirm this is a disposable rehearsal environment before any fault
  injection. Record the isolated project/namespace, synthetic tenant and
  operation IDs, restore point, rollback owner, and stop conditions.
- [ ] Confirm on-call coverage, change approval, maintenance window, and
  customer-impact communication. Define abort conditions before starting.
- [ ] Keep provider credentials, tokens, signed URLs, customer files, payloads,
  object keys, and database connection strings out of evidence and logs.
- [ ] Do not use the repository-root legacy Compose stack for `du-rework`.
  `infra/docker-compose.yml` is a local dependency fixture with test credentials,
  fixed container names, and host-published PostgreSQL/Redis ports; its optional
  Connector profile is a single-replica integration fixture, not production
  topology.
- [ ] Do not start a production rollout until the blockers in
  [`infra/deployment-architecture.md`](../../infra/deployment-architecture.md)
  are resolved and the relevant drills below have evidence.

## 1. Release and deployment package

- [ ] Pin and record immutable Orchestrator, Connector, and worker image digests,
  source revision, build provenance, Node/runtime base, and dependency lockfile.
- [ ] Confirm the production Orchestrator image packages `dist/main.js`, uses
  validated runtime configuration, and wires SIGTERM/SIGINT to the tested close
  path. The source now has `src/main.ts`, `npm start`, and graceful shutdown;
  **the production image/Compose recipe and deployment rehearsal remain open.**
- [ ] Confirm Connector image contains only runtime assets and required
  migrations; its exec-form entrypoint must leave Node able to receive signals.
  Do not copy `.env`, test credentials, customer data, or build caches into an
  image layer.
- [ ] Confirm production configuration does not include mock services, default
  credentials, test-only ports, or broad host binds. Publish only the approved
  ingress; keep Connector, PostgreSQL, Redis/Valkey, S3, and log storage private.
- [ ] Confirm Orchestrator and Connector use distinct database names/roles and
  scoped service identities. Worker hosts have no database credentials.
- [ ] Confirm secrets are supplied through the approved secret manager, rotated
  without printing values, and absent from image metadata, rendered config,
  command-line arguments, and run artifacts.
- [ ] Confirm deployment health checks have bounded interval, timeout, startup
  grace, and retry count; they must distinguish process liveness from dependency
  readiness and must not restart every replica for a provider-only outage.
- [ ] Confirm stop grace exceeds the configured drain deadline with a measured
  margin. Record each process's effective deadline and container/orchestrator
  kill deadline.
- [ ] Confirm the release has a reversible image/config rollback plan that
  preserves forward-compatible schema and durable queue/outbox state.

### Current topology constraints to close

- `infra/docker-compose.yml` is not a production Compose deployment. The
  production package/topology and cross-host deployment proof remain open.
- Orchestrator health is a combined dependency-readiness check, not a dedicated
  process liveness probe. No `/health/live` endpoint is present in this
  snapshot.
- Connector runs SQL migrations during startup. It has no separate one-shot
  migration command in this snapshot; do not scale multiple replicas against a
  database until a single serialized migration owner is established.
- Worker readiness is registration/heartbeat plus the expected queue and
  business version; Worker SDK has no HTTP health endpoint.
- Connector readiness currently reports PostgreSQL/Redis dependency readiness,
  not whether the process is draining. Remove it from ingress before SIGTERM.
- Connector service-identity authorization and the worker SDK invocation
  contract still require an approved integration proof before release.
- This source snapshot accepts a single `REDIS_URL` in Orchestrator, Connector,
  and Worker SDK. `infra/docker-compose.yml` has one Redis 7 service and no
  Sentinel. Sentinel is not a supported app topology until discovery/options are
  wired through every client and failover has been rehearsed; document whether
  the target instead uses a managed stable endpoint.

## 2. Health, readiness, liveness, and admission

| Component | Current check | Release acceptance | Caveat / evidence |
|---|---|---|---|
| Orchestrator | `GET /health` or `GET /api/v1/health` | For readiness, require HTTP 200 and inspect `db: true`, `redis: true`, and `status`. Capture `activeLeases` and `queueIntegrity` when present. On dependency failure expect HTTP 503. | This is **not** liveness. A queue-integrity `SUSPECT` can return HTTP 200 with body `status: degraded`; monitoring must inspect the body. Use a process-level liveness check until a dedicated probe is packaged. |
| Connector | `GET /health/live` | HTTP 200 `{ "ok": true }` while the process can serve the probe. | Process liveness only; it intentionally does not prove dependency health. |
| Connector | `GET /health/ready` | HTTP 200 `{ "ok": true }` when configured PostgreSQL and Redis checks pass; expect HTTP 503 when not ready. | Does not reflect drain state. Withdraw traffic before sending SIGTERM and verify no new requests are routed to the instance. |
| Worker | Runtime registration and heartbeat, plus queue/version mapping | Heartbeat is current, instance is healthy, compatible handler manifest and business/version are registered, and expected queue has a worker. | No HTTP probe. A healthy process on the wrong queue/version is not ready for this workload. |

- [ ] Exercise each configured probe from the same network namespace and identity
  the scheduler/load balancer will use; record URL/path, HTTP status, response
  fields, latency, and timestamp. Do not include credentials in the receipt.
- [ ] Confirm liveness does not depend on PostgreSQL, Redis, S3, or provider
  availability. Confirm readiness removes only the affected instance from
  traffic and does not trigger a synchronized restart loop.
- [ ] Confirm dependency outage produces the documented readiness failure and
  dependency recovery restores readiness without manual durable-state edits.
- [ ] Confirm alerts and dashboards have named owners, escalation routes, and
  tested source signals. P8-07 dashboard/alert thresholds remain configuration
  dependent until wired and verified in the target environment.
- [ ] Confirm no health response exposes secrets, tenant payloads, file names,
  signed URLs, or unbounded identifiers.

### Runbook and alert-matrix review gate

- [ ] Review [Operational Runbooks](../17-operational-runbooks.md), the
  [runbook index](../runbooks/README.md), and the scenario guides for
  [BullMQ drain](../runbooks/bullmq-queue.md),
  [outbox recovery](../runbooks/outbox-retry-fencing.md),
  [artifact storage/S3 outage](../runbooks/artifact-storage.md),
  [UNKNOWN reconciliation](../runbooks/unknown-reconciliation.md),
  [credential rotation](../runbooks/credential-rotation.md), and
  [Vault/OIDC operations](../runbooks/vault-oidc-operations.md) and
  [DATA-05 migration](../runbooks/data-05-s3-migration-runbook.md). Confirm each
  procedure matches the deployed image, schema, endpoint and feature flags.
- [ ] Review the [P8-07 alert matrix](./p8-07-dashboards-alerts.md) per
  environment. Every enabled alert has a real signal source, approved budget and
  evaluation window, severity, owner/on-call route, dashboard, linked runbook,
  and recent evidence. The catalog alone is not proof an alert is deployed.
- [ ] Keep PostgreSQL runtime state/outboxes separate from BullMQ delivery
  state. Confirm restart/recovery reconciles through durable outbox and lease
  sweep behavior; prohibit `FLUSHDB`, job deletion, lease edits, and manual row
  state changes in the incident procedures.
- [ ] Confirm Redis topology explicitly. For Sentinel, require wired Sentinel
  discovery/auth/TLS settings for Orchestrator, Connector, and workers plus
  quorum/leader/failover telemetry and an isolated failover drill. Otherwise,
  record the managed Redis endpoint and provider's failover/restore evidence.
  A successful application `PING` proves connectivity only, not Sentinel HA.
- [ ] Confirm artifact monitoring reads backend-specific signals: PostgreSQL
  `artifact_blobs` capacity/errors and S3 request/error, versioning, IAM/KMS,
  checksum and pinned-version failures. Health does not probe artifact I/O.
  Record `ARTIFACT_STORAGE_BACKEND` and `ARTIFACT_STORAGE_MIGRATION_WINDOW` per
  release. With S3 selected, unset retains dual-read compatibility and only an
  explicit `false` selects S3-only cutover; do not omit this setting after the
  migration inventory gate. It is not an outage failover switch, and switching
  to PostgreSQL does not make existing S3-backed artifacts readable.
- [ ] Record unsupported recovery actions as stop/escalate gates. In particular,
  this snapshot has no operator endpoint for changing `UNKNOWN` outcomes and no
  cross-bucket S3 locator remap; do not improvise SQL, Redis or object rewrites.

## 3. Migration and schema gate

- [ ] Capture a verified database recovery point before migration and record its
  identifier, time, checksum/receipt, retention location, and restore owner.
- [ ] Use exactly one migration owner for each database. For Orchestrator, record
  the migration CLI `status`, approved `migrate` result, and read-only `verify`
  result against the intended image/schema revision.
- [ ] For Connector, do not use the current startup migration behavior as a
  multi-replica migration strategy. Gate production rollout on an explicit
  serialized migration owner or documented single-instance migration phase.
- [ ] Verify migration receipts and schema state before enabling ingress,
  dispatchers, or workers. Check backward compatibility for the old/new image
  overlap window.
- [ ] Record rollback as application/config rollback with the forward schema
  retained unless a separately reviewed migration explicitly supports a safe
  down path. Do not improvise destructive rollback.

## 4. Graceful shutdown and restart

- [ ] Agree the traffic/admission sequence: withdraw ingress or stop new
  submissions/claims first, then send SIGTERM, then wait within the configured
  drain deadline.
- [ ] For Orchestrator, record active lease count before shutdown, drain result,
  remaining lease count at deadline, process exit status, and whether the
  container kill deadline was avoided. Current default lease drain is 30 seconds.
- [ ] For Connector, record in-flight HTTP and usage-outbox drain completion,
  configured `DRAIN_TIMEOUT_MS`, and exit status. Current default drain is 30
  seconds; readiness does not itself signal draining.
- [ ] For worker processes, use the Worker SDK stop path: stop accepting new
  deliveries, allow in-flight work/checkpointing within the configured grace,
  and observe heartbeat cessation. Current default worker stop grace is 15
  seconds.
- [ ] Confirm durable tasks/outbox entries survive restart and resume through
  stable IDs and normal recovery. Confirm no blind provider replay, lease edits,
  job deletion, or queue-wide purge occurred.
- [ ] Confirm logs distinguish requested shutdown, drain completion, deadline
  expiry, and forced termination without recording task payloads or secrets.

## 5. Backup, restore, and recovery readiness

- [ ] Confirm PostgreSQL backup covers Platform and Connector databases
  independently, uses the approved encrypted destination and retention, and
  has a verified checksum and recovery point. Keep credentials out of process
  arguments; use the protected service-file method documented in the deployment
  architecture.
- [ ] Restore only to an explicitly named isolated `du_restore_*` target with
  matching confirmation and checksum. Never restore over the source database.
- [ ] Verify schema/migrations, metadata references, task/invocation/outbox
  reconciliation, and a synthetic application read/write after restore.
- [ ] Confirm artifact restore matches the backend recorded per artifact:
  PostgreSQL blobs with metadata, and for S3 the exact pinned object versions
  plus bucket versioning. A database-only restore does not prove S3 objects are
  recoverable.
- [ ] Record measured RPO/RTO, backup age, recovery-point/object-generation
  alignment, checksums, restored reference checks, and remaining gaps. Do not
  report architecture targets as measured results.
- [ ] Confirm Redis persistence/recovery settings are documented and tested.
  PostgreSQL remains the durable business record; do not treat Redis queue state
  as the only recovery source.

## 6. Required isolated recovery drills

### Common drill controls

For every drill, use an approved disposable environment with synthetic data,
unique project/queue names, isolated credentials and buckets, a verified restore
point, an observer, and an abort/rollback owner. Capture a before/after baseline.
Inject failure only through an approved test fault mechanism scoped to that
environment; do not stop or alter shared PostgreSQL/Redis containers. Never
edit durable rows, lease fields, Redis keys, or BullMQ internals by hand. Stop
the drill if the blast radius exceeds the named resources or if recovery would
require an unreviewed destructive action.

### Drill A — Task dispatch outbox stuck

**Objective:** prove a temporarily unavailable queue path delays delivery
without losing or duplicating the durable dispatch.

1. Create one synthetic operation and record operation/task/delivery IDs and
   initial queue/outbox counts. Confirm the compatible worker is registered.
2. In the isolated environment, block or fault only the Orchestrator-to-Redis
   enqueue path using the approved network fault mechanism. Leave the database
   available and do not edit the outbox row.
3. Observe Orchestrator readiness, dispatcher error signals, due-row count and
   oldest age, retry/defer behavior, and queue state. Expected behavior: the
   task remains durable, failed enqueue is deferred (the current task dispatcher
   uses a 30-second `claim_until` delay), and no replacement delivery ID is
   minted.
4. Restore the Redis path. Observe normal dispatcher retry and stable BullMQ job
   ID deduplication. Confirm the worker claims and completes the original task
   once and the outbox reaches its expected dispatched state.
5. Compare initial/final IDs, counts, attempts, task state, and side-effect
   marker. Resolve only when there is no lost work or duplicate provider effect.

**Pass evidence:** timestamps and aggregate counts; redacted correlation IDs;
one stable delivery/job ID; recovery latency; no direct database/Redis mutation.
Use [Outbox retry and fencing](../runbooks/outbox-retry-fencing.md).

### Drill B — BullMQ worker drain

**Objective:** prove scale-in or deployment shutdown stops new claims and lets
in-flight work finish or recover through the normal lease path.

1. Seed a small synthetic queue backlog and one bounded in-flight task on the
   target business/version. Capture waiting/active/failed/stalled counts, oldest
   waiting age, compatible worker count, and current task lease/epoch metadata
   through approved operator views.
2. Withdraw the selected worker from new scheduling or initiate its supported
   graceful stop. Record signal time and configured drain grace; do not purge or
   move jobs between business versions.
3. Confirm no new deliveries are accepted by the draining instance. Confirm
   in-flight task completion/checkpoint before deadline, or capture the defined
   deadline outcome and normal durable lease recovery if the bounded task
   exceeds grace.
4. Start/retain a compatible worker with the same queue/version. Confirm pending
   work resumes, stale worker writes are fenced, and task/job IDs remain stable.
5. Compare queue counts, task outcomes, lease epochs, and synthetic side-effect
   markers. Confirm no duplicate external effect and no job deletion.

**Pass evidence:** queue snapshots, heartbeat/drain timeline, task state/epoch,
worker image/version and exit status. Use [BullMQ queue and worker](../runbooks/bullmq-queue.md).

### Drill C — S3 outage, bounded PostgreSQL write mode, and recovery

**Objective:** verify integrity-aware failure behavior and the documented
PostgreSQL-only write-mode boundary for synthetic artifacts.

1. In an isolated account/bucket, verify a versioned S3 canary can grant,
   upload, finalize, and read with the expected size and SHA-256. Record its
   persisted backend and pinned version metadata (never the signed URL/key).
2. Fault only the test service's S3 path. Confirm artifact operations fail
   explicitly; no artifact is marked `READY` without successful finalize and
   integrity validation. The normal health endpoint is not an S3 probe.
3. Determine whether any synthetic in-flight operation needs an S3-backed input,
   output, or checkpoint. If so, hold affected work and **do not switch** to
   PostgreSQL-only mode. The current PostgreSQL-only startup mode cannot read
   S3-backed rows and is not transparent failover.
4. Only if the service/data owner approves the bounded PostgreSQL write mode, verify
   PostgreSQL capacity and backup, change the startup backend through the
   release controller, and run a new PostgreSQL-backed grant/upload/finalize/
   authorized-read canary. Do not rewrite existing backend metadata or copy
   bytes manually.
5. Restore S3 network/IAM/KMS/versioning. Return to S3 mode through the approved
   release path. Read both the S3-backed canary and the PostgreSQL-backed canary;
   confirm exact size/hash and pinned S3 generation. Resume held work gradually
   after the alert window is stable.

**Pass evidence:** fault window, backend by canary, generation/hash/size checks,
held/resumed work and capacity/error observations. Integrity mismatch or missing
pinned version is a stop-and-escalate, not a fallback signal. Use
[Artifact storage](../runbooks/artifact-storage.md).

### Drill D — Database disconnect and reconnect

**Objective:** verify dependency readiness fails closed and the application
recovers after connectivity returns without losing durable state.

1. Use an isolated database and a scoped network proxy/fault rule to interrupt
   only the selected application's database path. Do not stop, restart, or
   modify a shared database container. Keep a separate observer channel for
   collecting the drill evidence.
2. Stop new synthetic submissions/dispatch as specified by the test plan, then
   apply the bounded disconnect. Observe Orchestrator `/health` (expect HTTP 503
   with `db: false`) and Connector `/health/ready` (expect HTTP 503). Connector
   `/health/live` should remain HTTP 200 while the process is alive.
3. Verify requests that require database durability fail safely or return their
   documented transient error; do not infer acceptance from an HTTP request
   whose durable commit result is ambiguous. Preserve IDs and reconcile through
   application/operator views after recovery.
4. Remove the fault and observe pool/client reconnection, Orchestrator and
   Connector readiness recovery, and normal dispatcher/worker progress. Reuse
   the same synthetic idempotency key when checking an ambiguous submission.
5. Reconcile pre/post task, invocation, and outbox state. Confirm there are no
   missing durable operations, duplicate provider effects, manual row edits, or
   secret-bearing errors in logs.

**Pass evidence:** fault scope/timing, probe responses, reconnect latency,
preserved IDs, reconciliation result and error redaction. Use the applicable
[queue](../runbooks/bullmq-queue.md) and
[outbox](../runbooks/outbox-retry-fencing.md) runbooks.

## 7. Post-drill evaluation template

Copy this section once per drill. Store the completed record with the approved
change/incident evidence; redact credentials, payloads, signed URLs, object
keys, and customer data.

```text
Drill ID / scenario:
Date and time (UTC), duration:
Change approval / run ID:
Environment and isolation proof:
Release revision and image digests:
Service owner / drill lead / observer:
Synthetic tenant, operation, task, queue, artifact IDs (redacted as needed):
Backend and relevant schema/migration revision:

Hypothesis:
Preconditions and verified recovery point:
Expected signals and pass criteria:
Abort conditions:

Fault start / stop and exact scoped injection:
Timeline of actions and observed events:
Health/readiness/liveness statuses and timings:
Queue/outbox/worker/task state before and after:
Artifact backend, generation, size/hash checks (if applicable):
DB reconnect / migration / restore evidence (if applicable):
Side-effect and duplicate-effect reconciliation:
Logs/metrics/traces reviewed; secret-sentinel result:
Customer or synthetic workload impact:
Rollback/recovery actions and measured recovery time:

Result: PASS / PASS WITH ACTIONS / FAIL / ABORTED
Evidence links/checksums:
Observed variance from expected behavior:
Open defects, risk, owner, due date:
Follow-up change or rerun required:
Operations decision and approver:
```

## Release exit decision

- [ ] Every mandatory checklist row is complete or has an explicitly accepted
  exception with named owner, risk, and expiry.
- [ ] All four drills have a reviewed report, including failures/aborts and
  remediation; a planned procedure alone is not a drill receipt.
- [ ] Backup/restore evidence includes both database domains and artifact
  generations required by the target recovery point, with measured RPO/RTO.
- [ ] Health semantics, drain deadlines, migrations, alert ownership, and
  rollback instructions match the exact deployed image/configuration.
- [ ] No unresolved critical correctness, security, data-integrity, or
  deployment blocker remains. Operations approver records **GO / NO-GO** and
  links the evidence set.

**Current release posture:** P8-06 remains open until the production package,
Orchestrator liveness wiring and drain verification, Connector migration serialization,
worker-to-Connector identity contract, selected Redis HA topology, deployed
alert routing, runbook review, and isolated deployment/recovery evidence are
completed and reviewed.

## References

- [Deployment architecture and known blockers](../../infra/deployment-architecture.md)
- [P8-07 dashboards and alerts](./p8-07-dashboards-alerts.md)
- [Outbox retry and fencing](../runbooks/outbox-retry-fencing.md)
- [BullMQ queue and worker](../runbooks/bullmq-queue.md)
- [Artifact storage](../runbooks/artifact-storage.md)
- [P8-07 operational runbooks](../17-operational-runbooks.md)
