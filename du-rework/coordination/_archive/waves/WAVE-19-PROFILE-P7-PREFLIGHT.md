# Wave 19 - profile consumer preflight and P7 input safety (2026-09-21)

Dispatch accepted by existing terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3;
request 7d7389d5-9ee2-4634-b497-6f84d06b287a. No duplicate send/new session.

## W18 acceptance

Coordinator independently reran sequentially:
- document-core non-infra: 24 suites / 330 PASS;
- document-kit: 6 / 77 PASS; example-review: 9 / 45 PASS.
Total **39 suites / 452 tests PASS**; document-core typecheck PASS.
Text search found no `any` in parser-budgets.test.ts or fixtures/mock-context.ts.
Accepted: post-await parser completion check, abort caller-wait race/finally listener cleanup,
per-artifact pre-read fencing, worker deadline checks and typed mock context. Stop reopening this
accepted slice without a concrete new regression. 464 includes 12 historical infrastructure tests.

## Platform reality at review

Claude term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd is actively editing platform.
server.ts now includes POST /api/v1/admin/profile-bindings; source searches across Orchestrator
found no children/wait-input/resume implementation at review time. SDK spawnChildren client exists,
but is not server readiness. User/orchestrator statement that typed continuation routes are done
is not yet substantiated by this source snapshot. Recheck after publication, do not assume completion.
Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 confirmed idle at prompt.

P5-10 PARTIAL (fresh profile-aware full integration still pending), P7 BLOCKED for live join/HITL,
P0 IN REVIEW. Business preflight can proceed without speculative platform interfaces.

## W19-A task packet

Own businesses/document-core/**, businesses/example-review/**, packages/document-kit/** and own
report/requests only. No services/SDK/contracts/root/lockfile/central gate edits. Preserve dirty
checkout; no reset/clean/broad staging/git push. No new agent sessions or platform test interruption.

1. Review CURRENT profile-bindings HTTP input/output against submission/grant changes and publish
   a business-owned consumer mapping with exact source references and readiness status. Prepare
   document-core integration fixture to create its suite-owned profile using the published Admin
   route, bind test API key/action/version/connector revision, and use the real public submit path.
   Do not direct-SQL seed new profile bindings or bypass fail-closed grant verification. Implement
   only fields already present in source; explicitly defer if Claude changes/unpublishes contract.
   Add fixture request-shape/response-error tests offline. No compatibility fallback to global
   connector config to make authorization failures disappear.
2. Once Claude reports stable platform build/tests, run dependency-ordered build and profile-aware
   business E2E sequentially with safe test target/cleanup policy. Test in-flight revision pinning
   with a barrier, then new submission using the new revision, checking observed provider routing
   and grant claims where public interfaces permit. If stable window is unavailable, do not rebuild
   its live outputs: report exact blocked command and required contract. Complete independent work
   below and return; no indefinite waiting and no historical infra totals labeled fresh PASS.
3. Fix concrete P7 input validation now, independent of continuation: parseChildReviewInput uses
   Number(rawInput.itemIndex), accepting null/false/empty string as 0; artifact accepts arrays as
   objects; invalid fileName is silently discarded. Enforce schema-aligned strict numeric integer
   index and object/optional-string validation with consistent parent/child bounds. Inspect manifest
   and business BRD first; do not introduce arbitrary wire fields. Add table-driven negative cases
   (null, boolean, numeric string, fractional/nonfinite index, array artifact, invalid filename).
   Verify invalid child input causes zero artifact read/provider/output effects. Preserve valid
   existing handler behavior and no-any rule.
4. Prepare P7 activation checklist with actual published signatures, not wished-for endpoint names.
   If authoritative continuation routes/types become available during this packet, compile-check
   their consumer shape and record next fanout/join/HITL acceptance steps. Full P7 implementation
   starts only once server+SDK contract is published and testable; no fake joinedChildren fields,
   caller-supplied child results, platform patches or mocked live-completion claims.
5. Update own report: W18 accepted baseline, new offline verification, new profile fixture status,
   precise live-build/continuation blockers. Distinguish implemented routes from proposals and
   452 current baseline from 12 historical infra. Do not expand UI/release scope to stay busy.

Done: strict child validation regressions green; profile consumer fixture/preflight evidence;
fresh integration result OR exact upstream blocker; owned typechecks/non-infra green.
