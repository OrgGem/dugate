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

- `src/runtime-client.ts` — authenticated runtime API client and error classification.
- `src/connector-invoker.ts` — connector grant acquisition and invocation transport.
- `src/task-context.ts` — task facade for checkpoints, artifacts, children, and waits.
- `src/worker.ts` — queue consumer wiring, worker heartbeats, fencing, and graceful shutdown.
- `src/types.ts` — public SDK types and extension interfaces.
- `src/index.ts` — public exports.

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

