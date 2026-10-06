# Wave 31 — offline Admin and Workflow Builder lanes (2026-09-22)

## Gate

W29-O was accepted at pure Admin profile-draft scope (66/66 tests). W30-CC
has 71/71 Workflow Builder tests and accepted helper-contract coverage, but
its packet's network-error evidence is missing; browser/E2E remains open.
Claude Code is implementing W30-C lease recovery and owns the next shared
DB-backed test window. Antigravity W30-A is OFFLINE_READY, waiting for an
explicit DB/Redis handoff. Neither Wave 31 lane uses shared DB/Redis.

All agents share one dirty worktree. Preserve unrelated changes. No reset,
clean, broad staging, commit, push, or dependency/lockfile churn. Edit only
owned files and your own report. Do not change task checkboxes or
IMPLEMENTATION-STATUS.md.

## W31-O — OpenClaude: P6-04 headless Connector configuration view models

Own only `services/orchestrator/src/app/admin/**`, Admin-only unit tests in
`services/orchestrator/tests/`, and `coordination/reports/openclaude.md`.
Do not edit `services/orchestrator/src/server.ts`, runtime/DB modules,
root Workflow Builder, business fixtures, or other agents' reports.

1. Read `tasks/P6-admin.md`, `docs/08-connector-api.md`, `docs/11-admin-ux.md`,
   current Connector contracts and W29-O view-model conventions. Add typed,
   pure P6-04 view models for connector configuration revisions, masked
   endpoint/credential display, explicit rotate-secret action state, and
   connector test result states (success, provider unavailable, invalid
   credential, quota/timeout, pending). Distinguish adapter capability from
   a successful live connectivity test; do not expose secrets in rows,
   diffs, errors, or serialized diagnostics.
2. Add table-driven tests for empty/loading/error, revision stale/conflict,
   secret write-only/copy-once semantics, test action requested explicitly,
   capability missing, and each test-result state. Use contract/manifest
   fixtures, not business-specific hardcoding. Client display rules must
   not imply server-side authorization or perform I/O.
3. Run focused Jest and whole Orchestrator `tsc --noEmit`; report exact counts
   and the remaining P6-04 rendered UI, API wiring, browser/a11y, and server
   enforcement gates. Keep P6-04 `[ ]`.

Acceptance: deterministic secret-safe pure models with offline tests, no
framework dependency, no cross-lane writes, no premature P6 completion.

## W31-CC — Command Code: close W30-CC network-error evidence gap

Own only root `app/workflow-builder/run-schema-client.ts`, its call site in
`app/workflow-builder/page.tsx` if needed, focused
`tests/workflow-builder/run-schema-client.test.ts`, and
`coordination/reports/command-code.md`. Do not edit Orchestrator/Admin,
business packages, route handlers, root lockfiles, or Antigravity files.

1. Add a testable boundary for the Run-modal request outcome that covers
   rejected `fetch`, malformed/non-JSON response, 400/404 ProblemDetails,
   accepted 202 operation navigation, and a successful response without an
   operation id. The existing page catch for network failure is not tested by
   W30-CC's 21 helper tests. Extract only enough pure/request logic to prove
   that failure is surfaced safely and submitting state is released; keep
   `page.tsx` wired to the tested helper. Avoid a dead helper or a speculative
   full UI rewrite.
2. Preserve multipart field names, required-field validation, and existing
   route contract. Add focused tests, including a rejected fetch promise and
   recoverable retry path. If the Node Jest environment cannot prove actual
   React state/DOM behavior, explicitly say so; do not label unit tests as
   browser or live E2E.
3. Run focused and full `tests/workflow-builder` suites (71-test baseline),
   scoped TypeScript check, and update report with exact results and residual
   browser/E2E gap. No shared DB/Redis tests.

Acceptance: network-error branch and result mapping have executable evidence,
without regressions or claims of browser automation.
