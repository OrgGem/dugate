# DU rework code review — 2026-09-23

Snapshot: 09:22 +07:00. **13 findings: 9 High, 4 Medium.** This is a targeted review of submission, runtime leases, webhook delivery, artifact transport, Connector/SDK transport and usage. It is not a certification of the remaining codebase.

Fix queue: [REVIEW-FIXES-2026-09-23](../tasks/REVIEW-FIXES-2026-09-23.md). The [earlier plan review](PLAN-REVIEW-2026-09-23.md) covers acceptance/documentation drift; the findings here concern executable behavior. No product-source edits or shared DB runs were made.

## Findings (line numbers refer to the reviewed snapshot)

### CR-13 — High: blob wire encoding corrupts production SDK reads; integration shim hides it

- Source: `services/orchestrator/src/server.ts:444` returns `bytes.toString('base64')`, then the common responder at line 192 calls `JSON.stringify`. The response advertises `application/octet-stream` but actually contains a quoted base64 string.
- Consumers: `packages/worker-sdk/src/task-context.ts:369` reads `arrayBuffer()` directly; `packages/worker-sdk/src/artifact-streams.ts:325` streams the response directly to disk.
- Impact: a downloaded PDF is not a PDF; a checkpoint containing `{ "output": ... }` becomes a JSON string, so checkpoint replay cannot recover its output object. Expected hashes also fail against the encoded bytes.
- Masking evidence: `businesses/document-core/tests/multi-container-e2e.integration.test.ts:281–305` replaces global fetch and decodes blob responses before handing them to the SDK. This adapter is absent from the production SDK path.
- Reproduction: offline wire fixture uses the same server encoding and real `downloadArtifact`; original `{"output":{"ok":true}}` becomes `"eyJvdXRwdXQiOnsib2siOnRydWV9fQ=="`, with parsed type `string`.
- Fix: define and implement one binary wire contract across server/SDK; remove the blob-decoding test shim once the real route works. Require real HTTP byte equality, hash verification, native parser use and checkpoint restart/replay through the shipped SDK. Existing end-to-end counts cannot close this fix.

### CR-01 — High: tenant-supplied webhook destination permits internal-network requests

- Source: `packages/contracts/src/operations.ts:199–201` accepts a generic URL; submission persists it in `operations.callback_url`. `modules/webhooks/webhooks.ts:156,182` sends it with global fetch, with no destination policy or explicit redirect restriction.
- Trigger: a valid caller submits an operation with callback `http://127.0.0.1:12345/private` or a public URL redirecting to an internal host. Terminal completion causes an Orchestrator-origin POST with operation metadata.
- Reproduction: the callback passes the exported schema and reaches injected fetch unchanged. This did **not** contact a private endpoint; the destination was intercepted offline.
- Fix: enforce allowed schemes/destination policy at submission and dispatch, handle resolved IPs/redirect hops safely, and allow private destinations only through explicit deployment configuration. Regression coverage must include loopback, IPv6, private/link-local destinations, redirects and permitted callbacks.

### CR-02 — High: webhook network I/O holds DB transactions without a bounded deadline

- Source: `modules/webhooks/webhooks.ts:163–182` holds `FOR UPDATE SKIP LOCKED` rows inside `db.tx` while awaiting each HTTP call; production fetch has no AbortSignal. `server.ts:234–236` starts another sweep every interval without tracking an in-flight sweep; `close()` clears the timer but does not await or abort an existing sweep.
- Impact: a slow recipient retains a DB connection and locks the whole selected batch, delaying unrelated callbacks. With enough pending batches, overlapping sweeps can occupy the pool; `db.close()` can wait for outstanding transactions beyond the application's drain timeout. A crash after sends but before the batch commits causes already-sent callbacks to replay.
- Evidence: source control flow plus offline dispatcher call records no signal/redirect policy. No live pool exhaustion was attempted.
- Fix: bound request and batch lifetime, release/cancel response bodies, track/await/cancel sweeps at shutdown, and avoid holding the DB transaction throughout external I/O (use a durable claim/lease if moving it outside). Keep documented at-least-once semantics and crash recovery.

### CR-03 — Medium: concurrent first submissions with one idempotency key can return HTTP 500

- Source: `modules/operations/submission.ts:138,185` uses SELECT FOR UPDATE on a key that may not exist, followed by an ordinary INSERT. The key has a composite primary key (`migrations/0001_platform_v1.sql:58–66`). No 23505 recovery exists in the service; `server.ts:204` maps an unhandled error to 500.
- Schedule: both transactions observe no key; both insert operations; one key INSERT commits, the other loses the unique-key race and rolls back. Atomic rollback prevents a second durable operation, but the loser gets 500 instead of replay/409.
- Evidence level: source/SQL schedule inspection; a real concurrent PostgreSQL reproduction is still required in the owner's DB window.
- Fix: serialize or atomically reserve the idempotency scope and resolve contention to the existing operation; different bodies must return deterministic 409. Test many simultaneous same-key requests, exactly one durable operation/root/outbox row, and no 500.

### CR-04 — Medium: expired idempotency keys are replayed or conflict forever

- Source: fast lookup at `submission.ts:253` filters `expires_at > now()`; transaction lookup at line 138 has no expiry condition and returns any stored row. There is no expiry replacement in this path.
- Trigger: reuse an expired key while its row remains. Same body replays the expired operation; changed body returns 409 instead of accepting a new operation under the TTL contract.
- Reproduction: real submission service with scripted DB rows reproduces `replayed: true` after the fast lookup excluded the expired row.
- Fix: implement one atomic expiry policy shared by both paths, including concurrent reuse at the boundary. Test same/different bodies before, at and after TTL, preserving old operations while replacing only the idempotency record as appropriate.

### CR-05 — High: replay depends on the current active version/profile/schema

- Source: `submission.ts:75–101` resolves the active version and profile and validates against its schema **before** looking up the existing key at line 105.
- Trigger: submit successfully, lose the response, then drain/deactivate the business or activate a version with an incompatible schema. Retrying the identical key/body returns 404/422 (or profile denial) instead of the originally accepted operation.
- Reproduction: scripted inactive registry makes the real submission service return 404 on its first query; no key lookup occurs.
- Fix: after caller authentication and canonical request parsing/hash, resolve valid replay independently of mutable routing. Preserve tenant/key ownership, revocation policy and hash-conflict checks. Verify replay during drain, version switch and profile revision change, while genuinely new requests still enforce current admission rules.

### CR-06 — High: runtime writes accept expired leases and heartbeat ignores cancellation

- Source: `modules/runtime/runtime.ts:138` renews on id+epoch only, with no active state/expiry predicate, and line 144 always returns `cancelRequested: false`. `saveStep` checks epoch only; `completeTask` rejects terminal task states but not expired leases. `claimTask:93` replays the same delivery before checking worker ownership/lease expiry.
- Trigger: a worker resumes after lease expiry but before the recovery sweep; it can renew or persist work using the expired epoch. After cancellation, the task epoch is unchanged and heartbeat can still succeed, delaying cancellation visibility and allowing checkpoint writes.
- Reproduction: real heartbeat service with an expired row renews the epoch and returns false for cancellation. SQL predicate inspection confirms expiry/state are not tested. Invocation grants already have stricter checks (`modules/grants/grants.ts:161–165`); that fix did not cover the runtime writes.
- Fix: define one active-lease invariant and apply it atomically to writes; distinguish legitimate terminal/replayed responses from renewed ownership. Include cancelled/expired leases, same-delivery wrong-worker claims, stale epoch and recovery races. Keep this linked to the fencing remainder of historical R08-02, not a reopening of its already-fixed stable invocation ID.

### CR-07 — High: a normally pending provider exhausts the task failure budget

- Source: `packages/worker-sdk/src/connector-session.ts:145–146` models pending as retryable failure; worker forwards it to `failTask`. Runtime increments attempt on claim and tests `attempt < max_attempts` at `runtime.ts:268`; DB default is three attempts.
- Trigger: an async provider returns PENDING across three deliveries. The third poll marks the task/operation FAILED with PROVIDER_PENDING despite no actual provider failure and no elapsed operation deadline.
- Reproduction: real `failTask` with attempt=3/max_attempts=3 returns operationState FAILED for PROVIDER_PENDING.
- Fix: represent pending continuation/yield without consuming the ordinary failure retry budget, or define a separate explicit bounded polling policy. Preserve stable invocation identity and grant renewal. Test more than three pending responses followed by success, cancellation/deadline while pending, and one provider execution.

### CR-08 — High: body streaming outlives timeout and lease-loss abort

- Source: `packages/worker-sdk/src/artifact-streams.ts:438–456` clears timer and outer abort forwarding when fetch resolves headers. Body pipeline at line 325 has no signal. `packages/connector-client/src/transport.ts:85–90` has the same boundary before `response.text()`.
- Trigger: headers arrive promptly, body stalls, then timeout elapses or the lease is lost. The stream continues waiting and can keep a worker slot/file/socket alive.
- Reproduction: real SDK downloader, controlled body stream, 10ms timeout: still unresolved after 40ms; aborting the caller signal still leaves the fetch signal un-aborted. The harness closes the stream explicitly for cleanup.
- Fix: maintain one cancellation/deadline scope through headers, body/error reads and file pipeline; dispose it only after consumption/cleanup. Add stalled-body, mid-body lease loss, partial-file cleanup and Connector response-body rejection tests. This does not require expanding the frozen business API silently.

### CR-09 — Medium: Connector readiness probe swallows body failure and buffers unnecessarily

- Source: `modules/connectors/connectors.ts:66–67` awaits an unbounded `arrayBuffer()`, suppresses every failure, then returns healthy if headers were 200.
- Trigger: upstream sends 200 headers then stalls past the timer or fails mid-body. The body read rejects, but `/connectors/:id/test` still returns `ok: true`; a large body is fully buffered despite being unused.
- Reproduction: injected body rejection produces `ok: true` from the real proxy.
- Fix: define status-only readiness (cancel body immediately) or bounded body validation; do not suppress a required body/timeout failure. Test 200-with-failed/stalled/oversized body and ensure upstream resources close.

### CR-10 — Medium: usage summary silently loses integer precision

- Source: `modules/usage/usage.ts:154–157` and totals reduce use unchecked JavaScript number addition. Ingest checks each amount is a safe integer; the older `project()` checks summed amounts, but `getUsageSummary()` does not.
- Reproduction: two valid amounts, MAX_SAFE_INTEGER and 2, produce `9007199254740992`; exact total is `9007199254740993`. A successful response contains an unsafe/inaccurate total.
- Fix: aggregate with exact arithmetic/SQL numeric, then enforce the existing numeric wire range (or coordinate a contract revision). Cover row totals, overall totals, cost/pages/tokens and safe-boundary values. Do not silently round or clamp billing data.

### CR-11 — High: request bodies are unbounded and stream errors escape the handler catch

- Source: `server.ts:163` calls `await readBody(req)` before `try`; `readBody:266–276` accumulates all chunks and concatenates them before route authentication or size checks.
- Impact: unauthenticated/chunked oversized requests can allocate unbounded memory; binary uploads additionally get decoded/JSON-parsed. An aborted/erroring request stream rejects outside the route error handler, creating an unhandled rejection in the async HTTP listener rather than a controlled response/cleanup.
- Evidence level: source control-flow inspection, no resource-exhaustion or process-crash experiment. Size-limit half is an unresolved part of historical R08-03, not a new independent implementation assignment.
- Fix: bounded ingress (declared and streamed bytes), early auth where applicable, streaming binary handling and catch/finally coverage for stream errors. Test chunked oversize, forged Content-Length, aborted streams, binary uploads, bounded memory and subsequent server responsiveness.

### CR-12 — High: artifact capability expiry/mode/integrity remain unenforced

- Source: `modules/artifacts/artifacts.ts:75,117` computes advertised grant expiry without storing a corresponding checked grant expiry. Blob route `server.ts:436` compares only a shared token for both GET/PUT. `putBlob:131` overwrites existing bytes; `finalize:95` trusts supplied size/hash and updates any non-DELETED artifact without lease/owner input.
- Trigger: a holder of a read grant uses PUT, or uses a still-current token after advertised expiry; READY bytes can be replaced. A runtime caller can finalize a known artifact ID with a supplied digest without verifying stored bytes or the producing lease.
- Evidence level: current source confirms historical **R08-03 / C07-01/02 still open**. Do not create a competing artifact implementation lane.
- Fix: expiring method-scoped grants tied to lifecycle/ownership, immutable finalized bytes, authoritative size/hash verification, and fenced finalize. Tests must exercise read-as-write, expiry, stale/cancelled lease, wrong-owner finalize, missing/mismatched blob and overwrite. Coordinate any required DTO/migration changes with the contract owner.

## Verification and limits

- Repro command: `node du-rework/coordination/review-evidence/code-review-2026-09-23.cjs` from the repository root — **exit 0; 9 observation groups covering 10 finding IDs** (CR-01/02 share one group).
- [Script](review-evidence/code-review-2026-09-23.cjs) imports real TypeScript services and uses scripted DB/fetch seams, plus an isolated SDK temp directory. It does not connect to PostgreSQL/Redis or send provider/private-network HTTP requests.
- [Captured output](review-evidence/code-review-2026-09-23.json) records exact observations and SHA-256 values of loaded source files. These are **current-defect characterization assertions**, not passing regression tests proving correctness. CR-03/11/12 remain source-reviewed, with live regression proof explicitly assigned to the fix owner.
- Cross-service source tracing also covered the blob-decoding test shim, request dispatch, SDK classification and SQL constraints. No full suite/build/security audit was run against the moving checkout.
- Existing agents continue working. Latest reviewed allocation leaves platform source with Claude, UI with OpenClaude, DB experiment/extension work with Agent-6, and SDK/connector-client fixes unassigned while Command Code is out of rotation. The coordinator must reconcile these tasks with subsequent writes before dispatch; no agent was interrupted or messaged by this review.
