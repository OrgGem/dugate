# Wave 23 — coordinated P5/P7 live integration gates (2026-09-22)

## W22-A verdict

Accepted in verified scope. Independently reran `@du/document-core` 26 suites /
347 non-infra tests, `@du/document-kit` 6 / 77, and `@du/example-review`
9 / 87: **41 suites / 511 tests PASS**. `@du/document-core test:typecheck`
PASS, including E2E source. Test 12 now resolves `/result`'s `data.resultRef`
through `readResultArtifactEnvelope` and asserts semantic data. Initial connector
revision is captured separately from the profile revision. The new extraction
regression confirms the revision marker survives business result formatting.
The 13-case multi-container E2E and one smoke test have **not** been rerun;
43 suites / 525 tests is inventory only. P5-10 remains PARTIAL and P7 remains
PARTIAL/BLOCKED on live continuation evidence.

## Go/no-go for the shared-DB window

Do not start while Claude is editing platform outputs or running tests against
the same PostgreSQL :5433 / Redis :6380 targets. Begin only after Claude
publishes a stable route/runtime build with its own typecheck/runtime tests
green and an explicit exclusive window for Antigravity. Inspect the actual
`server.ts` handlers, runtime service, and SDK/contract shapes before assuming
all four routes are available. A route's presence alone is not proof of
fanout, join, wait, resume, cancellation, or isolation.

Antigravity owns the business-side test execution and report. Claude owns
platform routes/lifecycle and any fixes there. If the window is unavailable,
record this single blocker and stop; do not repeatedly poll or run against
stale dist. No concurrent runtime/E2E tests or broad shared-DB cleanup.

## Window sequence and evidence

1. Record Claude's publication, route/runtime test results, exclusive-window
   confirmation, and target guard. Confirm the test DB/Redis ports and that no
   other suite is operating on them.
2. Build dependencies in order, then run
   `pnpm --filter @du/document-core test:integration:full` as the sole shared-DB
   owner. This script already invokes its dependency builder; do not duplicate
   a second build unnecessarily. Record all 13 case results, actual failure
   traces, resource cleanup, and whether provider routing/grant pinning and
   fail-closed authorization were observed. Run the BullMQ smoke case only
   after the E2E suite exits and its resources are released.
3. For P7, compare published server/SDK contracts with
   `businesses/example-review/docs/p7-readiness-checklist.md`. Establish the
   business-owned live harness only against stable routes. Prove in order:
   spawn/yield to `WAITING_CHILDREN`; child execution and all-success join;
   parent continuation with joined results; wait-input to `WAITING_INPUT`;
   authenticated/schema-validated resume with `waitResponse`; cancellation
   and failure paths. Assert database states and externally observable outcomes,
   not merely 2xx response codes. Do not label P7 live-ready from offline mocks.
4. Execute P5 and P7 shared-DB suites serially. On failure, isolate the
   smallest reproducible case and assign fixes by lane; do not modify Claude's
   platform files from Antigravity's lane. Publish exact commands, fresh counts,
   skipped cases, blockers, and gate status in `reports/antigravity.md`.

## Immediate W23-A preparation while Claude remains active

Antigravity: perform a read-only contract and test-harness audit of P7 against
current source; update the P7 readiness checklist only for confirmed contracts
and an executable live-test design. Flag missing server lifecycle or harness
capabilities precisely. Do not invent endpoint behavior, claim live readiness,
run shared-DB tests, or wait indefinitely. Once done, report the go/no-go
conditions and return idle. The live sequence above starts only on a later
explicit coordinated window.
