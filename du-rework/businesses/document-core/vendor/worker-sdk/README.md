# Worker SDK

`@du/worker-sdk` provides the runtime-facing building blocks used by DUGate business workers.
It implements worker registration and heartbeats, BullMQ-backed task consumption, lease-aware
runtime reporting, checkpoint and child-task helpers, artifact access, and connector invocation.

## Purpose

Business registration/lifecycle, claim/lease, checkpoints, child tasks, human waits, artifacts,
and invocation grants.

## Boundary

The SDK depends only on shared contracts, observability, BullMQ, and runtime/connector HTTP APIs.
It does not import platform implementation code or access the platform database directly.

## Structure

Core lifecycle:

- `src/runtime-client.ts` — authenticated runtime API client and error classification.
- `src/connector-invoker.ts` — connector grant acquisition and invocation transport.
- `src/task-context.ts` — task facade for checkpoints, artifacts, children, and waits.
- `src/worker.ts` — queue consumer wiring, worker heartbeats, fencing, and graceful shutdown.
- `src/types.ts` — public SDK types and extension interfaces.
- `src/index.ts` — public exports.

Invocation and continuation semantics:

- `src/connector-session.ts` — `classifyInvocation()`, `runConnectorStep()`, pending-retry
  backoff (5s default, clamped 1s–120s), and the typed failure taxonomy
  (`PendingInvocationError`, `ReconcileRequiredError`, `ConnectorInvocationFailedError`,
  `InvocationCancelledError`).
- `src/fan-out.ts` — `spawnChild()`, `waitForChildren()`, `uploadArtifact()`,
  `streamResult()`.
- `src/source-acquisition.ts` / `src/source-ingestion.ts` — source acquisition and the
  ingestion receipt contract (`createSourceAcquisitionIngestor`, `createIngestionTaskHandler`).
- `src/artifact-multipart.ts` — multipart upload client. `MULTIPART_SDK_MAX_PART_BYTES` is
  **64 MiB**: the SDK refuses a larger part geometry, which is why the Orchestrator's
  per-part ceiling cannot be raised.
- `src/artifact-streams.ts` — artifact stream read/write helpers.
- `src/crypto-seam.ts` / `src/crypto-storage.ts` — `bindTaskCrypto()` and sealed-artifact
  storage seam (absent seam fails closed rather than silently skipping encryption).

See [workspace structure](../../../docs/03-project-structure.md) for the SDK's place in the monorepo.

## Build and test

```bash
pnpm --filter @du/worker-sdk build
pnpm --filter @du/worker-sdk lint
pnpm --filter @du/worker-sdk test
```

## Worker instance lifecycle

Each process boot gets a fresh `workerInstanceId` by default. If an application
sets `workerInstanceId` explicitly, it should still use a distinct value for
each concurrently running process. On graceful stop, the SDK stops admission,
waits for its heartbeat callback and consumer shutdown, then best-effort
retires that exact business/version/manifest identity. A row with a `RUNNING`
task owner stays `OFFLINE`; otherwise graceful retirement removes only the
worker inventory row. Crashed or ambiguous instances become eligible 24 hours
after their last heartbeat. An hourly cleanup checks at most 100 rows at a
time, so normal removal is around 24–25 hours and can take longer under backlog
or while a `RUNNING` task protects its owner.

Heartbeat HTTP deadlines can expire while the server-side transaction is still
finishing. Shutdown waits for the local request to settle before retirement,
but a late server completion can recreate an inventory row; the 24-hour cleanup
is the fallback for that ambiguous transport case.

Document Core's local dev runner consumes prebuilt workspace dependency
artifacts and does not watch SDK source. After changing the SDK lifecycle, stop
the current Document Core dev process, rebuild the SDK from `orchestrator/`,
then restart Document Core dev from `businesses/document-core/`:

```bash
cd orchestrator
pnpm --filter @du/worker-sdk build
cd ../businesses/document-core
pnpm run dev
```

## Read first

- [04-data-state](../../../docs/04-data-state.md)
- [07-internal-api](../../../docs/07-internal-api.md)
- [09-queue-sdk](../../../docs/09-queue-sdk.md)

