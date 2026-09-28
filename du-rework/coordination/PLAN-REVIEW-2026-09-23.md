# Plan review — 2026-09-23, 08:31 +07:00 snapshot

## Verdict and scope

**NOT RELEASE READY; G6 NOT PASSED.** Existing implementation is substantial, but task completion has been confused with completion of a smaller packet. This review changes acceptance tracking, not the running agents' assignments or product source. Later evidence can close the gaps below; file existence, test totals and a report's own assertion cannot do so alone.

Read with [Wave 39](WAVE-39-ORCHESTRATOR-REALLOCATION.md), including its latest cycle entries, and [ADR-14](../docs/15-decisions.md). Wave 39 remains the execution/ownership authority. This review does not create a new dispatch wave, acquire the shared DB window, or authorize production cutover.

## Findings and plan corrections

| Priority / ID | Finding and concrete evidence | Correction / completion condition |
|---|---|---|
| High / RV-01 | P6-02..06 are checked as UI tasks, but the delivered files under `services/orchestrator/src/app/admin/` are TypeScript view models/fixtures. `reports/openclaude.md` explicitly leaves rendered output, HTTP wiring and browser/a11y unproven. ADR-14 also calls rendered UI deferred. | Reopen the five parent tasks as PARTIAL; retain acceptance of the view-model slices. OpenClaude continues W39-O4 without reimplementing those helpers. Close each parent only with its rendered behavior, real route integration and relevant browser evidence; P6-07 requires desktop/mobile screenshots and accessibility verification. G4 UI remains open. |
| High / RV-02 | `docs/18-release-readiness-report.md` declares P1/P2/P4/P6/P7 COMPLETE and G6 conditional-ready while P1-03/05/06, P2-02/03/10, P4-05/07/08, P7-03/04 and P8-02..06 are open. Pure root-app Workflow Builder evidence does not prove the new platform Admin. | P8-08 is a delivered draft, not accepted G6 evidence. Reopen it; reconcile the report to actual task acceptance and an explicit NOT RELEASE READY verdict. Separate demo/integration readiness from release readiness. |
| High / RV-03 | `docs/19-traceability-audit-matrix.md` calls all BR-01..30 VERIFIED, but canonical `docs/01-product-scope.md` defines BR-01..12. Ten exact referenced paths do not exist (listed below). It claims artifact lifecycle coverage even though ART-02 remains open. | Reopen P8-01. Preserve the real cross-service harness slice; rebuild the audit against canonical requirement IDs, actual source/test paths, literal cases, evidence class and unresolved subrequirements. Added capabilities need distinct IDs or an explicit scope decision. Do not reuse the historical 80 suites / 644 tests as a fresh monorepo PASS. |
| High / RV-04 | `docs/17-operational-runbooks.md` §4 uses `UPDATE invocations`, but Connector SQL uses `connector_invocations` (`services/connector/src/db/repository.ts`). §5 deletes old STAGING artifacts without proving active-checkpoint protection. §6 registers via an Admin route while registration lives at `PUT /api/runtime/v1/businesses/:id/versions/:version` in `server.ts`. | Reopen P8-07. Treat mutating procedures as draft, not executable recovery instructions. Platform/Connector owners must validate table/column/route/auth details and state transitions; run isolated recovery drills proving no duplicate billing, lost usage or deletion of referenced artifacts. Documented thresholds are not deployed dashboards/alerts. |
| Medium / RV-05 | W39-C labels the Connector readiness proxy CON-03. The proxy calls `/health/ready`; canonical `docs/13-test-strategy.md` defines CON-03 as provider received-call/response-lost UNKNOWN/reconciliation. `getUsageSummary` also admits missing provider/model on the frozen UsageEvent contract and buckets them as unattributed. | Keep P2-07's bounded completion evidence, but do not use its health-probe test to close P8-03/CON-03. Track readiness vs provider-credential testing separately. P8-03 must prove unknown/dedup/quota/late-usage convergence; attribution needs a coordinated contract proposal or a documented accepted limit. |
| Medium / RV-06 | P0-05's corpus exists, but `rg` finds no consumer of `EXPECTED_RESULT_CORPUS` outside its own file. `all-variants-e2e.test.ts` validates output shape and success, not equality to that corpus. A captured output is characterization, not independent correctness proof. | Preserve delivered fixture/corpus work, but require a repository-owned reproducible generator or provenance plus regression assertions consuming the corpus (normalizing only nondeterministic fields). Record native parser expectations separately from mock-provider output. Do not claim 29 passing tests verified corpus equality. This is a follow-up, not a request to redo all 28 handlers. |
| Medium / RV-07 | `tasks/README.md`, `coordination/README.md`, and the lower matrix of `IMPLEMENTATION-STATUS.md` lag current rows/reports; the status header still attributes Wave 38 stalls to global TRUNCATE. Wave 39 cycle 11 retracted that mechanism and cycle 13 reports a controlled interference experiment. | Point readers to this review and the latest Wave 39 cycle. Do not infer SQL execution from a matching comment. P1-05 needs recorded commands/output and actual suite adoption of DB/Redis/artifact isolation. A scratch experiment alone does not close the reusable harness task. |

Missing exact paths in the published audit (existence checked at this snapshot):

- `businesses/document-core/src/handlers.ts`
- `businesses/document-core/src/manifest.ts`
- `businesses/document-core/src/pipelines/analyze.ts`
- `businesses/document-core/src/pipelines/compare.ts`
- `businesses/document-core/src/pipelines/extract.ts`
- `businesses/document-core/src/pipelines/generate.ts`
- `businesses/document-core/src/pipelines/transform.ts`
- `packages/contracts/src/artifacts.ts`
- `packages/contracts/src/dto.ts`
- `packages/contracts/src/profile.ts`

Additional compatibility correction for the P8-08 follow-up: the rework router implements generic business submission, not `/api/v1/docs/:action`; the old app's routes are not a rework legacy facade. Current operation polling uses `?wait=<seconds>` capped at 30 (`modules/operations/facade.ts`), not the report's 15-second submit-sync claim. Derive the compatibility table from source and [the route inventory](../docs/20-openapi-descriptions.md); that Markdown inventory is not yet a validated OpenAPI document (P1-03 remains open).

## Revised completion sequence (existing owners, no new dispatch)

1. **Finish current packets.** Agent-6 retains its controlled isolation experiment; Command Code continues P4-05/07; OpenClaude continues the rendered Admin shell; Codex's P0/P1 route/traceability inventory remains credited. Claude's P2-07 work remains credited and W39-C2 remains cancelled. Do not repeat delivered helpers.
2. **Make evidence reproducible.** P1-05: integrate namespaces into real test consumers and prove overlap without cross-run cleanup; preserve serial DB access except the experiment explicitly granted by the coordinator. P1-03: machine-readable OpenAPI plus request/response example validation. P0-01/03/06: traceability/compatibility/assumptions with explicit limits. Complete the P0-05 corpus follow-up above.
3. **Close runtime/SDK and Admin boundaries.** Platform owner closes P2-02/03/10 with the ADR-14 scope stated; SDK owner closes P4-05/07/08 with real P2/P3 consumers. UI owner closes P6 using those APIs. Owner must coordinate any change to frozen contracts, root manifests or the lockfile.
4. **Finish extension proof.** P7-03 needs recorded immutable platform image digests and identity/ACL evidence; P7-04 needs generic Admin profile assignment. P7-07's guide is delivered, but full G5/immutable deployment proof still depends on P7-03/04. Process-level coexistence tests remain valuable and do not substitute for those deliverables.
5. **Run release verification.** Start isolated P8-02/03/04 fault/security tests as soon as their provider prerequisites are usable; they need not wait for browser polish or the finished audit document. P8-05 benchmarks depend on P0-06 assumptions and those correctness tests. P8-06 packaging/recovery and P8-07 rehearsed runbooks provide evidence for P8-08/G6. Keep P9 outside the initial release path; any already queued P9 work is optional and must not delay P0–P8 closure.

Each follow-up reports: parent task, exact acceptance sub-scope, source/test cases, command + exit code + result, environment and time, input revision (commit plus dirty-file hashes if necessary), limitations, and gate/DB ownership. A successful unit slice is marked accepted without ticking a larger integration/UI/release parent.

## Evidence and concurrent-work limits

- Independently rerun, offline, no DB/Redis: from `services/orchestrator`, `pnpm exec jest --runInBand --runTestsByPath tests/admin-view-model.test.ts tests/admin-business-view-model.test.ts tests/admin-profile-view-model.test.ts tests/admin-connector-view-model.test.ts tests/admin-api-key-view-model.test.ts tests/admin-operation-view-model.test.ts tests/admin-overview-view-model.test.ts tests/admin-p6-01-shell-fixtures.test.ts` — **8 suites / 398 tests PASS, exit 0**.
- Source/repository checks: task rows, canonical requirement/test IDs, exact audit paths, server routes, Connector SQL, corpus references, current reports and ADR-14.
- Read-only `orca terminal list --json` confirmed the DUGate lanes: Qwen coordinator; Claude's completed P2-07/cancelled C2 receipt; Codex's P1-03 inventory receipt; Agent-6's running isolation experiment; OpenClaude's running rendered-shell task; Command Code's terminal. No process was stopped, no prompt sent, and no DB window consumed by this review.
- Other suite results are **agent-reported historical evidence**, not independently rerun here. The checkout is actively changing; this is a bounded snapshot, not a full code/security audit or full-build certification.

## Applied acceptance changes

P6-02/03/04/05/06 and P8-01/07/08 are reopened as PARTIAL. Their delivered artifacts and passing tests remain credited. No active lane's source, report or Wave 39 dispatch document is rewritten. The task index and status entry points link this review; historical narrative is retained with an explicit superseding note.
