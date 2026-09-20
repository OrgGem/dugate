# Gate: sdk-ready — **READY**

- Date: 2026-09-20
- Owner: Claude (platform lane)
- Package: `@du/worker-sdk@0.1.0` (`du-rework/packages/worker-sdk`)
- Depends on: `@du/contracts@0.1.0` (gate `contracts-v1.md` READY), `@du/observability@0.1.0`, `bullmq ^5.34.0`

## Evidence (actual commands + results)

```
cd du-rework/packages/worker-sdk
npx tsc --noEmit -p tsconfig.json   → exit 0 (strict)
pnpm test                           → Test Suites: 1 passed, 1 total
                                      Tests: 23 passed, 23 total
```

All 23 tests run against an injected in-memory `QueueConsumer` and a stubbed `fetch` — no Redis,
no orchestrator process needed. This is real SDK execution (claim → handler → disposition →
report path), not stub-only integration.

## What is covered

- `defineBusiness`: manifest validation, handler-kind ⇄ manifest cross-check (REG-04: missing and undeclared kinds both rejected).
- Delivery lifecycle: claim (atomic CAS) is the authority — 409 busy / 410 terminal end the delivery safely without handler execution or terminal reports; transport failures rethrow for queue redelivery.
- Completion: `completeTask` carries `leaseEpoch`, `resultRef` (string artifact URI), `resultHash = contentHash(resultRef)`; replay acks tolerated.
- Failure path: business errors may carry `{code, retryable, retryAfterMs}`; unregistered handler kind → permanent `UNREGISTERED_HANDLER` fail with the **claimed** leaseEpoch (fencing preserved).
- Yield dispositions: `spawnAndWait` (children persisted with `payloadHash`, joinPolicy `'all-success'`, parent releases slot — no terminal report) and `waitForInput` (schema persisted before yield).
- Checkpoint replay (RUN-04): SUCCEEDED checkpoint + matching inputHash → stored output restored, handler fn **not** executed; mismatch → `InputHashMismatchError`; `step.peek` inspects without executing.
- Lease loss: `ctx.abort()` fires the signal; subsequent facade calls throw `LeaseLostError`; heartbeat 409 LEASE_LOST aborts the context; ambiguous reports end the delivery for idempotent redelivery (never blind-retry).
- `classifyFailure`: 429/5xx retryable (429 → 5s backoff), ConnectorTransportError mapping (0/429/503 retryable), detail truncated to 2048.
- Graceful shutdown: `stop(graceMs)` drains in-flight deliveries, idempotent second stop.

## Public API (import from `@du/worker-sdk`)

```ts
defineBusiness(manifest: unknown, handlers: Record<string, TaskHandler>, opts?: { validate?: boolean }): BusinessDefinition
startWorker(definition: BusinessDefinition, config: WorkerConfig & { consumer?: QueueConsumer; logger?: Logger }): Promise<WorkerHandle>
createBullMQConsumer(opts: BullMQConsumerOptions): QueueConsumer   // production path; lazy-requires bullmq
classifyFailure(err: unknown): FailureClassification
// Types: TaskContext (step/spawn/wait/progress/artifacts/connector facades), TaskHandler,
//        TaskDisposition, WorkerConfig, WorkerHandle, QueueConsumer
// Errors: RuntimeError, AmbiguousReportError, LeaseLostError, InputHashMismatchError, ConnectorTransportError
```

`WorkerConfig`: `runtimeUrl`, `runtimeToken` (bearer), `connectorUrl?`, `redis?: {url}`, `workerInstanceId?`,
`concurrency?`, `heartbeatIntervalMs?`, `imageDigest?`, `fetchImpl?` (tests/proxies), `component?`.

## TaskContext facade contract (for business lanes, e.g. document-core)

- `ctx.input` — child payload when `payloadRef` non-empty, else `resolvedInputRef` from the snapshot.
- `ctx.step.run<T>(stepKey, inputHash, fn)` — durable checkpoint; full output persisted as an artifact (`artifact://{id}?meta=...`), never truncated.
- `ctx.spawn.spawnAndWait(children, 'all-success', continuationRef)` — returns `{kind:'waiting-children'}`; handler MUST return it immediately.
- `ctx.wait.waitForInput(waitKey, inputSchema, opts?)` — returns `{kind:'waiting-input', waitId}`; resume arrives as a fresh delivery.
- `ctx.artifacts.read/write/accessGrant` — grants via runtime; worker holds **no** storage credentials.
- `ctx.connector.invoke(slot, input, options?)` — stable invocationId per (stepKey, slot, inputHash) via runtime grant; transport failure surfaces as `INVOCATION_UNKNOWN` (never blind-retried).
- `ctx.signal` / `ctx.cancelRequested` — aborted on lease loss, cancel, shutdown.

## Limitations

- BullMQ consumer path is compiled and wired but not yet exercised against a live Redis (planned in the runtime integration gate with `infra/` docker harness). Unit tests use the injected consumer.
- `joinPolicy` v1 supports `'all-success'` only (contract-level).
- The thin `createConnectorInvoker` transport ships inside the SDK so there is no cross-lane build dependency; businesses may replace it once `@du/connector-client` (Copilot lane) publishes against frozen contracts.
