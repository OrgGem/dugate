# Workload rebalance 04 — lane reliability closeout while runtime gate is pending

Date: 2026-09-20. Copilot and Antigravity completed workload rebalance 03 and are idle. Claude remains active on the Orchestrator P2 vertical slice. This packet assigns only work that can finish before `runtime-ready.md` and preserves the ownership map in `coordination/README.md`.

## Plan status at assignment time

| Phase | Evidence-based status | Remaining dependency |
|---|---|---|
| P0 | Business/API/architecture documents exist; central checklist is stale | Formal central status reconciliation by platform owner |
| P1 | READY: contracts/workspace gates published; contracts 70 tests, observability 16 tests | None for consumer lanes |
| P2 | IN_PROGRESS: Claude actively building Orchestrator runtime | `runtime-ready.md` and durable runtime tests |
| P3 | Local/durable Connector path implemented and tested | Usage delivery plus remaining reliability/security cases; real P2 integration |
| P4 | READY: Worker SDK gate published; Document Kit implemented | Cross-service evidence after P2 |
| P5 | Six actions/28 variants implemented; executable worker passes 144 tests | Reliability/traceability closeout; real P2/P3 E2E |
| P6 | Not started | P2 management APIs |
| P7–P8 | Blocked | P2 runtime gate and cross-service integration |

Central task checkboxes remain unchanged in this wave because `du-rework/tasks/**` is platform-owned and Claude is active. Each lane records a task-ID evidence matrix in its own report for later central reconciliation.

## Copilot — P3 reliability, usage delivery and security closeout

Write only `services/connector/**`, `packages/connector-client/**`, `coordination/reports/copilot.md`, and `coordination/requests/copilot.md`.

1. Implement a lifecycle-managed usage-outbox dispatcher around the existing durable outbox. Add an injectable `UsageSink`, bounded batches, retry with capped exponential backoff/jitter, retry scheduling persisted in PostgreSQL, idempotent event IDs, and graceful drain. A failed Orchestrator delivery must never lose or duplicate usage.
2. Provide an optional HTTP usage sink configured with a full URL and service credential. Validate the existing `@du/contracts` usage schema before send. Do not invent or edit a shared DTO; if the unpublished runtime endpoint differs, isolate the mapping behind the sink and record the dependency in `requests/copilot.md`.
3. Wire the dispatcher into the Connector composition only when usage delivery is configured. Define readiness and shutdown behavior explicitly and test both configured and disabled modes without requiring Claude's service.
4. Harden provider egress against SSRF: validate scheme, reject URL userinfo, block loopback/private/link-local/metadata destinations by default, constrain redirects, and support an explicit test/development allowlist. Validate every resolved destination, including redirect targets. Never expose provider credentials in errors.
5. Map Connector domain errors to stable HTTP statuses and contract error bodies instead of returning 500 for every non-input failure. Cover auth/scope, conflict/hash mismatch, quota, disabled/revoked, provider rate limit/unavailable/timeout, and UNKNOWN.
6. Add focused fault tests for outbox crash/restart, duplicate delivery acknowledgement, poison/retry exhaustion behavior, sink timeout, SSRF bypass attempts (IPv4/IPv6/hostname/redirect), and secret redaction. Preserve the currently passing unit and durable suites.
7. Update `reports/copilot.md` with an evidence matrix for P3-01 through P3-08: COMPLETE, PARTIAL, or BLOCKED, with exact test references. Do not edit the central P3 task file.

Acceptance: strict typecheck passes; existing tests remain green; new tests show usage convergence and fail-closed provider egress. Real Orchestrator usage projection remains explicitly pending until `runtime-ready.md`.

Do not edit root manifests/lockfile, contracts, Worker SDK, Orchestrator, infra, shared tests, or Antigravity paths.

## Antigravity — P5 behavior and recovery closeout

Write only `businesses/document-core/**`, `packages/document-kit/**`, `coordination/reports/antigravity.md`, and `coordination/requests/antigravity.md`.

1. Build a machine-checkable 28-variant traceability suite from BRD case ID → manifest action/schema → recipe → connector slot → expected output validation. The test must fail if a documented variant is missing, duplicated, routed to an undeclared slot, or lacks an output validator.
2. Add explicit output validation for every provider-backed action before a result artifact is finalized. Malformed JSON, missing required fields, invalid enum/range, and schema mismatch must produce stable business error codes; never complete with a partial/empty object.
3. Add cancellation/lease-loss checks at side-effect boundaries in the six handlers and common pipeline helpers. Once aborted, do not invoke another provider, write/finalize a result artifact, or report success.
4. Add checkpoint replay tests with provider/artifact call counters. A retry after a successful step must restore the complete checkpoint and must not repeat that step's provider call or artifact write. Include long output to prove no truncation.
5. Audit and enforce bounded inputs using existing business/profile limits: artifact count, text/document size, page selection, custom-schema depth/property count, QA question count, and generated output limits. Errors must be deterministic and classified as non-retryable validation/resource errors.
6. Add a deterministic full-business local E2E matrix for all six actions and 28 variants using synthetic fixtures and controlled mock connector responses. Keep real LLM output out of golden assertions.
7. Update `reports/antigravity.md` with an evidence matrix for P5-01 through P5-10: COMPLETE, PARTIAL, or BLOCKED, with exact tests. Do not edit the central P5 task file.

Acceptance: preserve the current 144 tests, strict typechecks pass, and new tests prove output validation, cancellation fencing, checkpoint replay and complete 28-variant traceability. Real Orchestrator/Connector multi-process E2E remains pending.

Do not edit root manifests/lockfile, contracts, Worker SDK, Orchestrator, Connector, infra, shared tests, or central docs/tasks.

## Conflict controls

1. Claude remains the only writer for P2, central task status, shared gates, root workspace files, contracts, SDK, infra and shared tests.
2. Copilot and Antigravity work concurrently only in their existing disjoint lanes.
3. Both agents preserve concurrent edits and must not reset, clean, stash, rebase, broadly stage, or broadly format the checkout.
4. Missing shared behavior is reported through the lane request file; it is not patched across ownership boundaries.
