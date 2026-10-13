---
name: du-worker-runtime
description: Build or adapt an independent DUGate business worker against the active Orchestrator queue and Runtime API without a Worker SDK dependency. Use for SDK-free worker projects, not ordinary SDK-backed workers or Orchestrator API changes.
---

# Independent DU business workers

Use this skill when a business worker must own its queue consumer, Runtime HTTP client, and task lifecycle. Keep the implementation language-neutral and local to that worker. Do not add `@du/worker-sdk`, depend on the contracts package at runtime, vendor the SDK, or copy SDK code and relabel it as independent. Read source schemas to implement only the wire features the worker needs.

Before coding, identify the Orchestrator source version the worker will target. Record its Git revision, working-tree state, and SHA-256 hashes of the relevant contract and route files; a commit alone is not a complete pin when source files are modified. Recheck those sources whenever protocol compatibility matters. Use [the v1 contract reference](references/runtime-v1.md) for routes and exact payload fields, and [the verification checklist](references/verification.md) for behavior and evidence checks. Repository-relative paths in these references are verification pointers only; a worker must not import them at runtime.

Implement the smallest honest manifest and feature set. Generate a fresh UUID `workerInstanceId` for each process start and keep it stable for that process’s lifetime. Do not reuse it after restart. The provisioned Runtime bearer is business-scoped and intentionally shared across replicas and versions. Version binding is enforced through the registered manifest, worker row, queue, and claim. Do not require or invent per-instance or per-version credentials. Route Runtime traffic to the internal port 3002 (`/api/runtime/v1`), not the public listener.

Treat every queue delivery as a prompt to claim the durable task. Validate the claim’s business, version, and manifest digest before running a handler. Fence every task report with the returned `leaseEpoch`; heartbeat the task lease, stop on cancellation or lease loss, and make recovery safe after lost responses or process restarts. Keep worker heartbeats running while admission is paused or draining.

Keep version admission separate from execution control and the backup-effect fence. A current heartbeat carries `activeVersion`, positive `activationRevision`, `admissionEligible`, and `admissionReason`. New claims require a complete, valid tuple that marks this exact worker version `ELIGIBLE`; missing or unknown fields fail closed for new work. Ignore lower-revision late replies, and fail closed if the tuple changes without a higher revision. A version switch pauses new claims only: already-claimed tasks continue under their valid lease, subject to cancellation, lease expiry, and existing control/security fences. If a claim response is ambiguous, reconcile it with one bounded replay of the same task, delivery, and worker identity even after admission closes; never use that path for a new delivery. See [the v1 contract reference](references/runtime-v1.md) for exact codes and drain behavior.

Advertise only capabilities that are implemented and exercised. Optional artifacts, checkpoints, Connector calls, child tasks, and human waits each add protocol and deployment requirements; read the relevant matrix before exposing one. Unsupported or unconfigured features must be disabled or rejected clearly. The sample at `samples/independent-worker/`, when working in this repository, is a minimal inline-input root handler, not a Document Core replacement.

Report evidence in separate levels: source compatibility and local tests; the built worker image and its digest; and a live Orchestrator end-to-end run using that image. A source route, passing unit test, or successful configuration check does not prove the built image or running deployment supports the worker.

