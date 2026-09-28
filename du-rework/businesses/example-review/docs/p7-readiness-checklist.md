# P7 Business-Extension Readiness Checklist & Live-Test Design: Example-Review

- **Lane**: `businesses/example-review` (`@du/example-review`)
- **Date**: 2026-09-22 (Wave 30-A Active-Version Extension Proof)
- **Status**: **`PARTIAL (P7-01, P7-02, P7-05, P7-06 Complete; P7-03, P7-04 Partial; P7-07 Deferred)`**
  - Business-owned code, typed context adapters, input validation, and offline test suites: **100% COMPLETE & VERIFIED (90/90 tests PASS across 10 suites)**.
  - Live P7 continuation integration suite (`example-review-continuation.integration.test.ts`): **10/10 test cases PASS** on live PostgreSQL :5433 & Redis :6380 (18.251s).
  - P7-05 literal acceptance: **COMPLETE & LIVE VERIFIED (8/8 PASS in W26-A)**. Controlled stop with fixture-forced lease expiry.
  - P7-06 status: **COMPLETE & LIVE VERIFIED (10/10 PASS)**. Positive active-version proof verified live: version coexistence & active pointer switch (Case 9: 2030 ms), version drain & fail-closed 404, explicit rollback activation to v1.0.0, and continued pinned in-flight v2 execution (Case 10: 2007 ms).
  - Platform active-version contract & migration 0006: **CONFIRMED ACTIVE & LIVE VERIFIED** in Orchestrator (`services/orchestrator/src/server.ts:545-568`, `migrations/0006_active_version.sql`).
  - Full Phase Acceptance: **PARTIAL** — does not claim full P7-03..07 phase completion; open gaps explicitly tracked in Section 5.
  - Shared-DB Window Gate: **`RELEASED`** (Exclusive live testing completed; scoped cleanup verified; window returned to released state).
- **References**:
  - Contracts Runtime Schemas: [`packages/contracts/src/runtime.ts`](file:///D:/Git/dugate/du-rework/packages/contracts/src/runtime.ts)
  - SDK Context Facades: [`packages/worker-sdk/src/task-context.ts`](file:///D:/Git/dugate/du-rework/packages/worker-sdk/src/task-context.ts)
  - SDK Worker Disposition: [`packages/worker-sdk/src/worker.ts`](file:///D:/Git/dugate/du-rework/packages/worker-sdk/src/worker.ts)
  - Orchestrator Server: [`services/orchestrator/src/server.ts`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/server.ts)
  - Orchestrator Registry Module: [`services/orchestrator/src/modules/registry/registry.ts`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/registry/registry.ts)
  - Active Version Migration: [`services/orchestrator/migrations/0006_active_version.sql`](file:///D:/Git/dugate/du-rework/services/orchestrator/migrations/0006_active_version.sql)
  - Continuation Migration: [`services/orchestrator/migrations/0005_continuation.sql`](file:///D:/Git/dugate/du-rework/services/orchestrator/migrations/0005_continuation.sql)
  - Platform Lifecycle Service: [`services/orchestrator/src/modules/lifecycle/lifecycle.ts`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/lifecycle/lifecycle.ts)

---

## 1. Source Reality vs Wave 23 Snapshot (Delta Audit)

The stale Wave 23 checklist identified missing route registrations and an unloaded migration. A thorough re-audit of the live codebase confirms the platform lane has delivered the required continuation foundation:

| Component | W23 Snapshot Status | Current W24-W26 Verified Reality | Source Evidence |
|---|---|---|---|
| **Continuation DB Schema** | UNLOADED | **WIRED & LOADED AT STARTUP** | `services/orchestrator/src/server.ts:59` loads `0005_continuation.sql` (`human_waits` table + partial unique index `idx_human_waits_one_open_per_task`). |
| **`POST .../tasks/:id/children`** | UNIMPLEMENTED (404) | **ROUTED & HANDLED (202 ACCEPTED)** | `server.ts:389-397` delegates to `runtime.spawnChildren`. Returns `{ childTaskIds, parentState: 'WAITING_CHILDREN' }`. |
| **`GET .../tasks/:id/children`** | UNIMPLEMENTED (404) | **ROUTED & HANDLED (200 OK)** | `server.ts:398-403` delegates to `runtime.getChildren`. Returns `{ children: [...] }`. |
| **`POST .../tasks/:id/wait-input`** | UNIMPLEMENTED (404) | **ROUTED & HANDLED (200 OK)** | `server.ts:405-412` delegates to `runtime.waitInput`. Returns `{ waitId, expiresAt }`. |
| **`POST .../operations/:id/resume`** | UNIMPLEMENTED (404) | **ROUTED & HANDLED (202 NEW / 200 REPLAY)** | `server.ts:506-514` delegates to `runtime.resumeOperation`. Enforces CAS and AJV schema validation. |
| **Join Reconciliation** | ABSENT | **ATOMIC IN CHILD TERMINAL TX** | `runtime.ts:708-812` locks parent `FOR UPDATE`, reconciles all children, merges `joinSummary` into parent `payload_ref`, emits single `task.continuation` outbox row. |
| **Active Version DB Schema** | ABSENT | **WIRED & LOADED AT STARTUP** | `services/orchestrator/migrations/0006_active_version.sql` (`business_versions.is_active` boolean + partial unique index `business_versions_active_unique WHERE is_active = true`). |
| **`PUT .../versions/:v/activate`** | ABSENT (404) | **ROUTED & HANDLED (202 / 200 REPLAY)** | `server.ts:550-556` delegates to `registry.activateVersion`. Deterministic locking (`version ASC`) prevents deadlock; sets `is_active=true` and unsets old active version. |
| **`PUT .../versions/:v/deactivate`** | ABSENT (404) | **ROUTED & HANDLED (202 / 200 REPLAY)** | `server.ts:558-568` delegates to `registry.deactivateVersion`. Drains active pointer (`is_active=false`). |
| **Fail-Closed Drain Routing** | ORDER BY created_at DESC | **FAIL-CLOSED (404 NOT_FOUND)** | `submission.ts:225-233` queries `WHERE is_active=true`. Returns 404 when no active version is set; prevents fallback to stale version. |

---

## 2. Confirmed Wire Signatures & Delivery Contracts

### A. Child Task Spawning Contract (`POST /api/runtime/v1/tasks/:id/children`)
- **Request Body**:
  ```ts
  {
    leaseEpoch: number,
    children: Array<{
      taskKey: string,
      kind: string,
      payloadRef: Record<string, unknown>,
      payloadHash: string, // contentHash(payloadRef)
    }>,
    joinPolicy: 'all-success',
    continuationRef: string,
  }
  ```
- **Response**: HTTP 202 `{ childTaskIds: string[], parentState: 'WAITING_CHILDREN' }`.
- **Invariants**: Parent task and operation transition to `WAITING_CHILDREN`. Outbox dispatches `task.dispatch` for each child.

### B. Human Wait Contract (`POST /api/runtime/v1/tasks/:id/wait-input`)
- **Request Body**:
  ```ts
  {
    leaseEpoch: number,
    waitKey: string,
    inputSchema: Record<string, unknown>,
    uiSchema?: Record<string, unknown>,
    contextRef?: string | null,
    expiresAt?: string,
  }
  ```
- **Response**: HTTP 200 `{ waitId: string, expiresAt: string }`.
- **Invariants**: Row inserted in `human_waits` with `status = 'OPEN'`. Parent task and operation transition to `WAITING_INPUT`.

### C. Tenant Resumption Contract (`POST /api/v1/operations/:id/resume`)
- **Request Body**:
  ```ts
  {
    waitId: string,
    input: unknown,
    expectedStateVersion: number,
  }
  ```
- **Response**: HTTP 202 (fresh) or 200 (idempotent replay) `{ operationId, state, stateVersion, replayed, taskId }`.
- **Validation Rules**:
  - `expectedStateVersion !== operation.state_version` -> HTTP 409 `STATE_CONFLICT`.
  - `input` fails AJV validation against stored `wait.input_schema` -> HTTP 422 `INVALID_SCHEMA`.
  - `wait.status !== 'OPEN'` -> HTTP 409 `STATE_CONFLICT` (or 200 if already `ANSWERED`).
- **Resumption Delivery**:
  - `human_waits.status` becomes `'ANSWERED'`.
  - Parent task in DB receives `payload_ref = { resumeInput: b.input, waitId: wait.wait_id }`, `state = 'QUEUED'`.
  - Outbox emits `task.dispatch` with `kind: 'root'`.

### D. Worker Join & Resumption Payload Delivery
- **Join Delivery**:
  - When all children reach `SUCCEEDED`, parent task receives `payload_ref = { continuationRef, joinPolicy, joinSummary: { [taskKey]: resultRef } }`.
  - In `packages/worker-sdk/src/worker.ts:226-241`, because `snapshot.payloadRef` has keys, `ctx.input` is initialized to `snapshot.payloadRef`.
- **Resume Delivery**:
  - Resumed task receives `payload_ref = { resumeInput: b.input, waitId: wait.wait_id }`.
  - In `worker.ts`, `ctx.input` is initialized to `snapshot.payloadRef`. `ctx.waitResponse` is NOT separately populated by the SDK worker runner.
- **Business Adaptation**: `mainReviewHandler` inspects `ctx.input` for `joinSummary` (join continuation) or `resumeInput` (human wait resumption) so strict input validation does not reject continuation payloads as unexpected keys.

### E. Cancellation Semantics & Platform Limitations
- **Observed Platform Behavior**:
  - `services/orchestrator/src/modules/lifecycle/lifecycle.ts:35-39` marks `operations` and active `tasks` as `CANCELLED`.
  - **Platform Gap**: The `human_waits` table is NOT updated by `cancelOperation` or `sweepDeadlines`; existing rows remain `status = 'OPEN'`.
  - **Safety Guarantee**: Subsequent calls to `POST /api/v1/operations/:id/resume` query `operations` first. If `operation.state === 'CANCELLED'`, the server returns HTTP 409 `STATE_CONFLICT`. Therefore, cancellation fails closed securely despite the un-cascaded `human_waits` row.
  - **Test Assertion Policy**: Tests MUST NOT assert `human_waits.status === 'CANCELLED'`. Tests assert `operation.state === 'CANCELLED'`, `tasks.state === 'CANCELLED'`, and that subsequent `resume` calls fail closed with HTTP 409 `STATE_CONFLICT`.

---

## 3. Scoped Live-Test Harness Design for P7

- **Test Suite Location**: `businesses/example-review/tests/example-review-continuation.integration.test.ts`
- **Target Architecture**:
  - Orchestrator: live instance spawned via `createApp` on ephemeral loopback port (`http://127.0.0.1:<port>`).
  - PostgreSQL: dedicated test DB (`du_test` on `127.0.0.1:5433`), protected by `assertTestDatabase`.
  - Redis: BullMQ queues on `127.0.0.1:6380` with isolated test prefixes (`test-p7-*`).
  - Worker: live `@du/worker-sdk` worker running `exampleReviewBusiness` with background processing.
  - Connector: mock provider server answering `reasoning` slot requests with deterministic responses.

### Phased Test Matrix (10 Test Cases covering P7-T1..P7-T9 + P7-05 missing proofs + P7-06 version coexistence & rollback)

| Case # | Scenario | Trigger & Flow | Database / Queue Invariant | Assertion & Expectation |
|---|---|---|---|---|
| **Case 1 (P7-T1)** | Registration, Enablement & Explicit Activation | Admin registers `exampleReviewManifest` v1.0.0, enables version, and activates it via `PUT .../activate`. | `business_versions` has `(example-review, 1.0.0, ENABLED, is_active=true)`. | HTTP 200/201 (reg), 200 (enable), 200/202 (activate). |
| **Case 2 (P7-T2)** | Single Document Fast-Path | Submit 1 artifact (`requireApproval: false`). Worker processes inline. | Zero child tasks in `tasks`. Checkpoint `evaluate-items` saved. | Operation `SUCCEEDED`. Final artifact matches schema. |
| **Case 3 (P7-T3..T5)** | Multi-Document Fanout & Join (`RUN-05`) | Submit 3 artifacts. Parent calls `ctx.spawn.spawnAndWait`. Children process and write review artifacts. | Parent transitions `WAITING_CHILDREN`. 3 children reach `SUCCEEDED`. Parent transitions `QUEUED` -> `SUCCEEDED`. | `joinSummary` merged into parent `payload_ref`. Final output contains all 3 item results. |
| **Case 4 (P7-T6..T7 + P7-05 dup resume)** | Human Wait Yield, Tenant Resume & Duplicate Resume (`RUN-06`) | Submit 1 artifact with `requireApproval: true`. Worker yields on `ctx.wait.waitForInput`. Tenant calls `resume` (202), then calls `resume` second time. | `human_waits.status` transitions `OPEN` -> `ANSWERED`. Exactly one `task.dispatch` row in outbox for resumption delivery. | Fresh resume: HTTP 202 `{ replayed: false }`. Duplicate resume: HTTP 200 `{ replayed: true }`. Operation `SUCCEEDED`. |
| **Case 5 (P7-T8)** | CAS & Schema Validation Rejections | Call `POST .../resume` with stale `expectedStateVersion` or invalid schema. | `human_waits.status` remains `'OPEN'`. Task remains `WAITING_INPUT`. | Stale CAS -> HTTP 409 `STATE_CONFLICT`. Invalid schema -> HTTP 422 `INVALID_SCHEMA`. Zero worker dispatch. |
| **Case 6 (P7-T9)** | Operation Cancellation & Fail-Closed Semantics | Submit operation into `WAITING_INPUT`, then call `POST .../cancel`. | Operation & tasks transition to `CANCELLED`. `human_waits` row closes to `CANCELLED` (W27-C). | Operation `CANCELLED`. Subsequent `resume` rejected with HTTP 409 `STATE_CONFLICT`. |
| **Case 7 (P7-05 concurrency=1)** | Deadlock-Free Progress under Concurrency=1 (`RUN-05`) | Dedicated single-slot worker (`concurrency: 1`). Submit 2 artifacts. Parent calls `spawnAndWait`. | Parent yields slot freeing worker. Children process sequentially. Parent resumes and completes. | Operation reaches `SUCCEEDED` without worker deadlock. 3 tasks `SUCCEEDED`. |
| **Case 8 (P7-05 worker-restart)** | Mid-Wait Worker Restart & Replacement Recovery (`RUN-06`) | Operation enters `WAITING_INPUT`. Stop worker (`stop(5000)`). Tenant resumes while worker offline. Start replacement worker. | Task in DB is `QUEUED`. Replacement worker claims task and executes continuation. | Operation reaches `SUCCEEDED`. Result envelope includes approval note. Controlled stop with lease expiry. |
| **Case 9 (P7-06 version-coexistence)** | Version Coexistence & Pinned In-Flight Continuation (`VER-01`) | Op1 enters `WAITING_INPUT` under v1.0.0. Enable & activate v2.0.0 and start Worker v2. Submit Op2 under v2 -> routes to v2. Resume Op1 -> completes on pinned Worker v1. | Outbox routes Op2 to `du-business-example-review-2.0.0` and Op1 resume to `du-business-example-review-1.0.0`. `is_active=true` for v2.0.0, false for v1.0.0. | Op2 `SUCCEEDED` with `version: '2.0.0'` and `[2.0.0]` summary marker. Op1 `SUCCEEDED` with `version: '1.0.0'` and `[1.0.0]` marker. |
| **Case 10 (P7-06 drain-rollback)** | Active-Version Drain, Fail-Closed 404, Rollback & Pinned Continuation (`VER-01`) | Drain v2.0.0 (`PUT .../deactivate`). Verify fresh submission fails closed (404 NOT_FOUND). Rollback activate v1.0.0 (`PUT .../activate`). Submit Op-post-rollback -> routes to v1.0.0 and succeeds on Worker 1. Resume in-flight Op-v2 -> completes on Worker 2 with `[2.0.0]`. | `is_active` transitions: (v2=true, v1=false) -> drain: (both false) -> rollback: (v1=true, v2=false). Drained submissions write zero operation/task rows. In-flight tasks retain queue pins. | Drain returns 202 `{ active: false }`. Submit returns 404 `no active version`. Rollback returns 202 `{ active: true }`. Post-rollback operation `SUCCEEDED` on Worker 1 with `[1.0.0]`. In-flight v2 resumes to `SUCCEEDED` on Worker 2 with `[2.0.0]`. |

---

## 4. Coordinated Execution Gate Verdict & Verification Results

- **Wave 30-A Status**: **`LIVE VERIFIED (10/10 PASS) — EXCLUSIVE WINDOW RELEASED`**.
- **Live Test Execution Results (PostgreSQL :5433 & Redis :6380)**:
  - `pnpm --filter @du/example-review test:integration`: **10/10 PASS** (18.251s):
    - `P7-T1`: Registers example-review manifest v1.0.0 and enables version via Admin API (**PASS: 40 ms**).
    - `P7-T2`: Processes single-document review inline with durable checkpoints and no child tasks (RUN-04) (**PASS: 291 ms**).
    - `P7-T3..T5`: Spawns child tasks, joins all-success, and continues parent to SUCCEEDED (RUN-05) (**PASS: 3843 ms**).
    - `P7-T6..T7`: Enters WAITING_INPUT, yields slot, and resumes to SUCCEEDED on tenant input (RUN-06) (**PASS: 1960 ms**).
    - `P7-T8`: Rejects resume with 409 on stale CAS and 422 on invalid schema; wait remains OPEN (RUN-06) (**PASS: 239 ms**).
    - `P7-T9`: Cancels operation in WAITING_INPUT; subsequent resume fails closed with 409 (P2-06) (**PASS: 251 ms**).
    - `P7-05 (concurrency=1)`: Multi-document fanout and all-success join progresses to SUCCEEDED under concurrency=1 without worker deadlock (RUN-05) (**PASS: 3615 ms**).
    - `P7-05 (worker-restart)`: Recovers and completes continuation when worker is restarted while operation is in WAITING_INPUT (RUN-06) (**PASS: 1993 ms**).
    - `P7-06 (version-coexistence)`: Runs v1 and v2 concurrently, routes new submissions to v2, and resumes in-flight v1 on pinned worker (VER-01) (**PASS: 2030 ms**).
    - `P7-06 (drain-rollback)`: Proves version drain fail-closed 404, explicit rollback activation to v1.0.0, and continued pinned execution for in-flight v2 work (VER-01) (**PASS: 2007 ms**).
- **Offline Verification & Non-Infra Tests (This Session)**:
  1. `pnpm --filter @du/example-review test:unit`: **90/90 PASS** across 10 suites in 1.796s.
  2. `pnpm --filter @du/example-review test:typecheck` (`tsc --noEmit -p tsconfig.test.json`): **PASS (0 errors)**.
  3. `pnpm --filter @du/example-review lint` (`tsc --noEmit -p tsconfig.json`): **PASS (0 errors)**.
  4. `pnpm --filter @du/document-core test:typecheck` (`tsc --noEmit -p tsconfig.test.json`): **PASS (0 errors)**.
- **Shared-DB Window Gate**:
  - Gate: **`RELEASED`** (Live integration suite ran exclusively and completed; scoped cleanup verified; window released).

---

## 5. Reconciliation against Project Tasks (P7-01 through P7-07)

The 10 integration test cases in `example-review-continuation.integration.test.ts` group all behavioral verification scenarios (labeled P7-T1 through P7-T9 + missing P7-05 proofs + P7-06 coexistence and rollback).

| Project Task ID | Acceptance Standard | Wave 24-26 Proven Scope | Wave 30-A Status & Unproven Gaps | Task Row Status |
|---|---|---|---|---|
| **P7-01** | Only public shared packages; no platform internals | Manifest v1.0.0, action schemas, strict input/child/resume schemas using only `@du/contracts` and `@du/worker-sdk`. Tested in `tests/manifest.test.ts` and `tests/package-boundary.test.ts`. | Manifest v2.0.0 added using only `@du/contracts`. Tested in `tests/version-coexistence.test.ts`. | **`[x] COMPLETE`** |
| **P7-02** | Worker implementation built only with documented SDK contracts | Authoritative child review aggregation, durable step checkpoints, typed worker handler without unapproved casts. 90/90 unit tests pass across 10 suites; `tsc --noEmit` 0 errors. | Multi-manifest worker configuration (`config.manifest`) and observable version markers supported. | **`[x] COMPLETE`** |
| **P7-03** | EXT-01: new manifest appears on registry without platform rebuild; frozen digests; provision identity/ACL | Live manifest registration (`PUT .../businesses/.../versions/...`) and Admin enablement (`PUT .../enable`) proven in P7-T1 without Orchestrator rebuild. | Image digests have NOT been frozen into release artifacts. Container ACL and standalone Compose deployment unexecuted (P8/G5 release scope). | **`[ ] PARTIAL`** |
| **P7-04** | UI-01: generic Admin profile assignment; submit via generic API; no custom business UI | Generic Public API submit/poll/resultRef verified live via HTTP in P7-T2..T9. | Generic Admin UI profile assignment (UI-01) not tested (UI is P6 scope). No browser or UI verification performed. | **`[ ] PARTIAL`** |
| **P7-05** | RUN-05..07: Fanout/HITL/cancel/restart + duplicate resume proof; concurrency=1 progress | Proven live across 8 test cases in W26-A. Controlled worker stop with fixture lease expiry clarified. | Complete live evidence verified. | **`[x] COMPLETE`** |
| **P7-06** | VER-01: v1/v2 concurrent versions, drain and rollback profile; v1 human waits resume | Offline unit tests pass (10/10 in `version-coexistence.test.ts`). Live integration tests authored for concurrent execution, pinned resumption, and rollback repro. | **LIVE VERIFIED (10/10 PASS)**: Positive active-version proof verified live (Cases 9 & 10): version coexistence, active target switch, fail-closed drain (404), rollback activation to v1.0.0, and pinned in-flight v2 continuation. | **`[x] COMPLETE`** |
| **P7-07** | G5: extension developer guide and immutable-digest evidence | Basic `README.md` exists. | Comprehensive developer onboarding guide and immutable digest evidence unexecuted. | **`[ ] DEFERRED`** |

**Conclusion on Phase P7**:
Phase P7 cannot be claimed as DONE. P7-01, P7-02, P7-05, and P7-06 are complete. P7-03 and P7-04 are partially proven at the API and runtime integration level. P7-07 is deferred. The overall phase status is **`PARTIAL`**.
