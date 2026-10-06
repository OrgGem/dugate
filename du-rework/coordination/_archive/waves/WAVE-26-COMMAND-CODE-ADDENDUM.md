# Wave 26 addendum — Command Code lane (2026-09-22)

## Assignment and boundary

Command Code (`term_2f2b02e1-edfe-40c4-9461-bc08dece869e`) joins Wave 26 as
W26-CC, an independent coding lane for the **root/legacy Workflow Builder**.
This is separate from the `du-rework` implementation: OpenClaude owns
`du-rework/services/orchestrator/src/app/**`, Claude Code owns platform
migration/bootstrap, and Antigravity owns example-review P7 proof. Their
existing tasks and shared DB/Redis window are unchanged.

Own only `lib/workflow-builder/**`,
`app/api/v1/docs/workflows/schema/route.ts`, dedicated
`tests/workflow-builder/**` and a dedicated route test under `tests/**`, plus
`coordination/reports/command-code.md` for the report. Do not edit
`du-rework/services/**`, `du-rework/businesses/**`, shared package scripts,
lockfiles, `lib/pipelines/workflow-engine.ts`, `worker.ts`, or another agent's
report. If a genuine fix requires one of those files, document the smallest
repro and request a new scoped handoff first. Preserve the dirty worktree; no
reset/clean, broad staging, commit, or push.

## W26-CC — reconcile root Workflow Builder P0 Fix 2 / Fix 3

The plan in `docs/fix-plan-workflow-builder.md` is partly stale: Fix 2's
`existingResults` path exists in `interpreter.ts` and `run-schema.ts`; the
`POST /api/v1/docs/workflows/schema` route for Fix 3 also exists. Treat these
as **implemented but not accepted** until tests prove behavior. Do not create
a duplicate `/api/internal/workflow-schemas/[id]/run` route merely because an
older request names it; the written Fix 3 contract is the public slug route.

1. Audit `runSchemaDag`, `runWorkflowFromSchema`, the schema route, and the
   relevant workflow tests. Add a regression test with connector A -> human
   pause -> connector B using `$a.content`. Verify B resolves A after an
   actual resume-shaped context restoration, and that A is not re-executed.
   Include a direct DAG `existingResults` test if it clarifies the contract.
   Fix only reproduced gaps in the owned Workflow Builder files; use typed
   context/result handling and avoid new `any` casts.
2. Add focused route tests for slug lookup/validation, malformed `input`,
   accepted enqueue response and operation polling header. Verify the route
   delegates to existing pipeline submission and does not enqueue invalid
   requests. Mock DB/queue boundaries; no real DB, Redis, AI, or external
   network. If existing auth/submit semantics prevent a case, report it
   precisely rather than bypassing security or expanding to other files.
3. Run focused Jest for changed tests, TypeScript check and lint as available.
   Report exact commands, case counts, unresolved gaps and whether Fix 2/3
   are accepted in `du-rework/coordination/reports/command-code.md`. Do not
   mark the broader rework phase or production gate complete. The legacy
   Workflow Builder and `du-rework` are distinct scopes.

Acceptance: reproducible cross-block resume proof, route contract tests,
focused green checks or a precise blocker. Any plan mismatch must be stated
without rewriting the historical fix plan or claiming a missing route that
already exists.
