# DU Orchestrator worker protocol reference

This reference records the source-level v1 contract. Recheck the active source before implementation and deployment; docs and the example can lag the deployed Orchestrator.

## Pin the source contract

In the DUGate repository, inspect these repository-relative files:

- `orchestrator/packages/contracts/src/version.ts`
- `orchestrator/packages/contracts/src/manifest.ts` and `manifest-validator.ts`
- `orchestrator/packages/contracts/src/hashing.ts`
- `orchestrator/packages/contracts/src/queue.ts`
- `orchestrator/packages/contracts/src/runtime.ts`
- `orchestrator/packages/contracts/src/connector.ts` when using Connector
- `orchestrator/packages/contracts/src/encryption.ts` when handling encrypted artifacts
- `orchestrator/services/orchestrator/src/http/routes/runtime.ts`
- `orchestrator/services/orchestrator/src/modules/runtime/worker-instances.ts`
- `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts`
- `orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` and `vault-transit-provider.ts` when handling encrypted artifacts
- `orchestrator/services/connector/src/http/server.ts` when using Connector

`docs/07-internal-api.md` is an overview, not the final authority for route availability. For example, its task-context entry says that `GET /tasks/{id}/context` is not implemented in the router. Claim returns `executionSnapshot` and `checkpointRefs`; do not invent a context route.

For a reproducible contract pin, record the Orchestrator revision, whether the checkout is dirty, and SHA-256 hashes of the files used to implement the worker. Include the current schema version (`contractVersion: "1"`, `wireVersion: "1"`) and the supported feature set in the worker project. If the source tree is dirty, preserve the relevant source patch or file hashes; a Git revision by itself does not identify those edits. Generate a fresh UUID worker instance ID at each process start, then reuse it only for that process’s heartbeats, claims, and retirement.

## Addressing and identity

The Runtime base path is `/api/runtime/v1` on the internal listener: `http://orchestrator:3002/api/runtime/v1` in Compose or `http://127.0.0.1:3002/api/runtime/v1` for local development. The worker uses a provisioned Runtime service bearer mapped to its business. That credential is intentionally shared across replicas and versions; the runtime binds execution to the exact registered business/version and manifest digest through the worker inventory and claim. The worker process identity is a separate, unique, stable UUID `workerInstanceId`. A public API key is not Runtime authentication.

## Registration and queue

Register the complete manifest with `PUT /businesses/{businessId}/versions/{version}`. Its body follows `BusinessManifestSchema`: `contractVersion: "1"`, lowercase-slug `businessId`, exact semver `version`, `displayName`, optional `description`, `imageDigest`, `runtime: { wireVersion: "1", handlerKinds: [...] }`, top-level `capabilities: { cancel, resume, parallel }`, and `actions`. Each action declares `name`, `displayName`, `inputSchema`, `outputSchema`, `profileSchema`, `artifactPolicy`, action `capabilities: { cancel, resume }`, and `defaultLimits`; `description`, `uiSchema`, `connectorSlots`, and the limits’ `maxParallelTasks`/`timeoutSeconds` are schema-defined optional/defaulted fields. Read the active schema for exact nested fields; do not loosen it with guessed properties.

The registry digest is `sha256:` plus SHA-256 over canonical JSON: sort object keys recursively, omit undefined object values, preserve array order, then JSON stringify. Include the returned digest in worker heartbeats. Registration returns 201 for a new disabled version, 200 for an identical replay, and rejects a digest conflict. The path business/version must match the manifest.

The platform queue is `du-business-{businessId}-{exactVersion}`. Its strict v1 delivery object contains only these fields (with optional `priority`):

```json
{
  "contractVersion": "1",
  "deliveryId": "stable-outbox-delivery-id",
  "taskId": "00000000-0000-4000-8000-000000000001",
  "operationId": "00000000-0000-4000-8000-000000000002",
  "businessId": "example-business",
  "businessVersion": "1.0.0",
  "action": "convert",
  "kind": "convert",
  "correlationId": "request-correlation-id"
}
```

Do not expect inline input, file bytes, provider secrets, signed URLs, or full checkpoint state in the queue message. Preserve the provided `deliveryId` for claim retries. Queue retry is transport recovery; business retry is requested through the Runtime fail report. On claim refusal, only `NOT_FOUND`, `TASK_TERMINAL`, `TASK_WAITING`, and `TASK_LEASE_ACTIVE` are source-classified `ACK_SAFE`. After a successful claim, keep the delivery recoverable until Runtime accepts completion, failure, or a durable yield. If shutdown, a mismatched snapshot, or a missing handler prevents execution after claim, defer until the lease can be reclaimed.

## Worker heartbeat and admission

`PUT /workers/{workerInstanceId}/heartbeat` uses this body shape:

```json
{
  "businessId": "example-business",
  "businessVersion": "1.0.0",
  "manifestDigest": "sha256:<64 lowercase hex characters>",
  "imageDigest": "sha256:<image digest>",
  "deploymentRevision": "release-label",
  "capacity": 4,
  "activeTasks": 0,
  "observedBackupFenceRevision": 0
}
```

`businessId`, `businessVersion`, `imageDigest`, and nonnegative integer `capacity` are required. `manifestDigest`, `deploymentRevision`, `activeTasks`, and `observedBackupFenceRevision` are optional in the compatibility schema; send the digest and active task count, and use the backup-fence revision when available. The response contains `health`, `leaseExpiresAt`, `capacity`, `controlRevision`, `controlState` (`OPEN`, `PAUSED`, or `DRAINING`), and the current `backupEffectFence` when supported: `{ state: "OPEN" | "HELD" | "UNKNOWN", revision, acknowledged }`.

Keep one worker-heartbeat request in flight at a time and reconcile responses by revision. Pause queue consumption unless the newest acknowledged control is `OPEN` and the backup fence is both `OPEN` and `acknowledged`. Missing backup-fence data means `UNKNOWN`, not `OPEN`; fail closed. Echo the observed fence revision on the next heartbeat so the server can acknowledge that exact revision. Continue heartbeats while paused, draining, and while task handlers finish. If the fence changes during execution, do not initiate new external effects until the current revision is acknowledged open.

## Claim and task lease

For each queue delivery, call `POST /tasks/{taskId}/claim` with exactly:

```json
{
  "deliveryId": "stable-outbox-delivery-id",
  "workerInstanceId": "unique-process-uuid",
  "businessId": "example-business"
}
```

The response `ClaimResult` has `taskId`, `operationId`, `leaseEpoch`, `leaseExpiresAt`, `attempt`, `deadlineAt`, `executionSnapshot`, and `checkpointRefs`. Verify `executionSnapshot.businessId`, `businessVersion`, and `manifestDigest` against the registered worker before handler dispatch. Use the admission-pinned snapshot and references; do not re-resolve mutable profiles or schemas for a resumed operation.

Claim errors have a source-defined disposition. Only `NOT_FOUND`, `TASK_TERMINAL`, `TASK_WAITING`, and `TASK_LEASE_ACTIVE` are safe to settle as obsolete/already-owned deliveries. Defer other known dispositions, including paused admission, registration/version/digest mismatch, business disabled, active lease held, and temporary unavailability. Unknown error codes also defer; never ACK them as success by guessing from HTTP status alone.

The task lease heartbeat is `POST /tasks/{taskId}/heartbeat` with `{ "leaseEpoch": N }`. Its response is `{ "leaseExpiresAt": "...", "cancelRequested": false }`. Current defaults are a 60-second lease and 15-second heartbeat interval; treat these as source defaults, not deployment guarantees. A failed heartbeat does not extend the last confirmed deadline. Maintain a watchdog from that deadline.

Every task mutation below carries the claimed `leaseEpoch`:

| Method and path | Exact body fields | Meaning |
|---|---|---|
| `PUT /tasks/{id}/steps/{stepKey}` | `leaseEpoch`, `inputHash`, `outputRef`; optional `sessionRef`, `status` (`SUCCEEDED` or `FAILED`) | Durable step checkpoint; identical replay is idempotent. |
| `POST /tasks/{id}/progress` | `leaseEpoch`, `percent` (0–100); optional `message` (max 512 chars) | Best-effort progress. |
| `POST /tasks/{id}/complete` | `leaseEpoch`, `resultRef`, `resultHash`; optional `outputArtifactIds` | Complete task. `resultHash` must equal the source `contentHash(resultRef)`. |
| `POST /tasks/{id}/fail` | `leaseEpoch`, `errorCode`, `retryable`; optional `retryAfterMs`, `detail` | Runtime-owned retry schedule or terminal failure. |

On `cancelRequested`, stop handler work promptly and never publish a late success. On HTTP 409 `LEASE_LOST`, a terminal-task response, or a passed lease deadline, abort the handler and send no more checkpoints, completions, failures, or external effects for that lease. A task report with an ambiguous response must be retried idempotently with the same task, epoch, and payload; do not rerun an external effect just because its acknowledgement was lost. A new lease epoch fences all old work.

The canonical hash helpers are part of the wire contract. `canonicalize(value)` recursively sorts object keys, omits undefined object values, preserves array order, and JSON-stringifies the result. `contentHash(value)` is `sha256:` plus lowercase SHA-256 hex of that canonical JSON; `complete.resultHash` is `contentHash(resultRef)`, and fan-out `payloadHash` is `contentHash(payloadRef)`. For Connector grants, use the exact active `hashInvocationInput` projection: `contractVersion`, `tenantId`, `operationId`, `taskId`, `stepKey`, `bindingSlot`, `input`, `options` (default `{}`), `sessionRef` (default `null`), and `deadlineAt`, with `workflowOverrides` included only when present. Its output uses the same `sha256:` plus hex form. The optional `purpose` field is a separate signed domain used only when a caller supplies it for the admin provider-test path; ordinary business workers omit it. Do not hash a hand-picked subset or a differently normalized request.

## Optional feature matrix

Declare manifest capabilities only when the worker can honor the full behavior. Route availability in source does not prove deployment configuration or encryption support.

| Feature | Source contract | Enable only when |
|---|---|---|
| Cooperative cancel | Action and manifest `capabilities.cancel`; task heartbeat returns `cancelRequested` | Every handler propagates cancellation to parsing/provider/network work and fences its writes. |
| Resume/checkpoint | `capabilities.resume`; `PUT /tasks/{id}/steps/{stepKey}`; claim `checkpointRefs` | Step keys and input hashes are stable, outputs are durable references, and replay avoids duplicate effects. |
| Parallel work | `capabilities.parallel`; action `defaultLimits.maxParallelTasks`; manifest `runtime.handlerKinds` | Handler concurrency and resource limits are enforced in the worker. |
| Artifacts | `artifactPolicy`; `POST /tasks/{id}/artifacts`; `POST /artifacts/{id}/access`; `POST /artifacts/{id}/finalize`; short-lived grant URLs | The worker streams and verifies bytes, never logs grants, and the active runtime’s required artifact encryption/storage is configured. |
| Multipart artifacts | Runtime routes `/tasks/{id}/artifacts/multipart` and `/artifacts/{id}/multipart/{part-grant,part,complete,abort}` | Confirm these handlers are present in the target source and deployment. Reuse the same `uploadToken` after an ambiguous init; finalize only after server-verified completion. |
| Connector calls | `POST /tasks/{id}/invocation-grants`; Connector `POST /invocations`; `InvocationRequestSchema` | Implement the active request hash and invocation replay contract, use the Connector’s separate service identity, and verify grant signing plus invocation-storage encryption are provisioned. Provider credentials stay in Connector. |
| Child fan-out | `POST /tasks/{id}/children`; v1 `joinPolicy: "all-success"` | Child `taskKey` values and payload hashes are deterministic; every child kind is registered. Let Runtime create child deliveries; do not enqueue children directly. |
| Human wait | `POST /tasks/{id}/wait-input` | Persist only supported references and verify the current root/join restrictions. |

If an access grant carries `encryption`, preserve the exact `StorageEnvelopeRefSchema` from `contracts/src/encryption.ts`: `{ version: 1, algorithm: "aes-256-gcm", nonce, tag, aad, plaintextSizeBytes, plaintextSha256, dek: { keyRef, keyVersion, ciphertext } }`. This is a strict storage reference; it is not the separate `{ keyId, keyVersion, wrappedKey, nonce, tag }` `WrappedDekEnvelopeSchema`. The grant’s `sizeBytes` describes stored bytes, while the envelope carries plaintext size and digest. Follow the active grant and storage-facade code for whether the URL serves ciphertext or opened bytes. Never guess envelope fields, fetch a latest Transit key version, or fall back to plaintext when the source requires encryption. An independent worker that does not implement the active encrypted-artifact format must leave that path unsupported.

The Runtime invocation grant request fields are `leaseEpoch`, `stepKey`, `bindingSlot`, `inputHash`, optional unique `artifactIds` (max four), and optional source-defined `workflowOverrides`. The Connector invocation body is strict and includes `contractVersion`, Runtime-issued `invocationId`, signed `grant`, `operationId`, `taskId`, `stepKey`, `bindingSlot`, `input`, optional `options`/`workflowOverrides`/`sessionRef`, and `deadlineAt`. Derive hashes from the active `hashInvocationInput` contract; do not invent or omit signed fields. Connector grant, key, identity, and encryption configuration are deployment inputs, not values to fabricate in worker code.

## Graceful retirement

On shutdown, stop new claims first, drain in-flight handlers for a bounded grace period, abort remaining handlers at the deadline, and close the queue consumer. Only after the consumer is confirmed closed, call `POST /workers/{workerInstanceId}/retire` with exactly `{ "businessId": "...", "businessVersion": "...", "manifestDigest": "sha256:..." }`. Retirement is idempotent for stale/missing identities; the server retains an offline row if that instance still owns running tasks. Never retire a different process generation by reusing its instance ID.

