# Wave 16 - close concrete W15 acceptance gaps (2026-09-21)

Dispatch accepted in existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3;
request deef3c39-0f90-43dc-b6d9-4e78fdc1e705. No duplicate send or new session.

## Review verdict

W15 delivered useful work but is NOT fully accepted. Coordinator independently ran:
- document-core excluding integration.test.ts and bullmq-smoke.test.ts: 22 suites / 255 PASS;
- document-kit: 6 suites / 77 PASS;
- example-review: 8 suites / 42 PASS.
Total 36 suites / 374 tests PASS, including all 29 target-guard and 7 child-lifecycle tests.
Agent reports full 38 / 386 PASS; 12 infrastructure tests not rerun this audit while Claude
actively wires platform source. W15 report's green totals do not cover findings below.

Accepted: parsed loopback/Postgres naming validation improves prior substring guard; bounded
IPC message waits; seven executable child-process tests; more accurate crash/pinning report.

Confirmed gaps:
1. tests/helpers/child-process-manager.ts terminate treats child.killed as exited, resolves
   success on timeout immediately after process.kill, and resolves on kill exception. It removes
   tracking without confirmed exit; terminateAll clears even unresolved children. Seven tests
   do not exercise kill-failure/timeout/signal-sent-but-not-exited branches.
2. pretest:integration runs tsc -b against document-core tsconfig with NO project references.
   It does not build Orchestrator/Connector/SDK dependencies. Freshness compares only worker.ts
   and worker.js, missing actions/helpers and imported packages. This is not clean dependency
   build proof. Avoid rebuilding platform outputs mid-Claude edits during this audit.
3. Redis guard accepts any loopback port/database (including normal :6379/0). PostgreSQL guard
   examines first path component and allows arbitrary query parameters; actual driver target
   must match validated target. sanitizeUrl retains query/fragment secrets.
4. P7 checklist falsely describes current SDK: context.task, stepCheckpoint/readStepCheckpoint,
   uploadArtifact/downloadArtifact/requestArtifactAccess, connectorClient are not TaskContext
   members. Actual types expose flat taskId, step.run/peek, artifacts facade, connector.invoke,
   spawn.spawnAndWait, wait.waitForInput. Claim route is tasks/:id/claim, not /claim.
   Proposed join/resume routes must be labeled requirements until published, not existing API.

Sessions: Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 confirmed idle. Claude
term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd active editing claim/grants (W13-C); no duplicate
dispatch or ownership transfer. Runtime parallel pairing is reported progress, not universal
isolation certification. P5-10 PARTIAL; P7 BLOCKED pending authoritative continuation; P0 IN REVIEW.

## W16-A tasks - Antigravity, in priority order

Scope: businesses/document-core/**, businesses/example-review/**, packages/document-kit/**,
own reports/antigravity.md and requests/antigravity.md. No services, SDK/contracts, root config,
lockfile or central gates. Preserve dirty changes; no reset/clean/git push. No new agent session.

1. Correct lifecycle helper: signal sent is not exit. Observe actual exit/signal state; retain
   child on unsuccessful/uncertain termination; bound escalation then reject with diagnostics
   if death cannot be confirmed. terminateAll must aggregate errors without forgetting survivors.
   Handle error listeners/concurrent terminate calls safely. Add deterministic fault-injection
   tests for kill returning false, throwing, timeout after signal, already signaled but live,
   and terminateAll partial failure. Use test doubles for unkillable paths, not real orphan PIDs.
   Existing real-process happy-path tests must continue to pass.
2. Make test target validation match driver semantics: explicitly allowed dedicated Redis
   host/port/database tuple (current local test service :6380) or explicit provisioned isolated
   target; reject ambiguous multi-segment/encoded PG paths and query target overrides unless
   normalized and verified. Do not echo raw query/fragment values in errors. Add negative tests
   for query host/database override, extra path segments, local non-test Redis and query secrets.
   Apply before connections. Test-only helpers should live in tests/helpers unless production
   usage is justified; do not expose test environment policy as production worker config.
3. Replace claimed prerequisite build with explicit dependency-ordered build+integration command
   covering every dist consumer (services and shared packages) using business-owned script/docs.
   No dependence on implicit lifecycle hook behavior or one-file mtime proof. Fail on any build
   failure; never run stale integration as fallback. Unit-test command order/failure propagation
   without modifying platform files. Execute live build+E2E only after Claude publishes stable
   contract/build window; otherwise report exact pending verification instead of 'clean build'.
4. Correct P7 readiness doc against actual exported SDK types/runtime routes, cite source paths,
   separate existing facade/client from missing server implementation. Add a compile-checked
   business-owned usage example against the real TaskContext type (no any/casts/shims). Keep six
   desired integration cases as requirements, not claims of supported endpoint names or status
   codes. On published continuation contract, update mapping; do not guess/invent API.
5. Update report: mark each accepted vs pending, exact commands and counts. Keep accepted W14
   crash replay test; autonomous sweeper remains upstream. No new polish scope beyond these four
   concrete fixes. If blocked by active platform build, finish independent fixes and report blocker;
   do not wait indefinitely or claim completion. P7 full adoption is a subsequent contract-gated packet.

Done: regression tests expose and fix lifecycle false success; dedicated-target/secret negative
tests; correct dependency build workflow with truthful verification status; SDK-accurate checklist
and compiled consumer example; owned tests/typechecks pass. Infra runs remain coordinated/serial.
