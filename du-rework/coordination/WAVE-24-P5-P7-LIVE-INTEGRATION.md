# Wave 24 — conditional P5/P7 shared-DB live integration (2026-09-22)

## Coordinator audit and gate

Current source contains the four continuation handlers in
`services/orchestrator/src/server.ts`: POST and GET task children, POST
wait-input, and POST operation resume. The server loads
`migrations/0005_continuation.sql`; runtime service has spawn, join, wait,
resume and outbox logic. Independent `pnpm --filter @du/orchestrator lint`
passed. Claude reports 36/36 runtime tests including nine new continuation
cases, but coordinator did not rerun these while Claude was active. His
`coordination/reports/claude.md` publication/exclusive DB handoff is pending.

Antigravity's Wave 23 P7 checklist was correct when written, but its
"unimplemented routes/unloaded migration" and NO-GO reason are now stale.
Do not interpret route presence/unit tests as live business P7 proof. Last
independently verified business baseline is 41 non-infra suites / 511 tests;
43 suites / 525 tests is inventory.

**Gate is CONDITIONAL GO:** source/typecheck ready; shared-DB execution remains
NO-GO until Claude explicitly confirms he has stopped platform writes/builds
and runtime tests against PostgreSQL :5433 / Redis :6380 and grants an exclusive
window. If this confirmation is absent, do the read-only alignment work below,
report WAITING_FOR_EXCLUSIVE_WINDOW and return idle. No blind retry or polling.

## W24-A — Antigravity, existing business lane

Preserve dirty worktree. Own only `businesses/document-core`,
`businesses/example-review`, `packages/document-kit`, and your report/checklist.
Do not edit platform/SDK/contracts/root lockfile/Claude report; no reset,
clean, broad staging or push. Never run shared-DB suites concurrently.

1. Re-audit current continuation source and correct
   `businesses/example-review/docs/p7-readiness-checklist.md` to distinguish
   old W23 snapshot from current route/migration reality. Compare actual
   response/error shapes, resume request (including `waitId` and
   `expectedStateVersion`), worker join payload, queue delivery and cancel
   semantics to the proposed P7-T1..T9 cases. Amend expectations before
   writing/running tests; note any unsupported cancellation assertion as a
   platform gap, not a fabricated PASS.
2. When Claude explicitly hands off the exclusive test targets, check the
   current session, report, test-target guard, and no competing test process.
   Run exactly `pnpm --filter @du/document-core test:integration:full` (its
   script already builds dependencies) as sole shared-DB owner. Record all
   13 cases, evidence for Test 12/13, failures and cleanup. Run BullMQ smoke
   separately only after the E2E exits. If a test fails, preserve traces and
   isolate whether the defect is business harness or platform; do not patch
   Claude-owned code.
3. Then, still serially and only if the window remains exclusive, implement
   and execute a business-owned P7 live integration suite using real
   Orchestrator/Redis/PostgreSQL and SDK worker, following the corrected
   checklist. Prove fanout/yield, children/join/parent continuation, human
   wait/resume, schema/CAS rejection, and cancellation/failure behavior with
   persisted state and observable output assertions. It is acceptable to
   phase the nine designed cases; report exactly which ran. Do not call an
   authored or mocked case live PASS.
4. Rerun affected typechecks and non-infra tests after any code changes.
   Update `coordination/reports/antigravity.md` with commands, fresh counts,
   cases passed/failed/skipped, known platform defects, cleanup status and
   P5/P7 gate verdict. Release the exclusive window when finished and inform
   coordinator/Claude. Do not silently expand into a platform fix.

## Stop conditions

No explicit exclusive handoff; unsafe/non-test target; migration/build
failure; unrelated shared-DB activity; or a persistent infra collision:
stop shared-DB testing and report the concrete reason. A failing assertion
is not automatically a stop for all business work, but do not bury it or
promote P5/P7. Platform-owned failure goes back to Claude with repro.
