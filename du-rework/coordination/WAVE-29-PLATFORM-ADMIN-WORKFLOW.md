# Wave 29 — platform, Admin, Workflow Builder (2026-09-22)

## Gate and ownership

W28-C is accepted at platform scope (56/56 migration/runtime PASS, DB/Redis
RELEASED). W26-O is accepted at pure Admin view-model scope (51/51 focused
tests, typecheck clean). Neither closes P7-06 or P6-01. Antigravity remains on
user-directed HOLD: **do not dispatch to its terminal**.

All agents share one dirty worktree. Preserve unrelated edits; do not reset,
clean, broadly stage, commit, push, or change lockfiles. Each lane edits only
its listed ownership area and own report. Run DB-backed tests serially in an
explicit exclusive window; report acquisition and RELEASED handoff.

## W29-C — Claude Code: R08-07 decision and P2-02 Admin authorization slice

Own `docs/15-decisions.md` (new ADR or linked decision), relevant
`services/orchestrator/src/server.ts` Admin auth/tenant handling and focused
tests, `coordination/reports/claude.md`. Do not edit `src/app/**`, root
Workflow Builder, business fixtures, or Antigravity files.

1. Record an explicit R08-07 decision on the current node:http/raw pg platform
   versus the target HTTP/UI/DB approach. State what is accepted for this
   rework, what is deferred (especially rendered Admin and production object
   storage), compatibility/migration consequences, and owner of server-side
   authorization. Do not silently declare a temporary slice the final target.
2. Audit Admin registry/version/profile routes for unauthenticated and
   cross-tenant access. Add focused negative tests for actual gaps; fix only
   confirmed authorization defects in owned platform code. Preserve stable
   ProblemDetails and existing authorized behavior. Do not claim all P2-02
   complete from this slice.
3. Run typecheck and focused/runtime tests. If using the shared DB, announce
   exclusive ownership first, run serially with scoped cleanup, then report
   exact counts and RELEASED. Summarize any untouched P2-02 gaps.

Acceptance: reviewable architecture decision plus negative authorization
evidence/fix; no new UI framework or storage migration without new authority.

## W29-O — OpenClaude: P6 profile-draft pure form logic

Own only `services/orchestrator/src/app/admin/**`,
`services/orchestrator/tests/admin-view-model.test.ts` (or new Admin-only unit
test), and `coordination/reports/openclaude.md`. Do not edit `server.ts`,
runtime modules, docs decision, root Workflow Builder, task checkboxes, or
platform tests. Begin only after the W26-O terminal returns to an idle prompt.

1. Extend the headless layer with typed, manifest-driven profile draft
   validation/diff helpers needed for P6-03: required fields, bounded widget
   coercion, unknown widget as explicit validated fallback, connector slot
   capability mismatch, locked values, and stale profile revision. Server
   remains authoritative; client validation must not imply authorization.
2. Keep secrets write-only/masked in projections and test diagnostics; never
   echo credentials. Add table-driven unit tests for valid/invalid/stale drafts,
   missing capabilities, and no-profile/empty manifest states.
3. Run focused Jest and `tsc --noEmit`. Report pure-layer scope, exact test
   counts, and remaining rendered UI/API integration gates. Keep P6-01/03 `[ ]`.

Acceptance: pure typed form helpers and green offline tests; no new framework
dependency or claim of browser/a11y completion.

## W29-CC — Command Code: root Workflow Builder Fix 4 persistence proof

Own root `lib/workflow-builder/run-schema.ts`,
`lib/pipelines/workflow-engine.ts`, focused `tests/workflow-builder/**`, and
`du-rework/coordination/reports/command-code.md`. Do not edit `du-rework`
platform/business code, Admin UI, root lockfiles, or unrelated pipeline paths.

1. Audit Fix 4 in `docs/fix-plan-workflow-builder.md`: pause currently embeds
   `_nodeResults` into `stepsResultJson`, and `createWorkflowContext` restores
   it, but current tests mostly mock `pauseWorkflow`. Add a persistence-boundary
   round-trip regression proving a paused cross-block HITL workflow restores
   prior node results after a fresh context/restart and resolves a later binding.
2. Remove new/owned `as any` around `_nodeResults` where a typed
   `WorkflowContext` field already exists; preserve old-format
   `stepsResultJson` compatibility and existing non-schema workflows. Fix only
   a reproduced gap; do not refactor broad legacy pipeline code.
3. Run focused and full `tests/workflow-builder` suite, plus scoped typecheck.
   State whether proof is mocked or DB/queue-backed; never claim live E2E from
   unit fixtures. Report exact counts and unresolved Fix 4 gaps.

Acceptance: restart/serialization regression at the actual persistence seam,
47-test baseline preserved, no cross-lane edits.
