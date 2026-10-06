# Wave 22 — live integration readiness (2026-09-22)

## Coordinator acceptance of W21-A

Antigravity's W21-A source changes and offline checks are accepted within their
verified scope. Independently reran `@du/document-core` non-infra 26 suites / 346
tests, `@du/document-kit` 6 / 77, and `@du/example-review` 9 / 87: **41 suites /
510 tests PASS**. `pnpm --filter @du/document-core test:typecheck` also PASS.
The 13 authored multi-container cases and one smoke case were not executed in
this audit; **43 suites / 524 tests is inventory, not fresh PASS**.

Source audit found two remaining Test 12 contract defects despite typecheck:

1. `GET /api/v1/operations/:id/result` returns `data.resultRef` in
   `services/orchestrator/src/server.ts`, not inline `invoiceNumber` or
   `revisionMarker`. Test 12 currently reads those fields directly. Existing
   E2E cases use `readResultArtifactEnvelope(operationId, resultRef)` and assert
   semantic fields on `envelope.data`.
2. Grant A's `connector_revision` is compared with
   `initialExtractProfileRevision`. These are different revision namespaces.
   Current setup happens to create connector revision 1 and profile revision 1;
   equality is accidental. Capture/assert the actual connector revision from
   setup independently of the profile revision.

The offline barrier/cleanup test proves its local model; it does not execute
the E2E helper or substitute for a live failure-path run. No claim of live
revision routing or cross-service acceptance yet. Claude remains active on
platform continuation routes; avoid concurrent shared-DB builds/tests.

## W22-A — Antigravity business/integration lane

Ownership: `businesses/document-core`, `packages/document-kit`,
`businesses/example-review`, and own coordination report/request. Preserve the
dirty worktree. No edits to platform, SDK/contracts, root lockfile, or another
agent's reports; no reset/clean/broad staging/push.

1. Correct Test 12 result assertions to follow each operation's `resultRef`
   through the existing artifact helper and assert semantic data from the
   completed envelope. Verify that the response marker survives the actual
   extraction mapping; if the action intentionally discards it, use supported
   observable evidence (distinct invoice payload plus route counters/grants)
   rather than asserting an impossible field. Add a focused regression where
   practical; keep exact provider-call deltas.
2. Capture connector revision 1 from repository setup, then assert Grant A
   against that value and profile pinning against the separately captured
   profile revision. Audit Test 12/13 for other same-shaped but distinct
   revision/response contracts. Keep fail-closed Test 13 ProblemDetails checks.
3. Rerun explicit integration typecheck and all owned non-infra suites. Inspect
   Claude's current report/session once for a stable platform build and
   exclusive PostgreSQL/Redis test window. If published, coordinate and run
   dependency-ordered build plus all 13 E2E tests, then smoke separately;
   record exact command, failures, and fresh totals. Do not race Claude's
   runtime tests or use stale dist as acceptance evidence.
4. If no stable window exists, report the exact blocker and stop after the
   offline fixes/tests. If continuation routes land during this wave, perform
   a read-only contract audit against the published SDK/server and update the
   P7 readiness checklist; do not claim live P7 without executed fanout/join/
   wait-input/resume cases or start speculative cross-lane rewrites.
5. Update `coordination/reports/antigravity.md` with W22-A result, scoped
   evidence, and remaining upstream blockers. Distinguish fresh PASS, authored
   inventory, and deferred live cases.

Acceptance: Test 12 matches actual result/artifact and connector/profile
revision contracts; owned offline/typecheck checks green; live E2E evidence
or an explicit, narrowly scoped platform-window blocker. P5-10 and P7 stay
PARTIAL until their respective live gates are actually met.
