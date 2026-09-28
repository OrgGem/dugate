# Wave 20 - manifest-correct profile consumer (2026-09-21)

Dispatch accepted by existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3;
request dfd52522-92c8-4f44-bea3-8740a29110d3. No new session/duplicate send.

## W19 review and acceptance

Coordinator independently reran non-infra sequentially:
- document-core 25 suites / 339 tests PASS (excluding integration.test.ts and bullmq-smoke.test.ts);
- document-kit 6 / 77 PASS; example-review 9 / 87 PASS.
Total **40 suites / 503 tests PASS**. document-core and example-review typechecks PASS.
87 is the whole example-review package, not 87 dedicated child safety cases.
515 = 503 current + 12 historical infrastructure tests in these three packages, NOT whole workspace
verification and NOT a fresh 515-test run.

Accepted: strict child numeric index/object/filename validation and zero-effects regressions;
HTTP profile helper request/error handling exists and nine offline tests pass.
Profile integration acceptance remains incomplete:
1. bindActions defaults to slot 'llm' for all six actions. Manifest declares reasoning for
   extract/analyze/transform/generate/compare and ocr/vision for ingest. No declared llm slot exists.
   Mock tests reproduce this incorrect mapping and cannot prove actual grant compatibility.
2. multi-container-e2e.integration.test.ts does not import/use ProfileBindingFixtureClient yet.
   A standalone helper is preflight only, not a profile-aware integration harness.
3. Report/checklist says 'no child DB models exist'; task_dependencies already exists in migration
   0001_platform_v1.sql. Distinguish absent route/lifecycle implementation from existing schema.

Session check: Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 idle. Claude existing
term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd last reported legacy runtime 23/23 green and profile
regressions next; no completed profile-regression/continuation publication inferred from that.
Source still lacks children/wait-input/resume routes at audit time. Sweeper/live-build blockers stand.

## W20-A - concrete fixture correction and wiring

Ownership: businesses/document-core/**, businesses/example-review/**, packages/document-kit/**,
own reports/requests. No platform/SDK/contracts/root/lockfile/central gate edits, no destructive git,
no uncoordinated shared build/test commands. Preserve all existing dirty work and sessions.

1. Replace one global default slot with per-action connectorBindings derived/validated against
   documentCoreManifest. Use reasoning where declared; ingest ocr/vision per tested variant.
   Reject undeclared actions/slots before HTTP side effects, validate empty action input explicitly,
   never silently return undefined profileId. Add manifest-backed tests that would fail the current
   llm implementation, verify exact six-action payloads and preserve published HTTP wire contract.
2. Wire the corrected helper into the actual business E2E setup after connector provisioning and
   before submissions. Create suite-owned bindings using Admin HTTP API; retain real signed grant
   verifier and no profile SQL seed/global-binding fallback. Ensure version-pinning test explicitly
   creates required v2 action binding instead of relying on legacy API-key authorization. Track
   suite-owned profile resources and cleanup safely under platform's available capabilities.
3. Add a deterministic connector revision pinning integration case: barrier keeps old operation
   in-flight, append new binding revision, submit new operation, verify old/new grants/provider
   routing stay on their respective revisions and semantic outcomes. Keep business-version test
   distinct. Add negative authorization case for an unbound action (no task/provider effect).
   Build against actual published source contract; do not fabricate APIs or skip assertions.
4. Live execution gate: re-read Claude report/session once for stable build/runtime-regression
   publication. If stable window exists, run dependency build then scoped E2E sequentially and
   record exact results. Otherwise finish harness/manifest-backed offline tests/typechecks and
   explicitly mark integration UNEXECUTED/BLOCKED, with command + upstream requirement. Do not
   keep waiting, rebuild active platform outputs, or claim mocked tests are live evidence.
5. Correct own docs/reports: existing task_dependencies vs missing continuation lifecycle;
   scope counts accurately; W19 input safety accepted, profile fixture correction now W20.
   P5-10 PARTIAL and P7 live proof blocked. No additional parser/validation polishing absent a
   concrete regression. Do not expand workload just to occupy time while platform is blocked.

Acceptance: manifest-accurate bindings; helper actually wired into E2E; v2 profile provisioning;
revision-pinning/authorization cases authored; offline tests/typechecks green; fresh live evidence
or precise upstream blocker, never aggregate historical infra into a claimed fresh workspace run.
