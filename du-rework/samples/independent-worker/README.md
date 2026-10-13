# Independent Runtime v1 worker

This is a small, SDK-free Node.js worker that registers one business version, consumes its BullMQ queue, claims each task from Runtime, and completes a pure inline echo action. It is a protocol example for learning how an independent worker can participate in the Runtime lifecycle. It does not use `@du/*`, repository workspace imports, parent helpers, or copied SDK code.

It is intentionally not a replacement for Document Core or the Runtime worker SDK. The sample supports only `independent-worker@<BUSINESS_VERSION>`, the `echo` action, a root task with `{ "text": "..." }` inline input, no connector bindings, no profiles or tenant defaults, no prompt overrides, no artifacts, and no workflow or child-task behavior. A valid claim that includes an unsupported feature is failed with `UNSUPPORTED_WORKER_PROTOCOL` and `retryable: false`; business/version/manifest identity mismatches are deferred until lease recovery. It does not make external provider or storage calls.

The sample returns canonical JSON text such as `{"text":"hello"}` as its own opaque `resultRef`. Runtime stores and hashes the string. This sample does not define a platform-wide result-reference format or promise that a public result projection will render this value.

## Requirements and setup

Use Node.js `>=24.21 <25` and npm. Copy this directory anywhere outside the DUGate checkout and run:

```sh
cp .env.example .env
# Set the Runtime URL, business-scoped worker token, Redis URL, exact version,
# and the image digest for the build you are running.
npm ci
npm run dev
```

`npm run dev` watches local TypeScript files with Node's native `--watch`. For a compiled process:

```sh
npm run build
npm start
```

The Runtime base URL includes the Runtime prefix, for example `http://127.0.0.1:3002/api/runtime/v1` for local development or `http://orchestrator:3002/api/runtime/v1` from the Compose network. Provide the Runtime bearer token scoped to the `independent-worker` business identity; the same business-scoped token can be used by replicas and versions for that business. Do not reuse a public API key or put a token in this repository. The business must be enabled and have a compatible submission path before it can receive tasks. `WORKER_IMAGE_DIGEST` must identify the actual immutable image; the all-zero value in `.env.example` is only a placeholder.

Submit the `echo` action using the normal public business submission endpoint with input `{ "text": "hello" }`. Runtime emits pointer-only `BusinessJobV1` messages to `du-business-independent-worker-<exact-version>`. The queue message is only a delivery hint: the worker claims the task and uses the returned execution snapshot as the authority for the pinned input and lease.

Each process creates a fresh UUID worker instance ID. Worker replicas may share a business version and queue, but each needs its own process identity and heartbeat row. Startup registers the exact manifest, sends a worker heartbeat, reports the observed backup-fence revision, and repeats the heartbeat when the server has not yet acknowledged that exact revision. Queue admission stays closed unless Runtime reports control `OPEN` and an acknowledged backup fence `OPEN`. Paused or draining workers continue heartbeats with zero admission capacity.

Task heartbeats are single-flight per task. A task is cancelled when the claim snapshot or a later task heartbeat says so; the local deadline watchdog refuses a late heartbeat ACK after the prior lease's safety deadline. Completion and failure reports carry the current `leaseEpoch`; report ACKs are checked before acknowledging a delivery. A lost or malformed report ACK retries the same settlement once, then defers queue recovery until lease expiry. Shutdown pauses admission, keeps worker heartbeats running while the bounded grace period drains handlers, aborts remaining task contexts at the deadline, closes the queue consumer, and retires only the exact business/version/manifest identity once consumer and in-flight settlement are confirmed.

## Standalone checks

```sh
npm ci
npm run build
npm test
```

Tests use mocked Runtime HTTP responses and an injected queue adapter. They do not connect to Redis, a database, object storage, or a provider.

## Protocol source references

The implementation follows the repository contracts in `orchestrator/packages/contracts/src/manifest-validator.ts` (canonical manifest digest and queue name), `orchestrator/packages/contracts/src/queue.ts` (strict `BusinessJobV1`), `orchestrator/packages/contracts/src/runtime.ts` (heartbeat, claim, lease, and settlement DTOs), `orchestrator/services/orchestrator/src/http/routes/runtime.ts` (Runtime v1 routes), `orchestrator/services/orchestrator/src/modules/runtime/worker-instances.ts` (backup-fence acknowledgement and identity-checked retirement), and `orchestrator/packages/worker-sdk/src/worker.ts` (existing lifecycle behavior). The references are explanatory only; this sample does not import those packages. Validate source compatibility against the checkout you deploy; a sample build does not prove a deployed Runtime or image is compatible.

The source audit for this sample used checkout `HEAD` `d2f0c88ddc65de0f59794afbc390b875462ce501` plus the following exact worktree file contents (SHA-256). The hashes pin the audited source even if the checkout has uncommitted edits:

| Source file | SHA-256 |
|---|---|
| `orchestrator/packages/contracts/src/manifest-validator.ts` | `bca40a6c6760a8cf71a90dcdbabfb561335011d00fc34bfce577702f2bc6bf37` |
| `orchestrator/packages/contracts/src/queue.ts` | `eb90c54bef5a081189fb7351f1bd4baa7ab6ee8a4cc8458c1983d0aa412e91bd` |
| `orchestrator/packages/contracts/src/runtime.ts` | `e28b6d8a9658f44512fe518974c5fbdcf55ba76a6ee88036cec865886363c91e` |
| `orchestrator/services/orchestrator/src/http/routes/runtime.ts` | `143a2639fa1af528de2b202522986d3981808dd5426df559ca301ecca14b63ae` |
| `orchestrator/services/orchestrator/src/modules/runtime/worker-instances.ts` | `36012315b3021901700756b759d952efc4bf07a5e4bf7a72e15330879cc087a2` |
| `orchestrator/packages/worker-sdk/src/worker.ts` | `a5581aa3f0109b304570703082450e364730a87c274fbaaf0e7b596123d9b70c` |
