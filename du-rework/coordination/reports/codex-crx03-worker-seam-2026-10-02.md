# CRX-03 Slice 1 — blocked on missing config seam

## Verdict

**BLOCKED BEFORE SOURCE EDITS.** The task requires wiring encryption policy and a `WorkerCryptoSeam` from document-core configuration, but the current `businesses/document-core/src/config.ts` defines neither field nor a seam provider. That file is outside this dispatch's lease; no source or test file was changed.

## Source findings

- `packages/worker-sdk/src/types.ts:292-298` already defines optional `crypto` and `encryptionEnabled` worker config fields; omitting the flag preserves the documented disabled/compatibility default.
- `packages/worker-sdk/src/worker.ts:349-351` already forwards those config properties into `DefaultTaskContext`.
- `packages/worker-sdk/src/task-context.ts:606-623` rejects encrypted multipart writes because their manifest path is not wired. `:705-711` rejects single-shot writes when encryption is enabled without a seam, before upload; the subsequent branch seals when a seam exists.
- Existing offline coverage already includes missing-seam/enabled rejection and no upload (`packages/worker-sdk/tests/rv01-03-fail-closed.test.ts:209-245`), flag-off compatibility (`:247-258`), and ciphertext stored when the seam is supplied (`:311-329`). These existing tests were not run for this blocked dispatch.
- Contrary to the task premise, `businesses/document-core/src/config.ts:4-37` has no encryption or crypto settings in `WorkerEnvSchema`; `:41-52` omits both from `DocumentCoreServiceConfig`; and `:65-77` does not return either. `rg` also found no seam construction or configuration in `businesses/document-core/src` beyond `worker.ts`'s consumer-side seam accessors.
- `businesses/document-core/src/main.ts:40-51` passes only runtime, Redis, connector, concurrency, heartbeat, instance, and image fields to `startWorkerFn`; there are no parsed `config.crypto` or `config.encryptionEnabled` values to forward. Adding those parser fields/policy requires editing the unleased `businesses/document-core/src/config.ts`; obtaining an actual seam for the default process also requires a configured provider source.

## Not performed

- No files outside the lease were edited; no source or test files were edited at all.
- No tests or typechecks were run because the required configuration source is absent and the permitted file lease prevents completing the requested plumbing safely.
- No live worker, Orchestrator, S3, ciphertext scan, or multipart round-trip was run. These remain residual acceptance items, along with the packet's unresolved gateway-vs-separate-credential decision and chunked/multipart manifest support.
- No gate was ticked and no commit was created.

## Needed to resume

Extend the file lease to include `businesses/document-core/src/config.ts` and identify the trusted construction/injection source for `WorkerCryptoSeam`. Then the parser can represent the encryption-required policy, the process can forward both fields, and the worker consumer can reject enabled-without-seam at startup while retaining the task-context write guard.
