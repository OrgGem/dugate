# UBW-02 — Startup Registration and Worker Registry/Control Contracts

Status: static source and report audit only. No product code, test code, migration, build, test, or database was changed or run. This report is the only file written for this task.

## Finding

The intended lifecycle is not implemented end to end. The SDK source comment promises manifest registration before heartbeat and consumption, but `startWorker()` performs no manifest request, derives its queue locally, starts the consumer before awaiting the first heartbeat, and only logs periodic heartbeat failures. The manifest endpoint already has useful immutable-version replay behavior, but it is platform-token-only and does not check that the URL identity matches the manifest body. The instance heartbeat endpoint is explicitly a compatibility stub: it validates limited identity, writes no state, and returns a synthetic `DEGRADED` lease. There is no persisted worker-instance registry or worker-control protocol.

This does not support authoritative Workers UI state yet. It does support a bounded implementation proposal below: reuse the immutable business-version registry, add a persisted instance lease, make startup registration precede consumption, and keep V1 worker management read-only.

## Source audit

### SDK startup order

- `orchestrator/packages/worker-sdk/src/worker.ts:23-30` documents `validate definition → register manifest → heartbeat loop → consume`, but `defineBusiness()` only validates the manifest and handler kinds at `:43-67`; there is no runtime registration call in `startWorker()`.
- `startWorker()` creates a RuntimeClient with `config.runtimeToken` at `worker.ts:172-176`, generates an instance ID and derives `queueName` locally at `:189-201`, and builds a heartbeat body from business ID, version, image digest, and concurrency at `:194-201`.
- The periodic timer starts before consumer construction at `worker.ts:206-211`. Failures only log a warning at `:207-209`; there is no retry policy, single-flight guard, local degraded state, or startup cleanup associated with the timer.
- The queue consumer is created at `worker.ts:255-266`; `consumer.start()` is called at `:441-445`; only afterward does the function await the initial heartbeat at `:447-448`. A rejected initial heartbeat therefore rejects `startWorker()` after consumption has begun. The startup path does not stop that consumer or clear the timer on this failure.
- Shutdown clears the periodic timer and then stops/drains the consumer at `worker.ts:456-474`. There is no explicit offline/deregister request; a future persisted lease should expire after shutdown.
- A source-only search for `defineBusiness(` and `startWorker(` found only the SDK definitions/exports, not a business-specific production callsite. The plan's “audit each business startup entrypoint” cannot be completed by naming a current business entrypoint file; discover and lease that path separately before changing one.

### Runtime registration and identity

- `orchestrator/services/orchestrator/src/http/routes/runtime.ts:21-36` distinguishes platform runtime credentials from business-scoped worker credentials. `assertPlatformRuntimeAuth()` allows only the platform runtime token and returns 403 for a worker token.
- `PUT /api/runtime/v1/businesses/:id/versions/:version` is handled at `runtime.ts:339-345`. It authenticates as platform-only and passes `ctx.body` directly to `ctx.registry.registerVersion()`. The captured path values are unused, so a path/body identity mismatch is currently accepted if the body itself is a valid manifest.
- `orchestrator/services/orchestrator/src/modules/runtime/worker-identity.ts:4-9,23-50` shows the available identity model: one platform token and a map of business IDs to worker tokens. It does not distinguish publisher from executor role or encode a version in the token mapping. `packages/worker-sdk/src/types.ts:288-307` says `WorkerConfig.runtimeToken` is a worker identity while `worker.ts:172-176` uses it for runtime calls.
- `orchestrator/services/orchestrator/src/http/route-context.ts:41-105` provides the DB and business registry but no worker-instance service. `create-app.ts:323-324,817-855` constructs the registry and passes dependencies into each route context; this is the composition seam for a new worker-instance service.

### Manifest validation, replay, and conflict

- `orchestrator/packages/contracts/src/manifest-validator.ts:10-34,46-57,111-117` canonicalizes JSON by sorted object keys, validates the manifest, computes a `sha256:` digest, and derives the canonical queue name.
- `orchestrator/services/orchestrator/src/modules/registry/registry.ts:12-16,42-99` validates again on the server, serializes registration in a transaction, and locks an existing `(business_id, version)` row. Same coordinates plus same digest returns `{created:false,replayed:true}`; a different digest returns 409 `MANIFEST_DIGEST_MISMATCH`; a new row is inserted as `REGISTERED_DISABLED` and receives the platform queue name. This behavior should remain intact.
- The registration route maps a new record to HTTP 201 and an identical replay to HTTP 200 at `runtime.ts:343-345`. Registry enablement and activation remain separate operations (`registry.ts:102-180`); registration must never enable or activate a version.
- `orchestrator/services/orchestrator/migrations/0001_platform_v1.sql:23-34` defines immutable `business_versions` keyed by `(business_id, version)`. There is no worker-instance table in the inspected migration set; the latest migration present is `0038_secret_catalog.sql`.

### Instance heartbeat and existing tests

- `PUT /api/runtime/v1/workers/:instanceId/heartbeat` at `orchestrator/services/orchestrator/src/http/routes/runtime.ts:348-368` is labeled a compatibility stub. It authenticates a runtime bearer, checks a worker token's declared business at `:359-366`, then returns `DEGRADED`, `now + 60s`, and capacity 1. It does not parse `WorkerHeartbeatSchema`, use the path instance ID, check the registered version/digest, or write a lease.
- `orchestrator/packages/contracts/src/runtime.ts:15-28` already publishes the heartbeat body (`businessId`, `businessVersion`, `imageDigest`, `capacity`) and acknowledgement (`health`, `leaseExpiresAt`, `capacity`). `LEASE_DEFAULTS` at `:539-542` sets a 15-second heartbeat interval and 60-second lease.
- `orchestrator/packages/worker-sdk/src/runtime-client.ts:97-103,118-160,165-169` uses a 10-second request timeout. Writes that fail in transport or with 5xx are treated as ambiguous; there is no retry loop. `heartbeatWorker()` parses the current acknowledgement schema.
- Existing tests explicitly freeze today’s behavior: `orchestrator/services/orchestrator/tests/rfx11-12-route-hardening.test.ts:204-217` requires a `DEGRADED` no-DB heartbeat stub; `tests/br12-isolation-offline.test.ts:381-399` requires worker credentials to be forbidden from version registration; and `:504-520` checks heartbeat business scoping plus the stub acknowledgement. These assertions need intentional contract updates when implementation begins, not deletion of the security and no-false-health coverage.
- `tests/pm-m02-ingress-verification.test.ts` checks listener isolation for runtime paths, and `tests/helpers/runtime-harness.ts:295-304` uses the platform runtime token for manifest registration. Preserve those ingress and trusted-platform paths while adding the worker-scoped startup path.

## Proposed V1 contracts

### 1. Manifest registration

Keep `PUT /api/runtime/v1/businesses/{businessId}/versions/{version}` with a `BusinessManifest` body. Require the path coordinates to equal `body.businessId` and `body.version`; mismatch returns 400 `PATH_MANIFEST_MISMATCH` before registry mutation. The server continues to validate, canonicalize, hash, and derive the queue; the client must not choose the queue.

Authorize either the existing platform runtime principal or a business worker principal whose authenticated business exactly equals both path and body business ID. This permits startup to use the already provisioned business-scoped `runtimeToken` without placing the platform runtime token in a worker. It deliberately gives that scoped identity permission to register immutable versions for its own business; it cannot register another business, enable a version, or activate it. If operators require separate publisher and executor roles, that is an explicit credential-model decision to resolve before implementation, because the current token map has no role distinction.

Preserve response semantics:

- 201 for a newly inserted version; 200 for an identical replay.
- A typed acknowledgement contains `businessId`, `version`, `digest`, `queue`, `created`, and `replayed`.
- Same business/version/digest is a safe idempotent replay. Same business/version with a different digest is 409 `MANIFEST_DIGEST_MISMATCH` and is fatal to startup. Invalid manifest stays 422 `INVALID_SCHEMA`; invalid or cross-business auth stays 401/403.
- A new version remains `REGISTERED_DISABLED`; registration never changes enabled/active state. The SDK checks the returned coordinates and digest against its locally validated manifest and consumes only the returned server queue.

The same immutable PUT can be retried after network errors, timeouts, or 5xx because the registry key and digest make replay safe. Use bounded exponential backoff with `Retry-After` when present. Do not retry 4xx, especially digest conflict, auth failure, or schema failure.

### 2. Instance heartbeat and persisted lease

Keep `PUT /api/runtime/v1/workers/{instanceId}/heartbeat`. Parse the existing `WorkerHeartbeatSchema`; require a nonempty path ID, worker identity/business match, and an already registered `(businessId, businessVersion)`. The server reads the version's immutable manifest digest and stores it with the instance row. A disabled business version is valid for worker registration: business enablement is separate from process health.

Add `orchestrator/services/orchestrator/migrations/0039_worker_instances.sql` with a `worker_instances` table keyed by `worker_instance_id`, and columns for `business_id`, `business_version`, server-resolved `manifest_digest`, reported `image_digest`, nonnegative `capacity`, `first_seen_at`, `last_heartbeat_at`, and `lease_expires_at`. Add a foreign key from `(business_id, business_version)` to `business_versions`, plus indexes for business/version and lease expiry. Repeated heartbeat for the same instance and immutable identity updates capacity and heartbeat timestamps. Reuse of one instance ID for a different business, version, manifest digest, or image digest returns 409 `WORKER_INSTANCE_ID_CONFLICT`; do not silently rebind an instance.

With the existing defaults, set `lease_expires_at = last_heartbeat_at + 60s`. The acknowledgement returns the persisted expiry and submitted capacity. Define read health from server time and the stored lease: `HEALTHY` through 30 seconds after last heartbeat, `DEGRADED` after 30 seconds while the lease remains unexpired, and `OFFLINE` once `lease_expires_at` is reached. A successful new heartbeat returns `HEALTHY`. These labels mean heartbeat freshness only; they do not claim task count, Redis consumption, or business enablement. No worker rows are deleted when a lease expires; the version registry is not affected.

The periodic SDK loop must be single-flight. Transient failures may retry the same idempotent instance update with backoff, but an unacknowledged attempt never advances the locally observed expiry or claims a fresh healthy acknowledgement. Worker heartbeat failure alone does not mutate task leases or report task health. Startup auth, identity, unknown-version, or instance-ID conflicts fail closed. A normal process stop halts heartbeats; the server marks the row offline at lease expiry. V1 has no drain, resume, revoke, deregister, or other worker write-control endpoint.

### 3. Startup sequence and outage behavior

Implement this exact order in `startWorker()`:

1. Use the locally validated definition; compute its canonical manifest digest.
2. Register the exact manifest with the business-scoped runtime identity. Retry only transient errors as above. Reject a digest mismatch or nonretryable 4xx.
3. Validate the registration acknowledgement identity, digest, and server queue.
4. Send and await the first instance heartbeat. Do not start a queue consumer or periodic heartbeat timer before this acknowledgement succeeds.
5. Start the consumer using the server-returned queue. Only after the consumer start succeeds, install the single-flight heartbeat timer.
6. On any failure after allocating a timer or consumer, clear/stop those resources before rejecting `startWorker()`. On transient registration or first-heartbeat outages, apply bounded retry; if retries are exhausted, reject startup and let the process supervisor restart. Never continue startup by logging and treating the worker as healthy.

The API's `HEALTHY` definition remains narrowly “recent authenticated heartbeat persisted for a registered version.” It must not be presented as proof of queue consumption. UI may display the lease age and capacity; task count stays absent until a real telemetry source exists.

### 4. Read-only registry and controls

For the Workers view designed in `ubw-01-ui-design.md:41-64`, add platform-admin read endpoints only after persistence exists:

- `GET /api/v1/admin/workers?businessId=&businessVersion=&health=&limit=&cursor=` returns `{items, nextCursor}`. Each item contains `instanceId`, `businessId`, `businessVersion`, `manifestDigest`, `imageDigest`, computed `health`, `capacity`, `firstSeenAt`, `lastHeartbeatAt`, and `leaseExpiresAt`.
- `GET /api/v1/admin/workers/{instanceId}` returns that instance summary. It does not invent heartbeat history or task counts.
- Enforce platform admin authorization before returning any instance data. Do not expose worker tokens.
- V1 exposes no control mutations. Drain/resume/revoke remain deferred until desired state, command identity, worker acknowledgement, timeout, and observed-state reconciliation are separately specified. This follows `ubw-01-ui-design.md:41-64` and plan `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md:41,44`.

## Proposed file leases

Split implementation into non-overlapping packets; freeze shared DTOs first so SDK and service owners do not race on `packages/contracts/src/runtime.ts`.

**UBW-02A — wire contracts, persistence, runtime/admin read APIs and auth**

- `orchestrator/packages/contracts/src/runtime.ts` — heartbeat and registration acknowledgement schemas; add worker-list DTOs. Sole shared-contract owner for this packet.
- New `orchestrator/services/orchestrator/migrations/0039_worker_instances.sql`.
- New `orchestrator/services/orchestrator/src/modules/registry/worker-instances.ts`.
- `orchestrator/services/orchestrator/src/modules/runtime/worker-identity.ts` and `src/server.ts` — scoped registration authorization/config type.
- `orchestrator/services/orchestrator/src/http/route-context.ts`, `src/app/bootstrap/create-app.ts`, `src/http/routes/runtime.ts`, and `src/http/routes/admin.ts` — dependency wiring and endpoints.
- New `orchestrator/services/orchestrator/tests/runtime-worker-registry.test.ts`; update `tests/br12-isolation-offline.test.ts`, `tests/rfx11-12-route-hardening.test.ts`, and `tests/runtime-admin-auth.test.ts` for the new contracts while retaining cross-business denial, ingress boundaries, and honest health assertions.

**UBW-02B — worker SDK startup and heartbeat client**

- `orchestrator/packages/worker-sdk/src/worker.ts`, `src/runtime-client.ts`, and `src/types.ts`.
- `orchestrator/packages/worker-sdk/tests/worker.test.ts`; add `tests/runtime-client-registration.test.ts` for registration response parsing and idempotent retry behavior.
- Do not include a business entrypoint file until a source-only inventory finds its actual path. The present search found no production `startWorker()` callsite outside the SDK itself.

**UBW-03 dependency — Admin BFF and UI read surface**

- Backend BFF: `orchestrator/services/orchestrator/src/app/admin/bff/operations.ts` and, if route dispatch needs registration, `src/app/admin/bff/handle.ts`.
- Admin web: `orchestrator/apps/admin-web/src/lib/api/types.ts`, `src/lib/api/client.ts`, `src/app-shell/app-shell.tsx`, new `src/routes/workers.tsx`, and new `src/features/workers/workers-screen.tsx` plus its state module.
- UI remains read-only and platform-scoped. Do not lease business/workflow/profile files for worker controls.

## Verification criteria for implementation packets

- SDK call-order test proves manifest registration → initial persisted heartbeat → consumer start; asserts no consume on registration conflict, bad auth, malformed acknowledgement, or initial heartbeat failure, and asserts startup resources are cleaned up.
- Registration tests cover 201 create, 200 exact replay, 409 different digest, 400 path/body mismatch, worker-own-business success, cross-business denial, and unchanged `REGISTERED_DISABLED` status.
- Instance tests cover persisted insert/update, identity conflict, unregistered version denial, capacity echo, and health transitions at 30/60 seconds using a controlled clock; no fake healthy response or task count.
- Admin tests cover platform auth, filters/cursor, stale/offline derivation, and absence of worker credentials. Preserve public/internal listener isolation.
- No control UI is enabled until a separately acknowledged control protocol is approved and implemented.

## Open items

1. Confirm whether the existing business-scoped worker identity is authorized to publish immutable versions for its own business, as proposed, or whether publisher and executor credentials must be separate. The current runtime route and token model do not encode a publisher role.
2. Inventory the actual production business startup callsite(s) before granting an entrypoint lease; none were found in the current source search.
3. Define an offline-row retention policy before adding cleanup. The V1 contract above retains expired instance rows and reports them as `OFFLINE`; it does not delete them or the associated business version.

No gates were ticked. No database window or functional verification is claimed.
