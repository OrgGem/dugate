# DU Rework implementation status — 2026-09-23

> **Latest progress snapshot 2026-09-23, 18:12 +07:** [Agent reconciliation](PROGRESS-RECONCILIATION-2026-09-23-EVENING.md): **46 done / 5 partial / 20 open in P0-P8**, plus 5 deferred P9 tasks. CR-11 now has agent-reported 8/8 regression PASS; P6-02 and P8-04 have new suite evidence. SDK lane was restored but currently reports a usage limit. MM-13 has concurrent PASS evidence but residual isolation gaps, so full closure is disputed. NOT RELEASE READY. Older summaries below are historical; no implementation or dispatch performed.

> **Latest full-flow acceptance review (2026-09-23, 12:04 +07):** [Plan/code conformance](PLAN-CODE-CONFORMANCE-2026-09-23.md) adds 13 mismatches and [MM fix tasks](../tasks/PLAN-MISMATCH-FIXES-2026-09-23.md). Production Connector identity, public artifact/HITL flow, profile resolution, queue recovery and provider convergence are incomplete. P7-03/04/07 and P8-02/03 slice passes do not close full acceptance. Admin shell/corpus progress and CR-11 source fix are acknowledged. Release remains NOT READY; concurrent ownership is preserved.

> **Code review 2026-09-23, 09:22 snapshot:** [13 code findings](CODE-REVIEW-2026-09-23.md) and [fix backlog](../tasks/REVIEW-FIXES-2026-09-23.md) are added. Key gaps: binary blob wire mismatch hidden by a test shim, webhook destination/lifetime controls, idempotency, lease fencing and SDK pending/abort behavior. Existing slice PASS results do not close these gaps. No product-source edits or DB-window use by this review; held SDK ownership is respected.

> **Acceptance correction — 2026-09-23, 08:31 snapshot:** [Plan review](PLAN-REVIEW-2026-09-23.md) supersedes the older summaries below. P6-02..06 and P8-01/07/08 are PARTIAL, not full-task DONE; G6 is NOT PASSED. P2-07, P4-04 and P7-06 have newer completion evidence than the lower historical phase matrix records. P0-05 corpus is delivered with a regression-consumer follow-up. Wave 39 remains the running allocation. **The opening Wave 39 global-TRUNCATE diagnosis below is retracted** (cycles 11–13); use the latest controlled-experiment evidence, not that old causal claim. No active assignment is cancelled by this acceptance review.

> **Wave 39 orchestrator takeover (2026-09-23, 02:25):** Qwen Code now dispatches and reviews on a
> 15-minute cycle against [Wave 39](WAVE-39-ORCHESTRATOR-REALLOCATION.md). Three Wave 38 defects
> were corrected. (1) The exclusive DB window was **not** serial: three `tests/runtime.test.ts`
> jest runs (PIDs 17276, 13524, 8744) plus a leaked `tsx` probe were alive simultaneously from
> 01:49–01:58 with frozen CPU, zero `pg_stat_activity` rows on `du_orchestrator_test`, and 6 idle
> Redis `ioredis` clients holding them open — the Wave 13 cross-run `TRUNCATE` interference again.
> All four were terminated at 02:19; the window is verified free, and W38-A6's missing verification
> was infrastructure, not agent error. (2) W38-O re-dispatched **P6-05, which is already delivered**
> (`api-key-view-models.ts` 01:45, `admin-api-key-view-model.test.ts` 01:39, `P6-admin.md` `[x]`,
> OpenClaude's W37-O report 01:41); the Wave 38 closeout snapshot predated the writes. W38-O is
> cancelled and OpenClaude moved to **P6-04** view models. (3) Wave 38 addressed OpenClaude's dead
> handle `term_9c7399c9` and left no dispatch receipt; Wave 39 records request IDs and terminal
> evidence. Live now: Agent-6 alone on the DB window (P2-09 closeout), Claude Code narrowed to
> `getUsageSummary` + connector test proxy with DB runs queued behind Agent-6, Command Code on
> P4-04 then P4-05, OpenClaude on P6-04, Codex on P0-01 then P0-03.

> **Wave 31 offline allocation (2026-09-22, 18:30):** W29-O remains accepted
> at pure profile-draft scope (66/66). W30-CC's 71/71 helper/route baseline
> remains green, but its requested rejected-fetch/network-error evidence is
> not in the 21 new tests; full closeout remains IN REVIEW, not browser/E2E.
> [W31-O / W31-CC](WAVE-31-O-CC-OFFLINE.md) allocate independent offline
> follow-ups to OpenClaude and Command Code. Claude Code continues W30-C in
> the shared DB lane; Antigravity W30-A reports OFFLINE_READY and awaits an
> explicit DB/Redis RELEASED handoff before live P7-06 verification.

> **W29-O / W30-CC coordinator review (2026-09-22):** W29-O is **ACCEPTED at
> pure Admin profile-draft scope**: manifest-driven validation and display-safe
> revision diff, including secret masking. Coordinator reran `admin-view-model`
> **66/66 PASS** and whole Orchestrator `tsc --noEmit` with 0 errors. R08-07's
> architecture decision has since been recorded as ADR-14; OpenClaude's older
> report line listing that decision as pending is historical. P6-01/P6-03 stay
> `[ ]` because rendered UI, browser/a11y, API wiring, and server enforcement
> are not proven. W30-CC's typed Run-schema helper is integrated into the
> page, and coordinator reran the full Workflow Builder **11 suites / 71 tests
> PASS**. It is **ACCEPTED for multipart/required-field/response-parsing
> helper contracts**, but full W30-CC packet closeout stays **IN REVIEW**:
> the requested network-error path remains a `fetch` catch in `page.tsx` with
> no new test, and React/browser interaction or live E2E is not proven. Root
> full-project typecheck is not claimed; agent reports no scoped diagnostics.
> Claude Code continues W30-C; Antigravity W30-A is offline pending the DB
> window handoff.

> **Wave 30 Antigravity reactivation (2026-09-22):** User lifted the temporary
> HOLD. [W30-A](WAVE-30-IDLE-LANES.md) assigns P7-06 positive live
> coexistence/drain/rollback acceptance against the W28-C active-version API.
> Antigravity starts offline; Claude Code already owns W30-C and may need the
> shared DB. P7-06 remains `[ ]` until live evidence is complete and the
> exclusive PostgreSQL/Redis window is returned to RELEASED. Earlier HOLD
> statements below are historical checkpoints, not current dispatch policy.

> **W29-C coordinator acceptance (2026-09-22, 17:09 review):** ADR-14 makes
> the rework's node:http/raw-pg boundary and deferred Admin UI/object storage/
> session-RBAC target explicit. Source review confirms the Admin enable route
> now returns 404 NOT_FOUND when no version row is updated; seven negative
> authorization/regression tests are present. Coordinator independently reran
> Orchestrator migration + runtime suites **63/63 PASS** and the current whole
> Orchestrator `tsc --noEmit` with **0 errors**. The earlier OpenClaude
> view-model diagnostic recorded in Claude's report is no longer present at
> this checkpoint. DB window is RELEASED. W29-C is COMPLETE at its bounded
> architecture/auth slice; P2-02 and P7-06 remain `[ ]`. Wave 30 candidate
> packets are in [Wave 30](WAVE-30-IDLE-LANES.md). OpenClaude continues W29-O;
> Antigravity stays on user-directed HOLD.

> **W30-C delivered (2026-09-22):** Claude Code recorded the P2-09 expired-lease
> recovery slice (`services/orchestrator`). Audit: no orchestrator-side
> recovery existed (only inbound/queue-side re-claim and BullMQ stalled
> detection, both requiring another delivery/live worker). Implemented
> `runtime.sweepExpiredLeases()` (one tx, `FOR UPDATE SKIP LOCKED`, epoch-bumped
> fence per recovery, budget-aware requeue vs terminal fail, `ON CONFLICT`
> idempotent outbox row), made `heartbeatTask` an atomic epoch-conditional
> UPDATE, and wired a production interval hook (`leaseRecoveryIntervalMs`,
> default 5000ms, started in `listen()`/cleared in `close()`). 9 real-DB tests:
> expired RUNNING recovery + old-epoch fencing, unexpired/idle/WAITING_INPUT/
> WAITING_CHILDREN/terminal exclusions, budget exhaustion → terminal FAIL,
> repeated + production-hook (50ms background timer) idempotency. Serial rerun
> **138/138 PASS** (63 runtime + 9 migration + 66 admin-view-model), typecheck
> 0 errors, DB window RELEASED. P2-09 complete as a slice; full background
> lifecycle/health/shutdown gate remains open (not claimed).

> **W32-C delivered (2026-09-22):** [CC] recorded the P2-08 webhook delivery
> slice (`services/orchestrator`, packet `WAVE-32-DIRECT-ALLOCATION.md`).
> Migration `0007_webhook_deliveries.sql` adds `operations.callback_url`
> (pinned at submit) + `webhook_deliveries` (unique
> `(operation_id, state_version, destination_url)` dedup = docs 04
> WebhookDelivery scope; pending `next_at` index). New
> `src/modules/webhooks/webhooks.ts`: `maybeScheduleWebhook` reads the op
> inside the terminal tx and inserts one signed `WebhookPayload` row only when
> terminal + callback set (`ON CONFLICT DO NOTHING` → replayed terminal
> transitions schedule nothing extra), wired at every terminal write
> (completeTask→SUCCEEDED, failTask/join-failure/lease-expiry→FAILED,
> cancelOperation→CANCELLED, sweepDeadlines→TIMED_OUT).
> `deliverWebhooks` claims due rows `FOR UPDATE SKIP LOCKED`, POSTs
> HMAC-SHA256 `x-du-signature` over `{timestamp}.{body}` (+ `x-du-timestamp`,
> `x-du-delivery-id`), tracks `attempts/next_at` with exponential backoff, and
> terminal-FAILs an exhausted row without ever changing the operation outcome.
> `server.ts` adds fail-closed `webhookSecret` + `webhookDispatchIntervalMs`
> background timer. 9 real-DB tests: scheduling on all four terminal states,
> no-callback/no-row, cancel-replay dedup, sign/verify round-trip + tamper,
> dispatcher success/retry-exhaustion/idempotency. Serial rerun **runtime
> 72/72 PASS (+9), migrations 9/9 PASS**, typecheck 0 errors, DB window
> RELEASED. P2-08 complete as a webhook slice only; poll/result facade, sync
> wait, and audit (OPS-04..06 composite) remain open (not claimed).

> **W36-C delivered (2026-09-22):** [CC] recorded the P2-08 operations status &
> result facade (`services/orchestrator`, packet `WAVE-36-DIRECT-ALLOCATION.md
> §W36-C`). New `src/modules/operations/facade.ts`: `toOperationView` (canonical
> view with AIP-style `name: 'operations/' + id` plus business/stateVersion/
> progress/links), `isTerminal`, `resultHttpStatus` (SUCCEEDED→200,
> TIMED_OUT→410, else 409), `waitForTerminal` (sync long-poll, 500 ms poll,
> max 30 s, never cancels the operation). `server.ts` GET `/operations/:id`
> now honors `?wait=<seconds>` (clamped [0,30]) by holding the response open
> until terminal or timeout; GET `/operations/:id/result` returns 410 for
> TIMED_OUT per docs 06. Inline `toOperationView` removed from server.ts
> (imported from facade). 14 real-DB tests (+unit): view shape, 404s, result
> status for SUCCEEDED/PENDING/CANCELLED/TIMED_OUT, long-poll completion
> (concurrent dispatch+complete) and wait timeout. Serial rerun **runtime
> 86/86 PASS (+14), migrations 9/9 PASS**, typecheck 0 errors, DB window
> RELEASED. Combined with W32-C, **P2-08 is fully closed** for OPS-04..06;
> audit-log visibility is a P6 admin concern tracked separately.

> **W37-C delivered (2026-09-22):** [CC] recorded the P2-06 composite
> acceptance (`services/orchestrator`, packet
> `WAVE-37-DIRECT-ALLOCATION.md §W37-C`). 7 new real-DB integration tests in
> `tests/runtime.test.ts` binding W30-C expired-lease sweep + W24-C typed
> continuation + W27-C cancel/deadline closure into composite RUN-05..07
> scenarios. RUN-05: full fan-out→join→continuation→SUCCEEDED (incl.
> `Promise.all` concurrent completions, concurrency=1 no deadlock, and
> child-failure→JOIN_FAILED + sibling CANCELLED). RUN-06: human wait lifecycle
> OPEN→ANSWERED→SUCCEEDED (stale-CAS 409, duplicate resume 200 replay,
> unknown wait 404, terminal-op resume 409). RUN-07: admin deadline sweep
> EXPIRED/TIMED_OUT (result 410 GONE, late resume 409); admin cancel
> CANCELLED (cancel-then-resume 409, cancel replay 200). **P2-06 is fully
> closed** for RUN-05..07. Runtime suite **93/93 PASS (+7)**, full
> orchestrator **358/358 PASS**, typecheck 0 errors. DB window RELEASED.
> `tasks/P2-orchestrator.md`: P2-06 → `[x]`.

> **W29-C accepted (2026-09-22):** Claude Code recorded R08-07 ADR-14
> (`docs/15-decisions.md`): raw `node:http`/raw-pg platform accepted for rework;
> rendered Admin UI, production object storage (ADR-10 S3 target), framework
> adoption, and session/RBAC/CSRF admin auth are deferred. Platform lane owns
> all server-side authorization. Fixed a confirmed Admin route defect: `enable`
> returned `200 ENABLED` for an un-registered version (UPDATE affected 0 rows,
> no rowCount check) — now 404 NOT_FOUND, consistent with activate/deactivate.
> Added 7 negative authorization tests (unauthenticated `enable`/`deactivate`/
> `profile-bindings`, runtime-token role substitution, enable-non-existent→404,
> cross-tenant cancel/resume→404). Combined serial rerun: **9/9 migration +
> 54/54 runtime = 63/63 PASS**; platform-owned typecheck clean (excluding
> OpenClaude `src/app/**`, which has a pre-existing W26-O view-models type
> error). DB window RELEASED. P2-02 remains `[ ]` (RBAC user matrix, admin CRUD,
> connector proxy deferred). P7-06 `[ ]`.

> **Wave 29 checkpoint (2026-09-22, 16:30 review):** W29-O was dispatched to
> OpenClaude, which is working; Claude Code continues W29-C; Antigravity stays
> on user-directed HOLD. **W29-CC ACCEPTED at unit persistence-seam scope:**
> Command Code's regression exercises real pause/restore functions with mocked
> DB and queue boundaries, including legacy array hydration and cross-block
> binding after a fresh context. Coordinator reran **10 suites / 50 tests PASS**.
> Review correction verified: `run-schema.ts` human-pause write now uses typed
> `ctx._nodeResults` (`Record<string, unknown>`), so all three owned
> `_nodeResults` `as any` casts are gone. The unrelated `sendWebhook('PAUSED'
> as any)` cast remains outside this lane. This is **not** live DB/worker-restart
> E2E; no full-project typecheck is claimed.

> **Wave 29 coordination (2026-09-22):** W28-C platform hardening is accepted:
> migration 0006, explicit active-version routing, fail-closed drain, ordered
> activation locking, and regression coverage; coordinator's serial rerun was
> 9/9 migration + 47/47 runtime = **56/56 PASS**. DB/Redis RELEASED. This does
> not close P7-06: the updated API still needs business-level live acceptance.
> W26-O headless Admin view models are accepted as a bounded P6-01 slice;
> coordinator reran **51/51** focused tests and `tsc --noEmit` with 0 errors.
> P6-01 remains `[ ]` because rendered navigation/auth shell, route wiring,
> browser/a11y proof, and R08-07 UI/server boundary remain open. See
> [Wave 29](WAVE-29-PLATFORM-ADMIN-WORKFLOW.md) for separated next lanes.
> Antigravity remains on user-directed HOLD and receives no new task.

> **W28-C coordinator review (2026-09-22, updated):** Platform migration `0006`,
> active-version registry operations, and Admin activate/deactivate routes
> are implemented. Coordinator reran Orchestrator migration + runtime tests
> serially: **56/56 PASS**; Claude reports typecheck clean and DB/Redis
> RELEASED. **Drain acceptance: RESOLVED.** All three review items addressed:
> (1) drain is fail-closed — deactivating the sole active version blocks new
> submissions with 404; the old "newest ENABLED" fallback has been removed;
> (2) `activateVersion` uses `SELECT ... ORDER BY version FOR UPDATE` to lock
> all business_versions rows in deterministic order, preventing concurrent
> activate deadlocks; (3) a focused concurrent activate test proves no deadlock
> and the partial unique index is never violated. W28-C is COMPLETE. P7-06
> remains `[ ]` (business-level v1/v2 live acceptance is a separate gate).
> OpenClaude W26-O remains in progress;
> Antigravity remains on user-directed HOLD. No follow-up task was dispatched
> by this review.

> **W28-CC accepted (2026-09-22):** Command Code completed the bounded
> root/legacy Workflow Builder closeout. Coordinator independently reran
> `pnpm test tests/workflow-builder --runInBand --silent`: **9 suites / 47
> tests PASS**. New W26-CC test casts were replaced with typed fixtures and
> a `NextRequest` boundary helper; remaining `any` occurrences in the older
> `run-schema.test.ts` helpers predate this lane and were not expanded.
> Agent reports no Workflow Builder-scoped TypeScript diagnostics; full root
> typecheck/lint are not claimed green. The root `package-lock.json` still has
> 26 additions / 25 deletions from an earlier npm-style install; W28-CC
> documented provenance but deliberately did not revert uncertain user/agent
> changes. Fix 2/3 are accepted **at mocked/unit route scope only**, not live
> DB/queue E2E, and this does not promote any `du-rework` phase checkbox.
> Claude Code W28-C remains active, OpenClaude W26-O remains active, and
> Antigravity remains on user-directed HOLD despite W27-A's 10/10 live report.
> Older W28/W27 entries below are historical snapshots where they still say
> W26-CC closeout is pending.

> **Wave 28 idle-lane handoff (2026-09-22):** Antigravity W27-A reports
> 10/10 live and 90/90 unit PASS, with DB/Redis explicitly RELEASED. This
> verifies v1/v2 coexistence and pinned v1 continuation, but its live Case 10
> reproduces missing durable drain/rollback: P7-06 remains `[ ]` and phase P7
> remains PARTIAL. User has temporarily withheld new Antigravity assignments.
> [Wave 28](WAVE-28-IDLE-LANES.md) routes the platform version-control gap
> to idle Claude Code and W26-CC strict/lockfile closeout to idle Command
> Code. OpenClaude continues W26-O; no new task is assigned to it.
> Antigravity's 10/10 is agent-reported, not independently rerun here.

> **Current allocation hold (2026-09-22):** Per user direction, no new task
> goes to Antigravity. W27-A's terminal shows a live rerun and qualitative
> success, but the agent reached quota before final report/case-count and
> DB-release handoff. P7-06 stays `[ ]`; do not treat the old
> `WAVE_27_A_OFFLINE_READY` report or terminal prompt as completion. Shared
> DB/Redis availability is **UNVERIFIED** until explicit release or positive
> cleanup check. Claude Code W27-C is complete; Command Code W26-CC has
> mocked/unit behavioral proof but strict-type/lockfile closeout remains;
> OpenClaude W26-O is still in progress. Reallocation and stop conditions are
> in [Wave 27 coordinator reallocation](WAVE-27-P2-P7-CLOSEOUT-PACKET.md).

> **Coordinator audit at Wave 27 handoff (2026-09-22):** W27-C platform
> cancellation/deadline wait-closure slice is accepted from source review and
> Claude's serial 49/49 DB-backed report; coordinator independently reran
> Orchestrator typecheck (0 errors), but did not rerun DB tests while
> Antigravity owns the live W27-A window. P2-06 was closed by W37-C composite
> acceptance (2026-09-22); phase P2 remains PARTIAL.
> W26-CC root/legacy Workflow Builder behavior is independently rerun:
> 9 suites / 47 tests PASS. Fix 2 and the existing public-slug Fix 3 route
> have focused regression proof, not live DB/queue E2E. Packet closeout is
> still pending: new tests contain `any` casts despite strict-typing scope,
> and root `package-lock.json` remains modified (26 additions/25 deletions)
> after the earlier install, despite the agent report's no-lockfile-change
> claim. These root findings do not change `du-rework` P0/P5/P7 checkboxes.
> OpenClaude W26-O remains in progress. Antigravity W27-A is running live;
> shared DB/Redis window is **owned by Antigravity**, not RELEASED for new runs.
> Historical Wave 26 statements below are snapshots and are superseded where
> they describe the old cancellation gap.

> **Wave 27-C evidence (2026-09-22).**
> Cancellation/deadline consistency fix: terminal operations no longer leave
> actionable OPEN human waits. `cancelOperation` closes OPEN waits to
> CANCELLED; `sweepDeadlines` (now transactional) closes them to EXPIRED.
> Resume on terminal waits correctly fails closed (409 STATE_CONFLICT).
> Race fencing: operations FOR UPDATE serializes cancel vs resume.
> Migration CLI JSDoc corrected (no false empty-DB guard claimed). No new
> migration needed (0005 supports terminal wait states).
> **49/49 PASS** serial (9 migration + 40 runtime including 4 new W27-C
> cases). Typecheck 0 errors. P2-06 composite RUN-05..07 acceptance was
> subsequently proven by W37-C (2026-09-22). DB window RELEASED.

> **Wave 24 evidence (dated 2026-09-22).**
> **Independently rerun by coordinator:** example-review unit 87/87 PASS (9
> suites); typechecks for Orchestrator (`tsc --noEmit`), document-core
> (`tsc --noEmit -p tsconfig.test.json`), example-review
> (`tsc --noEmit -p tsconfig.test.json`) — all 0 errors.
> **Agent-reported, not independently rerun** (shared-DB was exclusive to
> each lane): Orchestrator runtime 36/36 PASS (`tests/runtime.test.ts`
> including 9 continuation tests — 27 pre-existing + 9 new);
> document-core E2E 13/13 PASS (`multi-container-e2e.integration.test.ts`);
> BullMQ smoke 1/1 PASS; example-review continuation 6/6 PASS
> (`example-review-continuation.integration.test.ts`).
> W23/W22 findings about stubbed Connector and hash shims are historical:
> the current E2E uses `createConnectorComposition` with real ledger,
> outbox, `ContractSignedGrantVerifier` and canonical invocation hashing.
> Mock providers still bound the external HTTP boundary (P8 scope).
> **53 suites / 648 tests is inventory, not a single fresh full PASS.**
> W23 "routes missing" and "Connector stub" findings are stale.
>
> **Wave 26-C evidence (2026-09-22):** Tracked migration path (R08-06 /
> P2-01) implemented. Migration 9/9 PASS (incl. scratch-DB boot boundary);
> runtime 36/36 PASS (no regression); typecheck 0 errors. `autoMigrate`
> option separates boot (fail-closed verify) from explicit `npm run migrate`.
> P5-10 accepted COMPLETE by W25-A audit reconciliation (28 fixture variants
> + 6-action live E2E). P7-01/02 accepted COMPLETE; P7-03/04/05 PARTIAL;
> P7-06/07 DEFERRED/open.

> **Wave 26 coordinator acceptance (2026-09-22):** Serial independent rerun:
> Orchestrator migration + runtime 45/45 PASS (9 + 36); example-review live
> continuation 8/8 PASS. P2-01 and P7-05 are `[x]` for their literal task
> acceptance; P2 and P7 phases remain PARTIAL. P7-05 restart case uses a
> controlled worker stop plus fixture-forced lease expiry, not a SIGKILL crash
> proof. Cancellation still leaves `human_waits.status = OPEN` although resume
> fails closed with 409. Shared-DB window returned to RELEASED.

> Latest audit: [Wave 24 live integration](WAVE-24-P5-P7-LIVE-INTEGRATION.md),
> 2026-09-22. Source audit confirms all four continuation routes and startup
> wiring for `0005_continuation.sql` exist; Orchestrator `tsc --noEmit` PASS.
> 36/36 runtime result is agent-reported, not independently rerun (shared-DB
> serial policy). P5 E2E 13/13, smoke 1/1, P7 continuation 6/6 are
> agent-reported by Antigravity; coordinator independently reran example-review
> unit 87/87 and three typechecks. Exclusive window released.
> W23 "routes missing" is stale; W23 "Connector stub" is stale (current E2E
> uses real composition). P7 checklist partial verdicts stand per Antigravity
> W25-A: P7-01/02 COMPLETE; P7-03/04/05 PARTIAL; P7-06/07 DEFERRED.
> P8 non-phase-level gaps remain (image packaging, security audit, load).
> Shared-DB gate released; no further platform tests needed in this window.

> Latest audit: [Wave 21](WAVE-21-INTEGRATION-CONTRACT-CHECK.md). Independently reran 506 tests / 40 non-infra suites PASS.
> W20 manifest mapping accepted; newly authored E2E has repository signature/error-envelope mismatches
> and unbounded barrier/failure cleanup gaps. W21-A fixes/tests these before live acceptance.
> 518 is mixed historical evidence; current authored inventory adds two tests, neither total freshly verified.

> Historical audit: [Wave 20](WAVE-20-PROFILE-FIXTURE-INTEGRATION.md). Independently reran 503 tests / 40 non-infra suites PASS;
> document-core/example-review typechecks PASS. W19 child safety accepted. Profile helper defaults to
> undeclared llm slot and is not yet wired into E2E; W20-A corrects manifest mapping and integration.
> 515 combines historical infra in three packages, not whole-workspace fresh verification. P5 PARTIAL/P7 blocked.

> Historical audit: [Wave 19](WAVE-19-PROFILE-P7-PREFLIGHT.md). Independently reran 452 non-infra tests / 39 suites PASS;
> W18 parser completion fencing accepted; specified fixtures have no any. Document-core typecheck PASS.
> Profile-bindings route exists; continuation server routes not found at audit time despite status report.
> W19-A prepares profile-aware integration and strict P7 child input validation; live tests contract-gated.

> Historical audit: [Wave 18](WAVE-18-PARSER-FENCING.md). Independently reran 447 non-infra tests / 39 suites PASS
> and all three owned typechecks. W17 build closure and parser option/deadline propagation accepted.
> Late parser-success fencing and typed regression fixtures remain W18-A; 12 infra tests are historical.
> Claude remains on platform grants/continuation; P5 PARTIAL and P7 contract-gated.

> Historical audit: [Wave 17](WAVE-17-PARSER-BUDGETS.md). Independently reran 400 non-infra tests / 38 suites PASS.
> W16 lifecycle/guard/SDK consumer slices accepted; 12 infra tests are historical, not a fresh 412-test run.
> Dependency build still omits observability. W17-A fixes graph closure and propagates parser budgets
> across six actions independently of Claude's in-flight platform work. P5 PARTIAL; P7 contract-gated.

> Historical audit: [Wave 16](WAVE-16-ACCEPTANCE-GAPS.md). Independently reran 374 tests / 36 suites PASS;
> agent reports 386 / 38 including 12 infra tests not rerun during active platform edits.
> W15 acceptance incomplete: child termination can falsely succeed, dependency build is incomplete,
> Redis/URL guard gaps remain, and P7 checklist names nonexistent SDK methods. Assigned W16-A.
> Claude continues W13-C; P5-10 PARTIAL and P7 continuation BLOCKED.

> Historical audit: [Wave 15](WAVE-15-REPRODUCIBLE-ACCEPTANCE.md). Independently reran all 350 tests / 36 suites PASS
> and document-core typecheck. Accepted in-flight pinning and real process crash + injected-redelivery replay.
> Autonomous lease recovery NOT proven (test inserts outbox); test target guard, build reproducibility,
> and failure-path child cleanup remain W15-A. P5-10 PARTIAL; P7 awaits platform continuation.

> Historical audit: [Wave 14](WAVE-14-ANTIGRAVITY-RELIABILITY.md). Independently reran 338 tests / 34 suites PASS;
> agent reports 349 / 36 including infra (11 infra tests not rerun during active Claude work).
> P5-10 remains PARTIAL: HTTP429 retry is not process-crash proof; version test lacks an in-flight
> barrier; fixture isolation/failure cleanup is incomplete. Claude continues W13-C; Antigravity W14-A.

> Historical audit: [Wave 13](WAVE-13-VERIFIED-NEXT.md). Runtime 23 PASS, bounded-input 26 PASS,
> unshimmed E2E 9 PASS independently. Earlier auth regression is resolved. Concurrent shared-DB
> execution failed (global runtime TRUNCATE); isolation is a new task, not a proven product regression.
> P5-10 is PARTIAL with unshimmed green evidence; profile pinning and typed continuation remain open.

> Latest: [Wave 12](WAVE-12-INTEGRATION-CLOSEOUT.md): runtime 20 PASS, document-kit 77 PASS;
> document-core integration 9 FAIL at admin enable setup (401). Earlier green E2E is historical.
> Stable grant identity and canonical SDK hash code now exist; expired-lease/profile binding
> acceptance remains open. Parser wait-contract fixes verified. P0 still needs factual corrections.

> Latest: [Wave 11 audit and next tasks](WAVE-11-REVIEW-NEXT.md). Independently reran
> 18 runtime + 9 business integration + 25 parser-boundary tests: 52 PASS.
> Core fail-closed API-key/admin-token fix is verified; grant identity/hash remains open.
> Semantic six-action and transient retry/reclaim coverage is verified but still hash-shimmed.
> Parser timeout is a wait timeout, not cancellation. P0 specs need accuracy corrections;
> production cutover is not a prerequisite for their documentation acceptance.
> Earlier snapshots below are historical where superseded by this audit.

> Latest focused audit: [Wave 10 review and follow-up](WAVE-10-REVIEW-FOLLOWUP.md).
> Verified 8 document-core integration tests and 19 document-kit boundary tests PASS.
> Six actions now run through the integration harness, but signed-hash replacement remains;
> current restart test only starts an idle second worker and reads completed state.
> P0 traceability also misstates UC-08. P0/P5/P7 remain PARTIAL; older counts below are historical.

Tài liệu này là index trạng thái ngắn cho coordinator. Nó không thay thế spec, gate hoặc test output và không nâng local/unit evidence thành cross-service hay production readiness.

> Review mới nhất: [STRUCTURE-CODE-REVIEW-2026-09-21](STRUCTURE-CODE-REVIEW-2026-09-21.md).
> P5-10 and P2-01 are now CLOSED: Connector runtime in E2E uses real composition (Wave 24);
> migration-on-boot completed via tracked migration runner (W26-C).
> Báo cáo này là historical audit entry.

## Quy tắc đọc trạng thái

- **DONE**: toàn bộ acceptance của task row có gate hoặc executable test phù hợp; task packet được tick `[x]`.
- **PARTIAL**: có source/test cho một phần acceptance nhưng còn dependency hoặc scenario chưa chứng minh; task packet giữ `[ ]`.
- **TODO**: chưa có implementation có thể kiểm chứng trong phạm vi acceptance.
- Thứ tự ưu tiên khi có mâu thuẫn: command vừa chạy → gate hiện hành → checkpoint → narrative cũ. Gate/report đang được integration owner sửa không được tài liệu này tự ý promote.

## Evidence có thể chạy lại

| Evidence | Command / artifact | Kết quả quan sát |
|---|---|---|
| Workspace contracts | [`gates/workspace-ready.md`](gates/workspace-ready.md), [`gates/contracts-v1.md`](gates/contracts-v1.md) | READY; workspace và wire v1 có test evidence |
| Worker SDK | [`gates/sdk-ready.md`](gates/sdk-ready.md) | READY; 23 unit/consumer tests, không phải live cross-service E2E |
| Minimal Orchestrator runtime | [`gates/runtime-ready.md`](gates/runtime-ready.md) | READY cho slice được gate mô tả; các endpoint/gap ngoài slice vẫn mở |
| Cross-service document-core slice | [`gates/integration-e2e-ready.md`](gates/integration-e2e-ready.md) | PARTIAL: six-action live E2E 13/13 PASS (agent-reported, shared-DB) with real Connector composition (ledger, outbox, canonical hash) and mock providers; example-review continuation 8/8 independently rerun; BullMQ smoke 1/1 PASS (agent-reported); G4 not full (mock boundary, remaining P7/P8 gaps) |
| Current workspace test | `cd du-rework && pnpm test` | Agent-reported inventory: 53 suites, 648 tests PASS (Wave 24 Antigravity report, 2026-09-22); Orchestrator 36/36 PASS (Claude report, 2026-09-22). Coordinator independently reran example-review unit 87/87 + three typechecks. Not a single fresh full PASS of the entire workspace. |
| Current workspace build | `cd du-rework && pnpm build` | PASS sau FIX-07 ngày 2026-09-21 cho mọi package khai báo script build |
| Current workspace lint | `cd du-rework && pnpm lint` | PASS ngày 2026-09-21 cho 10/11 workspace projects có script lint, gồm `tests/integration` |
| Connector durable integration | Command opt-in trong [`CHECKPOINT-2026-09-21.md`](CHECKPOINT-2026-09-21.md#6-kiểm-chứng-độc-lập-tại-thời-điểm-bàn-giao) | Checkpoint: 2 suites/3 tests pass với PostgreSQL, Redis và mock provider; không phải Orchestrator↔Connector E2E |

Số 455 phản ánh working tree tại lần review structure/code sau FIX-07. Chi tiết số liệu từng package nằm trong review mới nhất; test pass không chứng minh các nhánh chưa có test hoặc container/production readiness.

## Phase/task evidence matrix

| Phase | Status | Task DONE có bằng chứng | Task còn PARTIAL/TODO và gap chính |
|---|---|---|---|
| P0 | PARTIAL | P0-02, P0-04 — `@du/document-core` `manifest.test.ts` + `traceability.test.ts`, cùng sáu BRD và variant matrix | P0-01/03/05/06: traceability toàn BR-01..12, legacy characterization, corpus policy và workload/SLO metadata chưa đóng |
| P1 | PARTIAL | P1-01/P1-02/P1-04/P1-07 — gates `workspace-ready` và `contracts-v1`; `pnpm build`, contracts 70 tests | P1-03: chưa có OpenAPI validation; P1-05: chưa có object-storage harness; P1-06: chưa chứng minh parent yield concurrency=1 trên runtime thật |
| P2 | PARTIAL | P2-01 — migration path DONE (tracked runner + CLI + `autoMigrate`); P2-04/P2-05 có slice evidence từ runtime-ready; chưa phải full G2. W27-C: source-reviewed transactional wait closure on cancel/deadline. W30-C: **P2-09 expired-lease recovery slice DONE** (`sweepExpiredLeases` + epoch-fenced heartbeat + production interval hook); 138/138 orchestrator PASS, typecheck clean, DB RELEASED. W32-C+W36-C: **P2-08 DONE** (webhook delivery + operations status & result facade + sync wait); 86/86 runtime + 9/9 migration PASS. W37-C: **P2-06 DONE** (composite RUN-05..07: fan-out join, human wait, deadline/cancel); 93/93 runtime + 358/358 full PASS, DB RELEASED. | P2-02/03/07/10 còn mở. Broader artifact, bootstrap, reconciliation and G2 evidence remains open; historical R08 issue descriptions require current-scope interpretation |
| P3 | DONE | P3-01..P3-08 — durable suites, real-service client, settled usage delivery và Connector image digest trong report Copilot | Không còn task row mở; webhook delivery thuộc Orchestrator/P2, không phải gap của P3 |
| P4 | PARTIAL | P4-01/P4-02/P4-03 — gate `sdk-ready`; P4-06 — `@du/document-kit` 46 tests | Artifact và grant facades đã chạy trong cross-service slice, nhưng P4-04/05/07/08 còn thiếu full fan-out/HITL, streaming/hash/temp cleanup, pending-yield/session và complete SDK consumer matrix |
| P5 | PARTIAL | P5-10 COMPLETE (W25-A accepted: 28 fixture variants + six-action live E2E 13/13 with real composition); P5-01..09: local action/manifest matrix; six-action live E2E 13/13 PASS (agent-reported) with real Connector composition/ledger/outbox, canonical invocation hash; smoke 1/1 | 28-variant matrix is local/typed-fixture, not six-action-live; mock providers bind only the external HTTP boundary (P8). P2-01 (migration path) is separate, owned on platform side (now DONE via W26-C) |
| P6 | TODO | Không có | Admin UI và browser/accessibility evidence chưa triển khai |
| P7 | PARTIAL | P7-01/02 COMPLETE (agent-reported + independently rerun): shared-package-only, worker with typed checkpoints; 87/87 unit PASS. P7-05 COMPLETE: continuation live suite 8/8 independently rerun, including concurrency=1 progress, controlled worker restart while waiting, duplicate resume 200 replay with one dispatch. P7-03 live registration and P7-04 generic submit/poll have partial live evidence. | P7-03: frozen image digests + standalone Compose unexecuted (P8/G5). P7-04: Admin profile UI-01 (browser, P6) untested. W27-C now closes OPEN human waits on cancel/deadline at platform level; Antigravity's live P7 assertion/update is in progress. Forced process crash is not proven by the controlled-restart case. P7-06: v1/v2 coexistence/drain/rollback live verification in progress. P7-07: developer guide + immutable digest undelivered. |
| P8 | PARTIAL | An isolated cross-service slice + Connector image/health proof exist (P3-08 COMPLETE) | phase-level traceability audit, full fault matrix, security suite, load/soak, document-core image, backup/restore, runbook, and release gate all remain unexecuted (P8 scope, not gated by Wave 24) |
| P9 | TODO / out of initial release | Không có | Giữ nguyên backlog; không suy ra từ source legacy |

## Gaps không được làm mờ

- Six-action live E2E uses **real Connector composition** (ledger, outbox, `ContractSignedGrantVerifier`, canonical invocation hashing) with **mock providers** binding the external HTTP boundary; mock is P8 scope, not a stub.
- Restart/idempotency/fault injection across the complete chain is partially tested: P7-05 proves controlled mid-wait worker restart, duplicate resume 200 replay and concurrency=1 progress; it does not prove a forced mid-wait process crash or arbitrary concurrent submissions. P7-T4 crash recovery and cooperative 429 retry are separate evidence.
- Artifact store is scoped implementation; ART-01..03 (hash/size/tenant enforcement, orphan TTL, bounded streaming/temp cleanup) not fully proven.
- Admin UI, full P7 profile/version rollover, immutable digests, developer guide, load/soak, security audit, document-core image, backup/restore, runbook, and production release gate remain unexecuted.
- Shared-DB suites remain serial-only (interim policy); parallel compatibility NOT certified.
