# Wave 14 - Antigravity reliability closeout (2026-09-21)

## Review and roadmap correction

Claude remains active on W13-C in term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd.
Do not restart, duplicate or take over its platform work. Its report is still wave05 at review time.
Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 is idle after W13-A.

Coordinator independently ran 34 suites / 338 tests PASS:
- document-core: 20 suites / 219 tests, excluding integration.test.ts and bullmq-smoke.test.ts;
  includes 32 bounded-input tests and 28-variant in-process coverage.
- document-kit: 6 suites / 77 tests.
- example-review: 8 suites / 42 tests.
Agent reports full 36 suites / 349 tests PASS. Remaining 11 infrastructure tests were NOT rerun
by coordinator while Claude is active and shared DB isolation remains unresolved.

Accepted: strict comparison-side types/conflicts/ambiguity, diagnostic cleanup improvements,
business-version selection/persistence test, evidence matrix, existing transient retry coverage.
W13-A_COMPLETED describes delivered work, not full reliability acceptance:
1. Integration customFetch still returns HTTP 429 on final output (lines 120-144). This proves
   cooperative retry/checkpoint replay, NOT a killed process, lost lease, or crash recovery.
2. Version test (line 1162 onward) does not hold Op1 RUNNING before enabling v2. It may already
   finish. It checks result status, not claimed version fields in result artifacts.
3. Fixed default-connector cleanup deletes shared revisions; local dbClient is not protected by
   finally if setup fails. Final v2 DELETE still swallows errors. --runInBand is only per Jest
   invocation, not a cross-agent lock. Isolation/failure safety is incomplete.
4. G4 is not blocked ONLY by an immutable image: crash/in-flight pinning and fixture acceptance
   above remain open. Production image readiness stays P8; do not hide business gaps behind it.

P5-10 stays PARTIAL. P0 IN REVIEW. P7 baseline tests green, formal acceptance/continuation
still blocked on published platform contracts (and later generic UI/digest proof).

## W14-A tasks (ordered; existing Antigravity session)

Ownership: businesses/document-core/**, businesses/example-review/**, packages/document-kit/**,
coordination/reports/antigravity.md and coordination/requests/antigravity.md only.
No platform/SDK/contracts/root lockfile/central gate edits. Preserve all dirty edits; no reset,
clean, broad staging or git push. Do not alter the other running sessions.

1. Correct own report immediately: distinguish reported execution from coordinator verification,
   HTTP429 retry from crash, and version selection from deterministic in-flight pinning.
   Retain accepted work; do not rewrite all existing tests.
2. Harden business fixture: finally-close setup DB clients, track partially created resources,
   fail with aggregated cleanup errors after attempting every cleanup, remove swallowed v2
   cleanup failure. Use suite-owned resource IDs where published APIs support them. Never delete
   a shared fixed connector's revisions on arbitrary DATABASE_URL. Consume Claude's isolation
   hook when published; otherwise add a fail-closed dedicated-test-environment guard and document
   exact infra execution restriction. Do not invent a platform hook or assume runInBand locks
   other agents. Run infra tests only with proven isolation or coordinated exclusive ownership.
3. Make version pinning deterministic: hold v1 at a scoped barrier after claim, assert RUNNING,
   enable/select v2 and submit Op2, then release v1. Assert task/operation routing versions and
   both semantic outcomes through supported interfaces. Separate business version from profile
   connector revision pinning; consume the latter only after Claude publishes its API.
4. Add a real worker-process crash/restart test using a business-owned child process fixture:
   wait for durable successful checkpoint, terminate ONLY that test-owned worker PID, prove no
   graceful failTask drove recovery, let runtime lease recovery/redelivery occur, start replacement
   worker and assert epoch/attempt advancement, completed output, no duplicate completed inference.
   Keep existing 429 test as a distinct regression. If no supported lease recovery mechanism is
   available, publish exact missing API/evidence to requests; do not patch platform or label 429
   as crash. Lost provider response / UNKNOWN is a separate platform-dependent scenario.
5. Publish precise P5 acceptance matrix and commands/results. If typed continuation is published
   during this work, read the contract and record a concrete P7 adoption plan; do not invent
   TaskContext fields or expand into P7 implementation before tasks 1-4 are resolved or blocked.

Done: truthful report, deterministic pinning proof, safe fixture teardown/isolation, actual crash
proof or precise upstream blocker; unit/typecheck green and infra results explicitly scoped.
Dispatch accepted in existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3,
request 11cbb07f-eb89-46d9-a040-56be01e8c651 (input_accepted; provider has no turn_started signal).
No duplicate send or new session. Stop at handoff, not agent completion.
