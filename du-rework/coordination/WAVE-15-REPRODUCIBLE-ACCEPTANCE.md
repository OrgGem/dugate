# Wave 15 - reproducible business acceptance (2026-09-21)

Dispatch: accepted by existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3,
request bf703947-14d9-4839-9fc7-d82be9c94f4d. No new session or duplicate send.

## Coordinator acceptance of W14-A

Independently executed, sequentially in du-rework:
- pnpm --filter @du/document-core test -- --runInBand: 22 suites / 231 tests PASS,
  including 11 integration cases and real test-owned process termination.
- pnpm --filter @du/document-kit test -- --runInBand: 6 suites / 77 tests PASS.
- pnpm --filter @du/example-review test -- --runInBand: 8 suites / 42 tests PASS.
- pnpm --filter @du/document-core lint: PASS.
Total 36 suites / 350 tests PASS. This run used existing compiled dist artifacts; it does not
certify a clean-build/source-only integration run or concurrent suite isolation.

Accepted: deterministic RUNNING barrier across business-version enablement; abrupt child PID
termination with awaited exit; durable inference checkpoint replay after injected redelivery,
advanced epoch/attempt, no duplicated inference; cooperative 429 remains separately tested.
Cleanup improved with unique connector ID, finally-close DB setup, aggregated failures.

Acceptance boundaries / remaining defects:
- Crash test lines 1613 onward manually expire lease AND INSERT an outbox delivery. This proves
  crash + expired-lease reclaim/replay, NOT autonomous lease detection/redelivery. Platform
  sweeper remains a dependency; no need to redo the accepted crash scenario.
- DB guard uses substring `_test` OR localhost:5433. A production DB on that port or `_test`
  in a password/hostname passes. It is not a fail-closed target check.
- Child fixture requires ../../dist/worker; Jest maps Orchestrator/Connector to dist while SDK
  maps to src. Plain test does not build prerequisites. Green may mix stale and current code.
- Failure cleanup calls cp.kill() without awaiting exit. IPC ready/step promises do not promptly
  reject on child exit/error; timeout listeners are not consistently removed. A worker is removed
  from cleanup tracking before stop succeeds in crash/version tests.
- Report claims versions verified in result envelopes; code checks envelope.status only. Version
  immutability IS proven in API/DB; describe exactly that, or add supported envelope assertions.

Claude session term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd remains owner of W13-C; terminal
last reports scoped runtime cleanup/coexistence check, then profile grants next. Report updated
from wave05 but still marks isolation in progress. No automatic completion inferred from prompt.
Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 confirmed idle before dispatch.

Roadmap: P5-10 PARTIAL with accepted business reliability slices. Autonomous recovery, safe
repeatable harness and final gate evidence remain open. P0 IN REVIEW, P7 continuation BLOCKED;
do not invent typed APIs, start UI work, or relabel production image work as business completion.

## W15-A - Antigravity task packet (execute in order)

Own businesses/document-core/**, packages/document-kit/**, businesses/example-review/** and
own coordination/reports/antigravity.md + coordination/requests/antigravity.md. No platform,
SDK/contracts, central gates, root package/lockfile edits. Preserve shared dirty changes; no
reset/clean/broad staging/git push. Continue this session, no duplicate workers/agents.

1. Fix dedicated-test target validation BEFORE connections/migrations/writes. Parse URL, validate
   exact allowed database target and host policy or an explicitly provisioned isolated target;
   port alone and arbitrary substrings must never authorize. Validate Redis test target too.
   Add no-network table-driven tests rejecting prod DB on 5433, `_test` only in credentials/host,
   malformed URL and unapproved remote target. Never log credential-bearing URLs.
2. Make integration compilation reproducible in business-owned scripts/config/docs: explicit
   prerequisite build command (respect workspace dependency ordering), source/build consistency
   for child and parent, no silent fallback to stale dist. Do not delete shared build artifacts
   while Claude works. If root scripts need changing, request that from Claude, don't edit them.
   State exact build+test sequence and verify it with current sources.
3. Harden child lifecycle helpers with bounded ready/step/exit waits, rejection on early exit/error,
   timer/listener cleanup, awaited termination and PID-scoped fallback only for test-owned child.
   Keep resource tracked until stop/exit is confirmed. Add failure-path tests for early child exit,
   failed setup before ready, missing barrier, and stop failure; assert no orphan/live IPC handles.
   Avoid introducing hard-crash tests that kill any existing agent/process.
4. Update report/evidence matrix with precise crash and version scope; retain 350 baseline.
   Record sweeper dependency as automatic recovery blocked, not a fully green runtime criterion.
   When Claude publishes sweeper/isolation hooks, adopt them via public contract in business tests;
   otherwise retain explicitly named injected-redelivery test and exact upstream request. Do not
   implement platform functionality in the fixture or substitute SQL for a claimed live sweeper.
5. Produce a small P7 readiness checklist in example-review docs: current published SDK interfaces,
   missing server endpoints, fanout/join/approval/cancel/duplicate-resume test cases to enable after
   contract publication. No speculative implementation or mocked extension-completion claim.

Acceptance: guard negative tests, bounded failure cleanup proof, reproducible source build+E2E,
three owned packages test/typecheck results, precise blockers. Shared infra remains sequential;
run only while no other shared-DB suite is active, unless actual resource isolation is proven.
If platform changes break an integration contract, report exact mismatch; do not add compatibility
shims that hide it. Stop after reporting completed/blocked items, not an unbounded wait for Claude.
