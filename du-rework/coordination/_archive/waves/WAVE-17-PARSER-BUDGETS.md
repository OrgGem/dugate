# Wave 17 - independent business parser budget backlog (2026-09-21)

Dispatch accepted in existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3;
request e26abf39-3288-4551-8e47-494a9097c72e. No duplicate send/new session.

## W16 review

Coordinator reran non-infra sequentially: document-core 23 suites / 278 tests,
document-kit 6 / 77, example-review 9 / 45: **38 suites / 400 tests PASS**.
Commands: pnpm --filter <package> test -- --runInBand; document-core additionally excludes
integration.test.ts and bullmq-smoke.test.ts via testPathIgnorePatterns.
412 is a combined inventory (400 current + 12 historical infra), NOT a fresh full-scope run.

Accept W16 lifecycle false-success fixes/fault tests, strengthened parsed target checks,
corrected SDK checklist and compiled consumer slice. Keep live dependency-build/infra acceptance
pending while Claude edits platform. Found a concrete build completeness gap: build-dependencies.cjs
omits @du/observability, although worker-sdk, connector and orchestrator declare it as a workspace
dependency. Four mocked order tests verify a hardcoded list, not dependency closure.

Claude term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd remains active on grants/continuation W13-C.
Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 finished W16; reuse same session.
P5-10 PARTIAL, P7 contract-gated, P0 IN REVIEW. Do not reopen accepted crash replay or invent API.

## W17-A - independent tasks while platform is in flight

Ownership unchanged: businesses/document-core/**, packages/document-kit/**,
businesses/example-review/**, own report and requests only. No platform/SDK/contracts/root config
or lockfile edits; preserve dirty worktree, no reset/clean/git push or other agent interruption.

1. Close build graph omission: include observability before its consumers. Validate build closure
   and ordering against actual workspace package.json dependencies rather than only expected
   hardcoded array. Cover every dist consumer and fail-fast execution; document explicit full
   command. Do not rebuild platform output while Claude edits; mark live validation pending.

2. Implement missing parser budgets across the SIX business actions. Current parseBuffer calls
   in ingest/extract/analyze/transform/generate/compare omit ParserOptions entirely. Document-kit
   already supports maxBufferSizeBytes and timeoutMs. Add one business-owned budget resolver/helper
   and route all artifact parsing through it; reuse existing plan/config limits, document any
   conservative default instead of inventing profile wire fields. Preserve SDK deadlineAt through
   the internal context adapter and cap per-call wait by remaining deadline. An already-expired
   deadline must fail before parser/provider/output effects. Validate finite bounds and test exact
   byte boundary, oversized inputs, timeout, cancellation, multiple artifact cumulative wait and
   both compare sides. Map failures consistently to business taxonomy, no success finalization
   or provider call after preparation fails. Inline text paths must keep existing behavior.
   If profile-specific budget is not available in published TaskContext, document that exact
   blocker; implement local defaults + existing deadline support without fabricating platform data.
   Important: byte checks after artifacts.read do NOT bound download memory; timeout Promise.race
   does NOT preempt synchronous CPU. State those limitations, do not claim hard resource isolation.

3. Add table-driven action-level regression coverage showing every parser call receives budget,
   plus SDK-consumer tests proving deadline forwarding. Keep tests offline and deterministic;
   no external AI or shared PG/Redis needed. Run owned non-infra tests and typechecks. Preserve
   semantic 28-variant and checkpoint/cancellation behavior.

4. Update own report/requests with verified vs deferred evidence (400 baseline, new totals).
   Autonomous sweeper, profile pinning and P7 continuation remain platform dependencies. If Claude
   publishes the contract during this packet, record exact exported symbols/routes for next P7
   adoption; finish this bounded packet first. Do not wait indefinitely for platform or activate
   speculative integration endpoints. Full source-build+E2E scheduled after a stable platform window.

Acceptance: manifest-backed dependency graph test, all six parser paths bounded with explicit
limits, deadline/error/cancellation tests, owned typechecks green, precise pending infra evidence.
