# Wave 28 — idle-lane follow-up, Antigravity hold (2026-09-22)

## Current gate

Antigravity's W27-A report now records live continuation **10/10 PASS**,
example-review unit **90/90 PASS**, typecheck clean, and PostgreSQL :5433 /
Redis :6380 **RELEASED**. Case 9 proves v1/v2 coexistence and an in-flight
v1 human wait resuming on the pinned v1 worker. Case 10 proves a platform gap:
re-enabling v1 leaves new submissions on v2 because resolution orders by
`created_at DESC`; there is no disable/drain route. P7-06 remains `[ ]`.
These counts are agent-reported pending independent review; they are not
permission to mark P7-06 complete.

Per user directive, **do not assign Antigravity a new task**. Its W27-A
artifacts remain available for review. OpenClaude continues its existing
W26-O Admin view-model work without overlapping platform routes.

All agents share a dirty worktree. No reset/clean, broad staging, commit,
push, credential disclosure, or unrelated dependency churn. DB-backed suites
must run exclusively and serially; announce acquisition and explicit
RELEASED handoff in the owning report.

## W28-C — Claude Code: explicit version activation/drain/rollback

Own `du-rework/services/orchestrator/src/modules/registry/**`, relevant thin
Admin routing in `services/orchestrator/src/server.ts`, a dedicated registry
test or focused runtime test, migration only if truly necessary, and
`coordination/reports/claude.md`. Do not edit `src/app/**`, business packages,
root Workflow Builder, or Antigravity's report/checklist/task row.

1. Reproduce W27-A Case 10 from published API: registering/enabling v2,
   then re-enabling v1 does not change selection; disable/drain is absent.
   Audit existing registry schema and `resolveEnabledVersion` before
   choosing a minimal durable model for the active version. Keep existing
   v1 operations pinned through wait/resume and allow v2 to coexist.
2. Implement explicit Admin activation/rollback and drain/disable semantics
   with tenant/admin authorization, state/version checks, stable error
   envelopes, and no deletion of a version that has in-flight operations.
   New submissions must select the explicitly active version, not merely the
   most recently created version. Existing claims/queue routing for pinned
   operations must remain unchanged. If the current API cannot express an
   active pointer safely, propose the smallest compatible migration and
   document the rollout order before applying it.
3. Add real-DB tests for v1→v2 activation, rollback to v1, drain of v2 for
   new submissions while v2 in-flight continuation still resolves, invalid
   version, cross-tenant/unauthorized calls, and idempotent retry. Keep test
   cleanup scoped; no global TRUNCATE. Run typecheck, migration/runtime
   regression, and the new focused suite serially in an exclusive DB window.
4. Report exact commands/results, API contract, remaining P7-06 dependency,
   and explicit DB RELEASED. Do not tick P7-06 or claim P7 phase DONE:
   business live acceptance remains a separate later gate, and Antigravity
   is on hold.

Acceptance: deterministic active version for *new* submissions plus safe
drain/rollback, while pinned in-flight work remains routable; focused and
baseline tests green or a precise API/schema blocker.

## W28-CC — Command Code: strict test and lockfile closeout

Own only root `tests/workflow-builder/run-schema.test.ts`,
`tests/workflow-builder/schema-route.test.ts`, the root `package-lock.json`
provenance check, and `du-rework/coordination/reports/command-code.md`.
Do not edit platform, business, OpenClaude, root package scripts or source
workflow implementation unless a reproduced failure requires a new packet.
No DB/Redis test in this lane.

1. Replace every **newly introduced** `any` in W26-CC tests with typed
   fixtures/mocks (`NextRequest`-compatible route request shape and typed
   context/enqueue inputs). Do not broaden to pre-existing unrelated casts
   without evidence. Preserve all cross-block and route assertions.
2. Investigate the still-modified root `package-lock.json` (26 additions,
   25 deletions at coordinator audit). Explain whether the change was made
   by the earlier install and whether it is required. Reconcile only changes
   conclusively attributable to this lane; never discard another person's
   dirty work or overwrite the lockfile speculatively. If ownership remains
   uncertain, leave it intact and report the unresolved diff.
3. Rerun the full root Workflow Builder suite (baseline 9 suites / 47
   tests), focused TypeScript check, and an exact changed-file diff review.
   Report whether mocked/unit Fix 2/3 closeout now meets the packet. Do not
   claim live schema-route E2E or mark `du-rework` phase checkboxes.

Acceptance: 47-test behavioral baseline preserved, no new `any` in owned
tests, lockfile provenance accurately reported, no cross-lane edits.
