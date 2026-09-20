# Workload rebalance 01 — unblock platform gates

Date: 2026-09-20. Authorized by user request to optimize the workload of the existing Claude, Antigravity and Copilot sessions. This packet does not change path ownership in `coordination/README.md`.

## Current evidence

- Claude is actively publishing `@du/contracts`. Contracts independently pass 70 tests and typecheck; observability passes 16 tests and typecheck.
- Worker SDK tests currently fail to compile after contract changes (`TaskHeartbeatAck.leaseExpiresAt` and string `resultRef` fixtures).
- `services/orchestrator` has no implementation beyond README. No readiness gate or Claude report exists yet.
- Antigravity's reported 99/99 local tests are stale: independent rerun passes 95/99, with four PDF split assertions failing because installed `pdf-lib` emits a valid PDF version other than the hard-coded `%PDF-1.4` expectation.
- Copilot's connector and client typechecks pass; connector 12/12 and client 2/2 tests pass. Production auth, concrete client wiring and cross-service integration remain.

## Claude — shorten the critical path

Do not expand Admin UI or broad Orchestrator implementation until these milestones are stable:

1. Finish and test `@du/contracts`; publish `coordination/gates/contracts-v1.md` with exact exports, versions, commands and remaining limitations.
2. Repair `@du/worker-sdk` tests against the frozen contract and publish `workspace-ready.md` and `sdk-ready.md` only with actual passing commands.
3. Create/update `coordination/reports/claude.md` with completed task IDs, failures and next vertical slice.
4. Then implement the smallest Orchestrator vertical slice: submit/outbox → claim/heartbeat/checkpoint → complete/result, before Admin UI.

Acceptance: contracts, observability and worker-sdk test/typecheck pass; gate files contain executable evidence; consumers receive a clear integration signal. Claude retains sole ownership of shared contracts, root dependency/lockfile and Orchestrator.

## Antigravity — independent document correctness

1. Fix the four currently failing PDF split tests. Validate PDF semantics/openability and selected page content without pinning an irrelevant PDF minor version, or force the implementation version only if the business contract truly requires it.
2. Remove silent long-document truncation in reasoning actions (`slice(0, 3000/4000)`). Implement bounded chunking with complete coverage or explicit size rejection; add tests proving tail content is processed or rejected, never silently ignored.
3. Re-run both strict typechecks and all document-kit/document-core tests. Update `reports/antigravity.md` with current results and distinguish local mocks from runtime evidence.

Constraints: edit only Antigravity-owned paths. Do not adopt or modify shared contracts/SDK until Claude publishes gates. No root install or lockfile changes.

## Copilot — independent Connector production hardening

1. Add injectable service-identity and signed-grant verification boundaries in Connector-owned code with negative tests for missing/wrong scope, audience, expiry, tampered payload/input hash and secret redaction. Do not invent or change shared DTOs.
2. Add graceful startup/shutdown/drain behavior and a standalone Connector Dockerfile/entrypoint under `services/connector/**`; readiness must fail when required durable dependencies are unavailable while liveness remains process-scoped.
3. Add fault tests for request-too-large, provider timeout/UNKNOWN, credential revoke between attempts and usage-outbox replay. Preserve current no-blind-retry policy.
4. Compare current local protocol with `@du/contracts` read-only and record exact adoption blockers in `requests/copilot.md`; wait for `contracts-v1.md` before changing wire DTOs.

Constraints: edit only Connector/connector-client/report/request paths. Do not edit root dependencies, shared contracts, Orchestrator or infra. Existing passing tests must remain green.

## Integration order

1. Claude publishes contracts/workspace/SDK gates.
2. Antigravity and Copilot adopt exact shared exports in their owned paths and report consumer test results.
3. Claude implements the Orchestrator vertical slice and publishes runtime-ready evidence.
4. Cross-service E2E starts only after the three reports agree on the same contract version.
