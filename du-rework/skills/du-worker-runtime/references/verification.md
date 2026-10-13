# Independent worker verification checklist

Use this checklist only for features the worker advertises. Keep the result tied to the exact source, image, and deployment tested.

## Source and contract

- Pin the Orchestrator source revision, dirty-tree state, and hashes of the contract and route files used by the worker.
- Confirm the manifest validates, the registry digest matches, and the queue name uses the exact business version.
- Confirm the queue decoder rejects unknown fields and that the worker never expects business input or secrets in a delivery.
- Exercise worker heartbeat admission for `OPEN`, `PAUSED`, `DRAINING`, and an absent/unknown or unacknowledged backup fence. Only the acknowledged open state may start new work.
- Exercise missing/unknown version-admission fields, exact-version eligibility, lower-revision late ACKs, same-revision tuple conflicts, and a v1→v2→v1 cutover. A cutover must defer new v1 claims while already-claimed v1 work can still heartbeat, checkpoint, request a Connector grant, invoke Connector, and complete under its valid lease.
- Exercise claim identity checks for wrong business, version, and manifest digest. Unknown claim refusal codes must remain deferred.
- Exercise `VERSION_NOT_ACTIVE`, `NO_ACTIVE_VERSION`, `VERSION_NOT_ENABLED`, `BUSINESS_SUBMISSIONS_PAUSED`, and `WORKER_CAPACITY_EXHAUSTED` as deferred claim outcomes with no attempt consumption or hot loop. Confirm `TASK_ATTEMPTS_EXHAUSTED` is ACK-safe only for HTTP 410 after durable task and operation terminalization; a nonterminal response remains deferred.
- Simulate a claim committed by Runtime with its HTTP response lost, then close version admission before returning the transport error. Verify one exact `(taskId, deliveryId, workerInstanceId)` replay retrieves the existing lease and completes the task, while a different delivery remains unclaimed.
- Exercise a task heartbeat cancellation, stale `leaseEpoch`, lease timeout, idempotent checkpoint/report replay, and worker restart with the same durable task.
- Exercise shutdown with both a drained consumer and a still-running task; retirement must preserve the server’s running-task recovery path.

## Optional features

- For artifacts, verify grant expiry handling, raw-byte upload, finalized size/hash, and read integrity. Check that logs omit grant URLs and bearer credentials.
- For Connector, verify signed grant binding, stable invocation ID/hash across transport retries, cancellation, timeout, and the deployment’s configured storage encryption. Confirm provider secrets never enter the worker.
- For fan-out and human waits, verify idempotent creation/resume, registered handler kinds, and the v1 all-success join behavior.
- Do not advertise a feature whose source route, auth scope, encryption setup, or deployed dependency has not been verified.

## Evidence levels

1. **Source evidence:** schema/route compatibility and worker tests. This shows what the source and worker code can do.
2. **Built evidence:** worker image name, version, build result, and immutable digest. This shows what was packaged.
3. **Live evidence:** running Orchestrator and worker image digests, registration/heartbeat state, and a real isolated API submission through claim to completion, result retrieval, and any advertised optional path. This shows what the deployment did.

Report these levels separately. A source route, unit-test receipt, or configuration preflight alone does not establish built-image or live-runtime support.

