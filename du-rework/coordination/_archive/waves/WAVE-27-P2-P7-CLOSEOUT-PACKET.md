# Wave 27 — P2 cancellation consistency and P7 version coexistence (issued 2026-09-22)

## Coordinator reallocation — Antigravity hold (2026-09-22)

User directive: **temporarily assign no further task to Antigravity**. Do not
dispatch W28-A, P7-07, P8 verification, or a P7-06 follow-up to its terminal.
The already-issued W27-A is not cancelled or called complete: its latest
terminal shows a live suite rerun and a qualitative success observation, but
the agent hit an individual quota before publishing final case counts,
checklist/report reconciliation, and an explicit DB-window release. Preserve
its code/tests and mark W27-A **IN REVIEW / HANDOFF INCOMPLETE**. P7-06 stays
`[ ]` until the version coexistence, drain, rollback, and old-wait resume
claims are evidenced against the final platform contract. Do not assume the
shared PostgreSQL :5433 / Redis :6380 window is RELEASED from a terminal
prompt or historical report. Run no competing DB-backed suite until an
explicit resource handoff or independent positive verification of cleanup.

Rebalanced active lanes, without widening file ownership:

| Agent | Current lane | Next decision |
|---|---|---|
| Antigravity | W27-A authored/live-attempted; quota-paused | No new task. Preserve results; coordinator may review existing evidence. Resume/close out only under a later user direction and a verified DB window. |
| Claude Code | W27-C complete; platform owner idle | Prepare an API-level design for explicit active-version selection, drain/disable, and rollback from Antigravity's Case 10 repro. Do not edit business tests or run DB tests while resource ownership is unverified. This is a planning candidate, **not dispatched**. |
| Command Code | W26-CC behavior 47/47 green at root; closeout gaps | Reconcile `package-lock.json` owner/change provenance and replace new `any` in the two tests with typed fixtures; rerun 47 tests. This is a bounded follow-up candidate, **not dispatched**. Do not treat mocked route proof as live E2E. |
| OpenClaude | W26-O P6-01 view-model foundation in progress | Finish only the already-issued headless model/tests/report scope. P6-01 remains `[ ]` without rendered UI and browser/accessibility proof. |

The next coordination gate is evidence review, not another agent wave: verify
W27-A exact live results and resource release, W26-CC strict/lockfile cleanup,
and W26-O output before changing task checkboxes. A platform version-routing
task for Claude may be issued separately only after reviewing the repro and
confirming it will not collide with an active Antigravity DB run.

## Coordinator progress checkpoint (12:00 cycle)

W27-C implementation is source-reviewed: cancel closes OPEN waits to
`CANCELLED`, deadline closes them to `EXPIRED` in transactions; migration CLI
documentation matches the explicit production migration contract. Claude
reports 49/49 DB-backed tests PASS and RELEASED; coordinator independently
reran Orchestrator typecheck only, because Antigravity now owns the shared DB
window. W27-C is accepted as a bounded platform slice, not P2-06 or G2
completion. Antigravity is executing W27-A live; no competing DB run.

Command Code reports W26-CC 47/47 and coordinator reran all 47/47 root
Workflow Builder tests. Functional Fix 2/3 proof is accepted at mocked/unit
scope, but packet closeout is pending strict-type cleanup (`any` in the new
tests) and reconciliation of a modified root `package-lock.json` against the
agent's no-lockfile-change report. OpenClaude W26-O is still coding. Do not
include either W26 coding lane in a DONE rollup until those files/reports are
reviewed and its own acceptance is met.

## Entry gate and ownership

Wave 26-A and 26-C are accepted for their literal P7-05 and P2-01 rows. The
coordinator independently reran Orchestrator migration/runtime 45/45 and
example-review live continuation 8/8, serially. P2 and P7 remain PARTIAL.
Shared PostgreSQL :5433 / Redis :6380 is RELEASED but all DB-backed suites
must still run exclusively and serially. Activation requested in the 11:15
Orchestrator cycle; Claude Code and Antigravity were observed idle in their
existing terminals before dispatch. Claude may take the first exclusive DB
window for W27-C; Antigravity starts offline W27-A prep and waits for Claude's
explicit RELEASED handoff before any live test.

OpenClaude is still implementing P6-01 in `services/orchestrator/src/app/**`.
Command Code is still implementing root/legacy Workflow Builder in
`D:/Git/dugate/lib/workflow-builder/**` and its root API/tests. Neither lane is
part of Wave 27. Preserve the shared dirty worktree: no reset/clean, broad
staging, commits, push, secrets, or editing another lane's files.

Historical coordinator checkpoint at 10:30 cycle: W26-C and W26-A were independently
accepted (45/45 Orchestrator and 8/8 example-review live PASS); no new task
was sent to the two in-progress coding agents. W26-CC has a new cross-block
regression test but its root Jest run is blocked by a broken/missing local
root dependency installation; `package-lock.json` was modified during an
install attempt and must be reviewed by its owner before closeout. W26-O has
not yet published view-model files or a final report, and its terminal is at
an approval prompt whose full action is not visible in the transcript. These
are **pending W26 verification**, not Wave 27 completion evidence. Before
any four-lane status rollup, require each coding agent's report, focused
tests/typecheck, and an exact file-scope diff review; do not promote P6-01 or
legacy Workflow Builder Fix 2/3 from partial terminal activity.

11:15 Orchestrator update: OpenClaude's directory-creation approval was
resolved and W26-O is actively coding; Command Code resolved its package
manager conflict and resumed W26-CC verification. Both remain separate,
in-progress lanes. The 10:30 dependency observation above is historical;
neither coding task is accepted here.

## W27-C — Claude Code: cancellation persistence consistency (platform)

Own `services/orchestrator/src/modules/lifecycle/**`, the relevant runtime
service/route and dedicated Orchestrator tests; own
`coordination/reports/claude.md`. No P6 app files, no example-review or root
Workflow Builder files. Coordinate a DB window before any live test.

1. Trace operation cancellation and deadline termination while a task is
   `WAITING_INPUT`. Today the operation/task become terminal but
   `human_waits.status` stays `OPEN`; resume correctly rejects with 409. Make
   wait-row closure transactional with terminal transition and define a clear
   terminal wait state, including races with first resume and duplicate resume.
   Preserve fail-closed auth/CAS and idempotent replay behavior; do not alter
   the successful P7-05 flow. Add migration only if the existing wait status
   constraint requires it, through the explicit one-shot migration path.
2. Add focused regression tests: cancel vs resume race; deadline vs resume;
   repeated cancel; unknown/cross-tenant wait; no duplicate dispatch. Use
   real test DB for transaction assertions and do not globally TRUNCATE.
3. Audit the W26 migration CLI JSDoc: it claims non-test empty DB is rejected,
   but the current CLI has no such guard. Correct the documentation to the
   intended explicit production migration contract, or implement an actually
   necessary guard without preventing a valid production first deployment.
   Keep P2-01 `[x]` unless a substantive migration regression is found.
4. Run Orchestrator typecheck, migration 9-case suite and runtime 36-case
   baseline plus new cases. Update report with exact counts and DB release.

Acceptance: terminal operations do not leave an actionable OPEN human wait;
resume/cancel races are deterministically fenced; migration contract is honest;
P2-06 remains `[ ]` until all composite RUN-05..07 acceptance is proven.

## W27-A — Antigravity: P7-06 version coexistence proof (business)

Own `businesses/example-review/**`, its checklist, `tasks/P7-extension-proof.md`
and `coordination/reports/antigravity.md`. Do not edit platform, OpenClaude or
Command Code files. Prepare fixtures offline while Claude uses the DB; execute
the live suite only after an explicit DB release.

1. Build two distinguishable example-review worker/manifest versions and a
   suite-scoped profile routing fixture. Prove v1 and v2 are registered and
   active concurrently; submissions before/after profile revision switch use
   their intended version, and result markers reveal which worker executed.
2. Keep a v1 operation in `WAITING_INPUT`, change the profile to v2, then
   resume v1 and prove it finishes on the pinned v1 worker. Test drain and
   rollback of new submissions without breaking the waiting v1 operation.
   Check connector/profile revision pins where relevant. No mock continuation
   route and no direct platform DB mutation to fabricate a passing routing
   result.
3. If generic routing/drain APIs cannot express the scenario, report the
   smallest API-level repro to Claude instead of patching platform here. Keep
   P7-06 `[ ]` and P7 phase PARTIAL until all VER-01 claims are live-proven.
   P7-03 image/ACL and P7-04 browser Admin UI still have separate gates.
4. Run focused unit/typecheck, then exclusive live suite. Record exact
   counts and release the DB window. Clarify that W26's restart proof was a
   controlled stop with fixture-forced lease expiry, not a SIGKILL test.

Acceptance: observable v1/v2 coexistence, in-flight v1 human continuation,
drain and rollback evidence, or a precise platform blocker; no checkbox
promotion on partial evidence.

## Sequencing

Claude gets the exclusive DB window first for cancellation/migration tests;
Antigravity prepares offline meanwhile. Claude reports RELEASED before
Antigravity runs live P7. If Claude changes cancellation status, Antigravity
updates the existing P7 cancellation assertion to the new authoritative
contract before its live run. Coordinator reviews both reports and task
checkboxes before any further phase promotion.
