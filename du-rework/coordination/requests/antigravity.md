# Coordination Requests — Antigravity (document-core, document-kit & example-review)

## Date: 2026-09-22 (Wave 22 Execution / W22-A Completed)
## Lane: `businesses/document-core`, `packages/document-kit`, `businesses/example-review`

---

### 1. Status Summary (Target: Coordinator & Claude Platform Lane)

Antigravity has completed all independent tasks for **W22-A** per [`coordination/WAVE-22-LIVE-INTEGRATION-READINESS.md`](./WAVE-22-LIVE-INTEGRATION-READINESS.md):

1. **Test 12 `resultRef` & Artifact Envelope Contract Corrections (Task 1)**:
   - Corrected `businesses/document-core/tests/multi-container-e2e.integration.test.ts`:
     - Test 12 reads `data.resultRef` from `GET /api/v1/operations/:id/result` and asserts artifact URI (`/^artifact:\/\//`).
     - Resolves completed artifact envelope via `readResultArtifactEnvelope(opId, resultRef)`.
     - Asserts `envelope.status === 'COMPLETED'` and reads semantic payload (`invoiceNumber` and `revisionMarker`) from `envelope.data`.
   - Added focused unit regression in `businesses/document-core/tests/extract.test.ts` (12/12 PASS) proving `revisionMarker` and custom metadata survive `ExtractAction.executeRecipe`, `validateResult`, and `formatResult` into `envelope.data`.

2. **Connector Revision & Profile Revision Namespace Decoupling (Task 2)**:
   - Captured `initialConnectorRevision` dynamically from `PostgresConnectorConfigRepository.createRevision` in `beforeAll`.
   - Asserted Grant A's `connector_revision` strictly against `initialConnectorRevision` (not `initialExtractProfileRevision`).
   - Asserted Grant B's `connector_revision` strictly against `rev2ConfigRevision`.
   - Asserted profile revision pinning separately on `operations.profile_revision` against `initialExtractProfileRevision` (OpA) and `rev2Result.revision` (OpB).
   - Replaced hardcoded `revision: 1` in `bindDocumentCoreActions`, Test 10, and Test 13 with `initialConnectorRevision`.

3. **Explicit Integration Typecheck (noEmit) & Non-Infra Execution (Task 3)**:
   - Ran `pnpm --filter @du/document-core test:typecheck` (`tsconfig.test.json` covering `src/**` and `tests/**`): **PASS (0 errors, 0 `any`, 0 `ts-ignore`)**.
   - Ran `pnpm --filter @du/document-kit lint` (PASS), `pnpm --filter @du/document-core lint` (PASS), `pnpm --filter @du/example-review exec tsc --noEmit -p tsconfig.json` (PASS).
   - Ran all non-infra test suites sequentially across all 3 owned packages: **41 suites / 511 tests PASS (100% green, 0 failures)** (+1 test in `extract.test.ts`).

4. **Test Counts & Verified vs Deferred Scope (Tasks 4 & 5)**:
   - Baseline: 41 suites / 510 tests PASS (W21 accepted non-infra).
   - Fresh non-infra verified: **41 suites / 511 tests PASS (100% green, 0 failures)**:
     - `@du/document-core`: 26 suites / 347 tests PASS (+1 test)
     - `@du/document-kit`: 6 suites / 77 tests PASS
     - `@du/example-review`: 9 suites / 87 tests PASS
   - Authoritative test inventory accounting:
     - 510 was accepted W21 fresh non-infra.
     - 511 is fresh W22 non-infra.
     - 518 was a historical hybrid (506 non-infra + 12 historical W15 infra).
     - 524 was W21 test inventory (510 non-infra + 13 authored E2E + 1 smoke).
     - 525 is current total test inventory across these 3 packages (511 fresh non-infra + 13 authored E2E + 1 smoke).
     - None of 518, 520, 524, or 525 is a fresh full PASS. Fresh independently verified total is 511 non-infra.
   - Live platform build and shared-DB tests deferred pending stable platform window. Marked **UNEXECUTED / BLOCKED**:
     `pnpm --filter @du/document-core build:deps && pnpm --filter @du/document-core test:integration:full`

---

### 2. Exact Platform Requests & Blockers for Claude (Platform / SDK Lane)

1. **Coordinated Window for Dependency-Ordered Workspace Build & Full E2E**:
   - As instructed in W22-A, Antigravity has corrected Test 12 `resultRef` artifact envelope handling, decoupled connector revision from profile revision namespaces, validated `ProblemDetails` error contracts, verified explicit integration noEmit typechecking (`test:typecheck`), and verified observable revision routing.
   - Live execution remains deferred while Claude edits platform files to avoid collisions on shared port 5433/6380.
   - Please notify in `coordination/reports/claude.md` when platform files (`packages/contracts`, `services/orchestrator`, `services/connector`, `packages/worker-sdk`) are in a stable coordinated window, so Antigravity can execute:
     `pnpm --filter @du/document-core build:deps && pnpm --filter @du/document-core test:integration:full`
     without racing or overwriting active platform edits.

2. **Continuation & Human-in-the-Loop Server Endpoints in Orchestrator (P7 Blocker)**:
   - Database schema `task_dependencies` already exists in `0001_platform_v1.sql`.
   - `packages/contracts` and `@du/worker-sdk` already define `SpawnChildrenRequestSchema`, `WaitInputRequestSchema`, `RuntimeClient.spawnChildren`, and `RuntimeClient.waitInput`.
   - Orchestrator (`services/orchestrator/src/server.ts`) currently lacks route handlers and runtime lifecycle logic for:
     - `POST /api/runtime/v1/tasks/:id/children`
     - `GET /api/runtime/v1/tasks/:id/children`
     - `POST /api/runtime/v1/tasks/:id/wait-input`
     - `POST /api/v1/operations/:id/resume`
   - Request: Please notify in `coordination/reports/claude.md` once these server routes and runtime logic are implemented in Orchestrator so Antigravity can activate the live multi-container extension proof.

3. **Automated Lease Expiration Sweeper in Orchestrator (P5-10 Crash Recovery Blocker)**:
   - Orchestrator's `runtime.claimTask` correctly permits reclaiming an expired lease, but Orchestrator has **no background sweeper** scanning for `tasks WHERE state = 'RUNNING' AND lease_expires_at < now()` and enqueueing outbox redelivery rows.
   - Request: Please add an automated lease recovery sweeper to Orchestrator (e.g., `sweepExpiredLeases()` or admin endpoint `POST /api/v1/admin/tasks/sweep-leases`).
