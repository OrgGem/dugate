# Wave 26 — three-lane execution (2026-09-22)

## Wave 25 acceptance and shared rules

W25-A and W25-C are accepted for documentation reconciliation. `tasks/P5-document-core.md`
now closes P5-10 for its literal business G4 acceptance: 28 fixture-backed variants
and six-action live E2E (13/13 agent-reported). `tasks/P7-extension-proof.md` closes
P7-01/02 only; P7-03/04/05 remain partial and P7-06/07 remain open. The status
index and integration gate now describe the Wave 24 live evidence, but their
"W25-A pending/provisional" text is stale and should be corrected by the status
owner below. Do not infer production/release readiness from 53 suites / 648
agent-reported test results. The shared PostgreSQL :5433 / Redis :6380 window
is RELEASED; all future DB-backed tests must be serialized by explicit handoff.

All three agents share one dirty worktree. Preserve existing changes; do not
reset/clean, broadly stage, push, or edit another lane's files. Use TypeScript
strict; no `any`, test-only contract shims, or credentials in reports.

## W26-O — OpenClaude: P6-01 headless Admin foundation (coding)

Own `services/orchestrator/src/app/**` and dedicated
`services/orchestrator/tests/admin-view-model.test.ts` only. No edits to
`server.ts`, runtime/db/migrations, worker SDK, root package/lockfile,
`IMPLEMENTATION-STATUS.md`, or task checkboxes. This is a bounded P6-01
foundation, **not** a claim that a rendered Admin UI exists.

1. Read `tasks/P6-admin.md`, docs 05–08/11, actual Admin/public route contracts,
   and the unresolved R08-07 UI/server boundary. Implement typed, pure view
   models and functions for navigation/role visibility and loading, empty,
   error, forbidden states. Include a schema-driven profile form model with
   unknown-widget safe fallback and explicit revision display; use generic
   manifest/profile data, never hardcode document-core/example-review fields.
2. Add focused table-driven tests for admin/operator/viewer visibility,
   missing capability, unregistered business, no profile, stale revision and
   unknown widget. UI models must not grant authorization; server remains
   authoritative. No raw key persistence or secret echo.
3. Run focused Jest and `@du/orchestrator` lint/typecheck. Report which P6-01
   pieces are implemented and which still require an R08-07 architecture
   decision, rendered navigation/auth guards and browser/accessibility proof.
   Keep P6-01 `[ ]` until those acceptance parts are real. Report in
   `coordination/reports/openclaude.md` (own file).

Acceptance: compilable pure UI model code + tests, no route/module edits or
framework dependency addition, honest partial status, no shared-DB run.

## W26-C — Claude Code: P2-01/R08-06 explicit migration path

Own platform bootstrap/migration implementation under
`services/orchestrator/src/{server.ts,db/**}` and a dedicated platform test,
plus `services/orchestrator/package.json` and your report if needed. Do not edit
`src/app/**`, business packages or Antigravity/OpenClaude reports.

1. Resolve R08-06 and P2-01: provide an explicit, repeatable one-shot migration
   command with clear boot-vs-migrate behavior. Audit existing `createApp`
   tests/callers first; preserve runtime test fixture usability while ensuring
   production service boot no longer silently applies schema changes. No
   destructive migration or reset. Make the command idempotent on a test DB,
   fail closed on non-test target when a test-only fixture is used, and document
   deployment order/rollback boundary.
2. Add tests for empty test DB -> migration -> boot, repeated migration, and
   boot without required schema (clear error, no hidden write). Run typecheck
   and focused tests. Shared-DB tests require an exclusive window; coordinate
   with Antigravity before executing, and release it explicitly afterward.
3. Reconcile W25-A final verdict in `coordination/IMPLEMENTATION-STATUS.md`:
   P5-10 business row is checked; P7-01/02 checked, 03–05 partial, 06/07 open.
   Remove only stale "W25-A pending/provisional" wording, keep P8/G4/G5
   boundaries and agent-reported-vs-independent evidence. Do not promote
   P2-01 until migration acceptance actually passes. Record outcome in
   `coordination/reports/claude.md`.

Acceptance: explicit migration CLI and tested boot boundary, no regression of
36-case runtime suite after coordinated run, current status index accurate.

## W26-A — Antigravity: P7-05 missing-proof tests

Own `businesses/example-review/**`, `tasks/P7-extension-proof.md`, and your
report/checklist. Do not edit platform or OpenClaude files. Start with source
audit and offline test design while Claude changes migration/bootstrap.

1. Add focused business-owned integration assertions for three missing P7-05
   proofs: `concurrency=1` fanout/join progress without deadlock; worker
   restart while a parent is waiting and successful continuation after restart;
   duplicate resume returning 200 `{ replayed: true }` without duplicate
   dispatch/output. Use the published SDK/API and suite-scoped fixtures. Do
   not mask errors with mocks of continuation endpoints.
2. After Claude explicitly grants a stable exclusive DB/Redis window, run the
   P7 live suite serially, followed by non-infra tests and test:typecheck.
   Never run shared-DB tests concurrently with Claude migration tests. If
   platform behavior blocks a case, capture smallest repro and return it to
   Claude; keep P7-05 partial rather than patch platform from this lane.
3. Keep the `human_waits.status=OPEN` cancellation gap visible. Update the
   checklist/task row/report with exact case counts, command output and
   whether P7-05 literal acceptance is now met. No P7-06/07 expansion in this
   wave and no release-image claim.

Acceptance: authored reproducible tests and truthful run evidence or a precise
exclusive-window/platform blocker. P7-05 checkbox changes only on full proof.

## Coordination order

OpenClaude's headless P6 work is independent and uses no DB. Claude controls
the platform migration test window first; Antigravity may prepare tests offline
but starts live P7 only after Claude's explicit release. Return the DB window
to RELEASED after each run. Reports are agent-owned; coordinator reviews final
task/gate claims before further promotion.
