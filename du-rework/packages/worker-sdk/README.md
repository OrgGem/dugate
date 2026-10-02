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

See [workspace structure](../../docs/03-project-structure.md) for the SDK's place in the monorepo.

## Build and test

```bash
pnpm --filter @du/worker-sdk build
pnpm --filter @du/worker-sdk lint
pnpm --filter @du/worker-sdk test
```

## Read first

- [04-data-state](../../docs/04-data-state.md)
- [07-internal-api](../../docs/07-internal-api.md)
- [09-queue-sdk](../../docs/09-queue-sdk.md)

