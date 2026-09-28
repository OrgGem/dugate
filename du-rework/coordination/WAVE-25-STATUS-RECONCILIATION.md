# Wave 25 — reconcile Wave 24 evidence with rework plan (2026-09-22)

Wave 24 execution is complete: Claude published stable continuation routes,
36/36 runtime tests and exclusive handoff; Antigravity reports document-core
live E2E 13/13, smoke 1/1, and example-review live continuation 6/6, then
released the DB window. Coordinator independently reran example-review unit
87/87 and typechecks for Orchestrator, document-core tests, and example-review
tests. Do not turn this into a new shared-DB test wave.

## W25-A — Antigravity: business task-row audit

Own only `tasks/P5-document-core.md`, `tasks/P7-extension-proof.md`,
`businesses/example-review/docs/p7-readiness-checklist.md`, and your own
`coordination/reports/antigravity.md`. Do not edit
`coordination/IMPLEMENTATION-STATUS.md` or platform/gate files.

1. Compare each P5-10 acceptance item with the actual Wave 24 tests and G4
   business gate. Update its checkbox/status only if *all* row acceptance is
   proven; otherwise retain partial and name the missing proof. Separate
   business E2E from P8 immutable-image/release evidence. Remove stale claims
   about a fixed-invoice stub, hash shim, or extract-only coverage where Wave 24
   source/evidence disproves them.
2. Audit P7-01..07 separately. Do not promote P7-03..07 wholesale because a
   6-case integration suite covers nine scenario labels. Specifically check
   generic profile/UI assignment, concurrency=1, restart and duplicate resume,
   v1/v2 coexistence/drain/rollback, immutable digests, and developer guide.
   Record the observed cancellation limitation: terminal op/task with
   `human_waits.status = OPEN`, resume fail-closed. Distinguish proven paths
   from missing full acceptance, and correct the report/checklist labels.
3. Include exact file/test evidence, fresh-vs-agent-reported scope and open
   items. Documentation/task reconciliation only; no product code changes,
   shared-DB tests, broad cleanup, or git reset. Preserve dirty worktree.

Acceptance: P5-10 and every P7 checkbox match its literal acceptance, with
links to code/tests and no phase-level DONE overclaim. Report conclusions to
coordinator so the status-index owner can reconcile them.

## W25-C — Claude Code: platform/status-index audit

Own only `coordination/IMPLEMENTATION-STATUS.md`,
`coordination/gates/integration-e2e-ready.md`, and your own
`coordination/reports/claude.md`. Do not edit P5/P7 task files, Antigravity
report, or business code.

1. Replace the stale Wave 24 top status ("handoff pending/live unexecuted")
   with dated Wave 24 evidence: 36/36 runtime agent report, 13/13 P5 E2E,
   smoke 1/1, P7 6/6, and exclusive-window release. Label which results were
   independently rerun by coordinator versus reported by agents. Preserve old
   audit entries as historical, not current.
2. Reconcile the phase matrix/gate without claiming full P7, G4/G5, or
   production readiness. Call out incomplete P7 profile/UI, restart/duplicate
   resume, version coexistence/rollback, immutable digest/developer guide,
   and human-wait cancellation cleanup. Check current source before retaining
   any old Connector-stub/hash-shim/extract-only claims.
3. Keep platform backlog precise: artifact lifecycle, R08-06 one-shot
   migration/bootstrap, SDK UNKNOWN test, root-kind continuation limitation,
   serial-only shared DB, and any lease-sweeper gap. Do not silently promote
   these to DONE or implement unrelated fixes in this packet.
4. Document-only coordination update, with no platform source changes or
   shared-DB test run. Preserve dirty worktree. Antigravity owns task-row
   verdicts; if its in-flight audit differs, mark the status row provisional
   pending reconciliation rather than guessing.

Acceptance: current status index and gate describe Wave 24 accurately, name
remaining phase blockers, and do not conflict with task-row ownership.
