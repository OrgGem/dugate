# Wave 21 - integration contract and failure-path verification (2026-09-22)

Dispatch accepted in existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3;
request 2c077399-c95c-48a4-b90e-5b605dc6f222. No new session/duplicate send.

## W20 coordinator verdict

Independently reran non-infra: document-core 25 suites / 342 tests, document-kit 6 / 77,
example-review 9 / 87: **40 suites / 506 tests PASS**. Accept manifest-correct slot mapping,
12 helper tests and source wiring of suite/v2 profile bindings. Tests 12/13 are authored, NOT
executed or accepted. 518 combines 506 current with 12 historical infra; current inventory is
520 tests if the 13-case E2E plus one smoke case are included. Neither total is a fresh full PASS.

Source-confirmed findings in multi-container-e2e.integration.test.ts:
1. Test 12 passes revision: 2 to PostgresConnectorConfigRepository.createRevision, whose input
   is Omit<ConnectorRevision, 'revision'>. Read and assert the revision returned by the repository;
   do not invent input fields. Normal package lint excludes tests, so its green result misses this.
2. Test 13 expects code FORBIDDEN and message; server forbidden() returns PERMISSION_DENIED and
   serializes ProblemDetails via problem(). Match the actual published envelope, not guessed fields.
3. Test 12 waits for connectorPinningReachedBarrierPromise without bounded timeout and lacks
   finally release/reset of barrier state. An assertion failure can strand a worker and cleanup.
4. Test 13 creates restricted API key and independent profile but does not track/revoke/cleanup
   them in teardown. Report claims Admin API profile cleanup; actual code uses scoped SQL DELETE.
5. Both connector revisions target the same mock endpoint with same mapping. Grant row checks
   are useful, but do not independently prove observed provider revision routing as W20 requested.

Claude existing term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd active on continuation. User reports
27 runtime tests green; coordinator has not independently rerun these. Antigravity existing
term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 finished W20. No new sessions or ownership transfer.
P5-10 PARTIAL; P7 still gated by server lifecycle contract. No new business feature scope needed.

## W21-A - fix and validate the integration already authored

Ownership unchanged: business packages, document-kit, own reports/requests only. No platform,
SDK/contracts/root/lockfile edits; preserve dirty state, no reset/clean/broad staging/git push.

1. Correct Test 12 repository signature and Test 13 ProblemDetails expectations against actual
   source/exported types. Add a business-owned explicit noEmit integration typecheck configuration
   or equivalent validation that INCLUDES the E2E/helpers; do not depend on src-only package lint.
   No any, ts-ignore or disabled diagnostics to hide mismatches. Record stale platform declarations
   separately if source/dist diverge; do not rebuild active platform outputs just to clear errors.
2. Bound barrier wait and always release/reset it in finally on setup/assertion/timeout failure.
   Keep scoped resources tracked until cleanup succeeds. Track restricted keys/profile IDs from
   Test 13; revoke/clean only suite-owned rows using existing supported mechanisms. Correct report
   to say scoped SQL cleanup if that is what code does; do not invent a DELETE Admin route.
   Add offline failure-injection coverage that demonstrates barrier/cleanup completion on failure.
3. Make revision routing observable: distinct mock-provider routes or response markers for connector
   revisions, counters per route, plus signed-grant/ledger pin evidence. Assert both semantic results
   and no extra invocation. Derive old profile revision from setup result, not fragile literal 1.
   Preserve the distinct business-version pinning case and fail-closed action authorization case.
4. Execution handoff: inspect Claude report/session for a stable build window once. With coordinated
   stable platform output and exclusive test infra, run dependency-ordered build and all 13 E2E
   cases (plus smoke separately). Do not run simultaneously with active runtime tests. If no window
   exists, complete offline contract/typecheck/failure-path work and publish exact deferred command
   + requirement; return rather than indefinite polling. No stale-dist PASS or mocked integration.
5. Report precise fresh counts, authored/blocked cases, source/typecheck errors and upstream blockers.
   Explicitly correct historical 518 combined count versus current 520-test inventory if unchanged.
   Do not call either a fresh total until executed. No new polishing backlog beyond these fixes.

Acceptance: E2E compiles against real contracts; failure-safe barrier/resource cleanup; observed
revision routing assertions; offline tests green; fresh live result or narrowly stated blocker.
