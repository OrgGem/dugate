# Wave 13 - verified progress and next tasks (2026-09-21)

Dispatch: Claude current terminal term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd accepted
30fc6db4-f9eb-46dc-8b23-734b3ca6ae64 with turn_started. Antigravity existing terminal
term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 accepted 08f5e0bb-28bf-4726-87d7-ec6594b19860.
Both in existing D:/Git/dugate worktree; no new session created by coordinator.

Preserve shared dirty checkout; no reset/clean/broad staging. Continue existing work.
This packet records verified slices, not blanket phase completion.

## Coordinator verification
- Orchestrator runtime: 23/23 PASS, including expired lease before sweep, concurrent identical
  grants and deny-all behavior when action declares no connector slots.
- document-core bounded-input: 26/26 PASS.
- document-core integration: 9/9 PASS when run independently. Auth fixture fixed and signed
  grants now verified by ContractSignedGrantVerifier without pendingHashes/hash mutation.
- Initial concurrent run with Orchestrator produced 9 E2E failures (submit 404) and a Jest
  open-handle warning; standalone rerun passed. runtime.test.ts line 101 TRUNCATE includes
  business_versions and shared operations/tasks. Shared DB interference is the leading cause.
  Coordinator stopped only its own lingering failed test command; no agent session interrupted.
58 tests pass across successful scoped runs; parallel compatibility NOT certified.

Accepted: W12 auth fixture/shim removal, grant expiry/concurrency/zero-slot tests, framed identity,
comparison alias happy paths. Do not repeat already accepted work.
Still open: profile-bound grants, artifacts/bootstrap, typed continuation; P5 full facade/version
acceptance. Claude report still wave05 and must be updated. P0 factual updates exist but full
spec acceptance is not automatically promoted by this focused runtime review.

## Claude W13-C (platform ownership)
Current terminal changed to term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd; old handle not reused.

1. Update reports/claude.md with verified W12 changes and current blockers FIRST. Canonical
   consumer compatibility is proven by unshimmed document-core E2E; do not keep it marked absent.
2. Fix test isolation in platform/shared integration ownership: runtime test globally truncates
   the DB used by other suites. Use per-suite isolated DB/schema/queue resources or a documented
   enforced serial shared-infra harness as an interim measure. Scope cleanup to owned resources;
   never truncate a caller-provided non-test database. Coordinate fixture contract through report.
   Antigravity owns its business harness; do not edit that file.
3. Finish profile-bound routing (P2-02/R08-02): API key -> authorized profile/action/version;
   operation pins connector binding/revision; grants use that pin, not global opts. Regression
   proof for unauthorized profile/slot, revision changed during operation, missing lease expiry,
   cancelled/terminal operations, and UNKNOWN without blind fresh invocation.
4. Then existing artifact lifecycle/bootstrap/separate migration and typed continuation backlog.
   Publish typed API when ready; avoid UI/release expansion ahead of these dependencies.
5. Run SDK/Connector/shared integration tests with the isolation policy. Report exact commands
   and scope; no silent demotion of profile pinning from required acceptance.

## Antigravity W13-A (business ownership)
Own document-core/example-review/document-kit and own reports/requests; no platform edits.

1. Harden integration fixture isolation and failure cleanup within your files. Use platform's
   published isolation hook when ready; before then run shared-DB suites sequentially and label
   limitation. Ensure failed setup/submit closes workers, HTTP keep-alive connections, pools and
   timers. Avoid swallowing every cleanup error without reporting leaked resources.
2. Finish remaining P5-10 evidence: explicit facade parity/28-variant mapping plus checkpoint/
   version behavior. Build a small evidence matrix against tasks/P5-document-core.md and G4.
   Add executable version-pinning test (old in-flight business version remains old; new submission
   goes to newly selected version) when platform supports it; otherwise state exact missing API.
   Do not equate the idle second-worker test with crash recovery.
3. Tighten new comparison alias parser: parseComparisonSide casts object members to strings
   without runtime checking, and fileAlias silently overrides direct canonical source/target.
   Test nonstring text/artifactId, arrays, empty/whitespace values, conflicting canonical+alias,
   and ambiguous artifact+text. Apply an explicit documented precedence/rejection policy aligned
   with original facade plan; malformed inputs must fail validation, not downstream TypeError.
4. Update report with completed vs blocked rows. No new hash shim. P7 implementation starts only
   after typed child-results/wait contract is published; no invented TaskContext properties.

## Status
P5-10 restored to PARTIAL (unshimmed green), not REGRESSED. Grant security slice improved but
profile pinning incomplete. P0 review separate; P7 blocked on continuation. P6/P8 later; P9 excluded.
