# Wave 11 - review and next execution slice (2026-09-21)

Dispatch receipts (existing sessions, D:/Git/dugate):
- Claude terminal term_2ab5a374-94b4-4c30-ae04-cbc8f2fa2941 accepted request
  8b36f925-f721-40e6-ad85-2de10472872d; turn_started confirmed.
- Antigravity terminal term_d7692e4e-e693-4b08-a91f-26abfbcc78d3 accepted request
  8c1012a6-7b8a-40dd-9e0b-ca314d7bafd4; provider cannot emit turn_started receipts.

Supersedes immediate ordering in wave10, not unfinished acceptance. Preserve shared dirty edits.
No reset/clean/broad staging. Reuse existing sessions. This is an implementation handoff.

## Verified current snapshot

Coordinator ran independently:
- @du/orchestrator tests/runtime.test.ts: 18/18 PASS, including unknown/revoked API key rejection
  and distinct admin/runtime credential tests.
- @du/document-core tests/multi-container-e2e.integration.test.ts: 9/9 PASS.
- @du/document-kit tests/limits-boundary.test.ts: 25/25 PASS.
Total focused verification: 52 passing tests, not a whole-workspace certification.

Accepted progress:
- R08-01 core auth fix exists in server.ts: SHA256 ACTIVE-key lookup, no unknown-key fallback,
  dedicated adminToken. Claude report remains wave05 and must catch up.
- Antigravity semantic output assertions, scoped native zero-usage checks, and deterministic
  transient-failure retry/reclaim are implemented. This recovery case is NOT process-crash
  recovery or the lost-provider-response UNKNOWN scenario.
- Parser optional byte ceilings work. Factory timeout rejects the caller Promise.
- Traceability UC-06/08 corrected and planned controls identified.

Still open:
- grants.ts creates randomUUID per request; canonical SDK/Connector hashing still shimmed.
- Artifact lifecycle, executable bootstrap/separate migrations, typed child/HITL continuation.
- Parser Promise.race does not abort underlying parse or interrupt synchronous CPU work.
  Direct parser implementations do not honor timeoutMs consistently (Word fallback hardcodes 500).
- P0 corpus policy incorrectly claims every variant has cross-service proof (only six representatives).
  Redaction masks in policy use underscores vs implemented [REDACTED:EMAIL]/[REDACTED:PHONE].
- workload-assumptions.md still describes cleanup/retention/row limits/isolation as present
  guarantees despite its overall assumptions disclaimer. Distinguish target from implemented.

## Plan interpretation

P0 is specification acceptance, not a production deployment gate. Do NOT require actual production
cutover or complete platform implementation to finish P0-01/03: their original acceptance requires
traceability/actor matrix and documented legacy field/status/result keep/change/defer decisions.
Use executable local characterization where possible; do not invent production prerequisites.
Conversely P0-05/06 remain under review until inaccurate corpus/workload claims are corrected.
P5-10 stays PARTIAL (SHIMMED); P7-03..07 blocked on typed continuation; P6/P8 later, P9 out of scope.
The auth slice is verified, but does not close all P2 permissions/profile/isolation acceptance.

## Claude Code: W11-C1 - finish the current blocker, do not restart planning

Ownership unchanged: platform, SDK, contracts, shared integration/infra; narrowly authorized
Connector canonical-hash implementation and related tests. No Antigravity business/doc-kit edits.

1. Record current auth completion and next work in reports/claude.md now (stale wave05).
   Add missing-config and equal admin/runtime token configuration regression coverage; reject
   unsafe equal credentials rather than imply role separation is guaranteed by field names.
2. Finish W10-C1 canonical hash + stable logical invocation identity. Same task/step/generation/
   input replay returns the same identity, concurrent issuance cannot duplicate it, conflicting
   input fails. Enforce active nonexpired lease and pinned profile slot/revision.
   UNKNOWN/lost response must not become a fresh blind invocation.
3. Publish consumer contract and commands in your report when ready. Antigravity then owns shim
   removal; do not edit its tests yourself.
4. Continue existing artifact/bootstrap fixes, then typed children/wait/resume APIs and tests
   (W09-C2). Publish a small working milestone before expanding to UI/release work.

For each milestone report changed files, exact test results and still-open cases. Do not dispatch
to more agents or claim completion from accepted terminal prompts.

## Antigravity: W11-A1 - parser limits and specification accuracy, runnable now

Ownership unchanged: document-core, example-review, document-kit, own report/request.

1. Correct timeout API and claims. Factory wait timeout != execution cancellation. Document that
   accurately, validate finite positive timeout and finite nonnegative/integer byte budgets as
   appropriate to the selected contract. Ensure direct-parser behavior is explicit and consistent.
   Add deterministic tests for invalid values, timer cleanup, late parser completion after timeout,
   and no caller-visible success after timeout. Do not claim hard CPU/memory bounds without actual
   isolation. If hard cancellation needs worker isolation, report that as separate pending work.
2. Check business parser call sites propagate configured limits; add consumer tests if they do.
   If no profile/config budget exists, state that gap instead of inventing production defaults.
3. Fix synthetic-corpus-policy.md masks, real fixture/test references and per-variant coverage
   levels (unit vs six-action shimmed integration). Do not claim all 28 live cross-service cases.
4. Fix workload-assumptions.md per-row status/source/owner: proposed retention sweeps, PDF pages,
   spreadsheet rows, storage size and tenant controls must not read as implemented enforcement.
5. Reconcile P0-01/03 against ORIGINAL tasks/P0-business-specs.md acceptance, not a new production
   cutover requirement. Produce a concise evidence table for coordinator to approve; do not edit
   central tasks/gates. Keep desired behavior separate from current implementation.

## Antigravity: W11-A2 - dependent work only after Claude publishes contract

Remove pendingHashes/custom GrantVerifier mutation and rerun semantic six-action/retry tests
against unchanged signed grants. No replacement bypass. Keep PARTIAL if canonical contract absent.
Then use published typed continuation for real join/HITL tests; no invented TaskContext methods.
Do not wait idle on these dependencies while W11-A1 remains actionable.
