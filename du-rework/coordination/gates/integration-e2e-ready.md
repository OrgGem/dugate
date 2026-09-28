# Gate: integration-e2e-ready — PARTIAL (live cross-service E2E, G4 business gate)

Date reviewed: 2026-09-22 (Wave 24 results). **Supersedes** the 2026-09-21
PARTIAL-with-stubbed-Connector review and R08-04 conclusion: the current E2E
no longer stubs the Connector invocation path. The 2026-09-21 entry is
historical, kept below for audit.

## Scope proved (Wave 24, agent-reported — not independently rerun)

`businesses/document-core/tests/multi-container-e2e.integration.test.ts`
(13/13 PASS) drives six document-core actions through the public Orchestrator
API, BullMQ worker delivery, real `@du/worker-sdk` runtime calls, Orchestrator-
issued invocation grants, the **real Connector composition** (durable ledger,
quota, outbox dispatcher, `ContractSignedGrantVerifier` over canonical
invocation hashing), usage ingestion/projection and artifact finalize/access.
PostgreSQL :5433 and Redis :6380 are real isolated services.

The external provider is a **mock HTTP server** (it is the business's intake
boundary, not a Connector stub); the Connector composition itself is real.
13 cases include: extract/invoice live ledger path, six actions, cooperative
429 retry + checkpoint replay, SIGKILL crash/lease recovery, version pinning,
profile authorization (403), and connector-revision pinning.

BullMQ smoke 1/1 PASS (separate run); example-review continuation 6/6 PASS
(`example-review-continuation.integration.test.ts`) covers fanout/join,
human wait/resume, schema/CAS rejection, and cancel fail-closed. Coordinator
independently reran example-review unit 87/87 and all three typechecks
(Orchestrator, document-core, example-review).

## Remaining evidence (G4 partial, not full E2E readiness)

- Mock provider is a P8 packaging concern; real provider/dynamic concurrency
  not exercised.
- Mid-wait worker process crash/restart, duplicate resume 200 replay,
  and `concurrency=1` deadlock-free progress are untested.
- Operation cancel does not cascade to `human_waits.status` (remains `OPEN`);
  platform guards enforce fail-closed 409 — documented platform gap.
- Services booted from immutable images, real document-core image digest,
  and a full P7 extension with Admin profile UI (UI-01) are unexecuted (P8/G5).
- v1/v2 coexistence, drain, rollback, and resuming v1 waits after v2
  enablement are undelivered.

## Gate boundary

This gate still does not close P2/P4 composite rows, P7 full extension proof,
or P8 release readiness. The 2026-09-21 stub-oriented boundary note and the
R08-04 withdrawal-of-P5-10 are historical; P5-10 verdict is now provisional
pending Antigravity W25-A reconciliation (do not read either as current).
