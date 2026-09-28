# Wave 30 — idle-lane task packets (2026-09-22)

## Coordination update — Antigravity resumed by user

The earlier HOLD language below is historical: the user explicitly requested
resuming Antigravity. W30-C (Claude Code) and W30-CC (Command Code) are already
active in their existing terminals; OpenClaude continues W29-O. Antigravity
owns **W30-A** below. Shared PostgreSQL :5433 / Redis :6380 must remain
exclusive: Claude Code W30-C may need it, so Antigravity starts offline and
does not start live integration until Claude explicitly reports RELEASED and
the coordinator/window owner hands it over. No overlap with platform edits.

## W30-A — Antigravity: P7-06 live acceptance against active-version API

Own `businesses/example-review/**`, its continuation integration tests,
`tasks/P7-extension-proof.md`, and `coordination/reports/antigravity.md`.
Do not edit `services/orchestrator/**`, `packages/**`, root Workflow Builder,
OpenClaude Admin UI, or other agents' reports. Preserve the dirty worktree.

1. Review W27-A Case 9/10 and W28-C corrected active-version contract:
   `PUT .../versions/:version/activate` explicitly selects new-submission
   version; `deactivate` on the sole active version makes new submissions
   fail closed with 404 until an operator activates a replacement. W27-A
   Case 10 asserts a platform defect that is now resolved; replace that
   stale expected-failure repro with a positive generic-API proof. Do not
   retain a passing test whose assertion is obsolete.
2. Offline: update fixtures/tests to prove v1/v2 workers coexist; v1
   `WAITING_INPUT` operation remains pinned and resumes on v1 after v2
   activation; drain v2 blocks fresh submissions (404, no new dispatch);
   explicit rollback activation of v1 routes new submissions to v1 while
   already-pinned v2 work remains on v2. Assert observable version markers,
   operation business_version, outbox/queue routing and absence of duplicate
   dispatch. Use published Admin/Public APIs for state transitions, not direct
   SQL to create the desired routing state. Keep all fixture cleanup scoped.
3. Run offline unit tests and source/test typecheck. Then wait for explicit
   shared-DB RELEASED handoff from Claude Code W30-C before running
   `pnpm --filter @du/example-review test:integration` live. If W30-C stays
   active, report OFFLINE_READY and do not collide. After live run, report
   exact case counts and return DB/Redis to RELEASED.
4. Update checklist/task/report with line-by-line acceptance. Tick P7-06
   only if every coexistence, drain, rollback, and pinned-continuation claim
   has live proof. Keep P7-03/04 and P7-07 open unless their separate
   acceptance is genuinely met; do not claim whole P7 done.

Acceptance: positive live P7-06 evidence on the corrected platform with no
platform-source changes, or a precise failed invariant/contract blocker.

## Gate and dispatch status

W29-C is accepted at its bounded platform/ADR scope (coordinator rerun:
63/63 migration/runtime PASS; current Orchestrator typecheck clean). W29-CC
was accepted at mocked persistence-seam scope (50/50). Shared DB/Redis is
RELEASED. OpenClaude is still executing W29-O; do not overlap its
`services/orchestrator/src/app/admin/**` work. Antigravity remains on
user-directed HOLD: **no new task to its terminal**. This document prepares
packets for idle Claude Code and Command Code; dispatch requires a fresh idle
terminal check and explicit DB-window ownership if DB tests are involved.

All agents share one dirty worktree. Preserve all unrelated modifications;
no reset/clean, broad staging, commit, push, or lockfile churn. Keep reports
lane-specific and give exact commands/results, limitations, and release state.

## W30-C — Claude Code: P2-09 expired-lease recovery slice

Own only `services/orchestrator/src/modules/runtime/**`, the necessary
background lifecycle/bootstrap wiring under `services/orchestrator/src/**`,
focused Orchestrator tests, and `coordination/reports/claude.md`. Do not edit
`src/app/**`, root Workflow Builder, business packages, or Antigravity files.

1. Audit current claim/outbox/heartbeat behavior when a real worker dies after
   claiming a task and the lease expires. Distinguish an idle worker from a
   crashed RUNNING worker; do not requeue WAITING_INPUT/WAITING_CHILDREN or a
   terminal operation. Document whether an existing periodic path already
   recovers the task without another inbound delivery.
2. If that path is missing, implement the smallest durable, idempotent
   expired-lease sweep/re-dispatch through the existing outbox mechanism.
   Preserve lease epoch fencing, operation/version/profile pins, checkpoint
   replay, retry budget, and at-most-one logical dispatch per recovery. Ensure
   concurrent sweepers and a late old worker cannot produce unfenced writes.
3. Add real-DB tests for expired RUNNING recovery, unexpired/idle exclusions,
   terminal/wait exclusions, and repeated/concurrent sweep idempotency.
   Exercise the production scheduling hook or document any hook still missing;
   a manual-only helper is not P2-09 completion. Run typecheck plus focused
   and baseline regression serially in the exclusive DB window; report exact
   counts and explicit RELEASED handoff. Do not tick P2-09 without its full
   background lifecycle/health/shutdown acceptance.

Acceptance: evidence that an expired leased task can be safely redispatched
without an external duplicate delivery, or a precise blocker/design if a
minimal safe implementation is not possible in this packet.

## W30-CC — Command Code: Workflow Builder Fix 5 browser-to-route contract

Own root `app/workflow-builder/page.tsx`, focused root
`tests/workflow-builder/**`, and `coordination/reports/command-code.md` only.
Do not edit `du-rework/services/**`, platform tests, root lockfiles, or
OpenClaude's Admin files. No shared DB/Redis window in this lane.

1. Audit `docs/fix-plan-workflow-builder.md` Fix 5 against the current page:
   the Run modal already posts multipart `schemaSlug`/`input`/`files[]` to
   `/api/v1/docs/workflows/schema`. First identify actual contract mismatches
   or missing tests; do not rewrite working UI merely because the historic
   plan says it is absent.
2. Add focused interaction/contract evidence for required-field validation,
   successful 202 operation navigation, 400/404 ProblemDetails display,
   network error, and file payload. If existing Jest setup cannot render the
   page safely, extract a pure typed request/result helper inside the owned UI
   area and test that boundary; state clearly if browser interaction remains
   unproven. Fix only reproduced gaps, preserving existing route behavior.
3. Run full root Workflow Builder baseline (10 suites / 50 tests), scoped
   typecheck, and report exact results. No claim of real DB/queue E2E from
   mocked fetch tests; do not alter unrelated root Workflow Builder fixes.

Acceptance: explicit Fix 5 contract coverage with no regression and honest
browser/E2E scope; if current implementation is already correct, document
that and ship tests rather than speculative code changes.

## Deferred lanes

OpenClaude: complete and report W29-O first; a rendered Admin shell packet
must use ADR-14 and be separately reviewed before dispatch. Antigravity:
HOLD even though platform active-version routing is ready for later P7-06
business live acceptance.
