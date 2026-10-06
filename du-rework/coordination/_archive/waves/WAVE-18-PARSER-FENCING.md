# Wave 18 - parser completion fencing (2026-09-21)

Dispatch accepted by term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 in existing worktree;
request 2c7e093f-6d5a-45d0-88ed-81e2e03fabfc. No new session or duplicate send.

## W17 coordinator review

Independently reran sequential non-infra tests:
- document-core: 24 suites / 325 PASS (excluded integration.test.ts and bullmq-smoke.test.ts).
- document-kit: 6 / 77 PASS; example-review: 9 / 45 PASS.
Total **39 suites / 447 tests PASS**. All three package lint/typecheck commands PASS.
459 is current non-infra plus 12 historical infrastructure tests, NOT a new full integration run.

Accepted: observability included and manifest-backed build closure checked; all seven parseBuffer
calls across six actions use budget helper; default byte/time options, initial deadline checks,
SDK deadline forwarding, boundary tests. Download-memory/CPU limitations are documented.
Not blanket acceptance of 'all actions strictly bounded':
- parser-budget.ts safeParseBuffer directly returns awaited parser success, with no post-await
  cancellation/deadline check. It checks aborted state only before work or in catch.
- worker.ts assertActive checks AbortSignal, not deadlineAt. Late successful parse can pass onward
  to connector/output if the deadline elapsed without an abort signal (especially synchronous
  parser work which a timer cannot interrupt).
- prepareSources loops check at entry and at parse, but may begin the NEXT artifact read before
  rechecking activity. Cancellation during parse is not tested by pre-aborted cases.
- tests/parser-budgets.test.ts adds multiple `as any` casts, contrary to repository no-any rule.

Claude term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd is actively fixing grant claims and runtime tests.
Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 finished W17; reuse this session.
P5-10 PARTIAL; full live source-build/infra deferred; P7 contract-gated; P0 IN REVIEW.

## W18-A - bounded corrective packet

Ownership unchanged: businesses/document-core/**, packages/document-kit/**,
businesses/example-review/** and own report/requests. No platform/SDK/contracts/root edits,
no reset/clean/broad staging/git push. Do not rebuild platform outputs during Claude's edits.

1. First add deterministic failing regression tests for a parser that resolves successfully AFTER
   context cancellation, and after the deadline crosses while parser work finishes. Use deferred
   promises/fake clock or a test parser that advances the clock; no CPU busy-loop or flaky sleep.
   Cover cancellation while waiting on a pending parser, and deadline crossing between artifacts.
2. Fence successful parser completion before exposing results: preserve existing cancellation vs
   lease-loss taxonomy and deadline errors. A cancelled/expired result must not lead to another
   artifact read, connector call, successful checkpoint persistence or output finalization. Check
   activity before each artifact read and at subsequent side-effect boundaries, including ingest
   checkpoint path and compare's second side. Preserve SDK LeaseLostError behavior where required;
   do not turn fencing into a successful or retryable result.
3. Where asynchronous parser wait can be interrupted, reject promptly on AbortSignal with bounded
   listener/timer cleanup and handle late resolve/reject without unhandled rejection or effects.
   This cancels caller wait only; do not claim preemption of synchronous CPU or initial artifact
   download. Keep existing size limits and valid text/28-variant semantics unchanged.
4. Replace W17 `any` fixture mutations with typed context construction/overrides. Add handler-level
   regressions asserting zero provider/output/success-checkpoint effects on late cancellation and
   deadline expiry, rather than helper-only rejection tests. Preserve valid happy-path coverage.
   No broad unrelated refactor or new resource-isolation subsystem.
5. Run owned non-infra tests + typechecks, update report with accepted vs pending scope. Keep
   live E2E/dependency rebuild pending a stable platform window. If continuation is published,
   record exact symbols/routes for the next P7 adoption packet; do not invent API or idle-wait.

Done: reproductions fail before fix, pass afterward; late parser completion fenced; pending parser
abort wait cleaned up; multi-artifact side-effect fencing; typed tests; exact evidence totals.
Full gate closure still requires actual fresh integration verification and upstream lease recovery.
