# Wave 12 - integration regression and grant closeout (2026-09-21)

Dispatch in existing D:/Git/dugate sessions:
- Claude term_2ab5a374-94b4-4c30-ae04-cbc8f2fa2941: accepted and turn_started,
  request 5d2937d8-3a69-409e-90fc-706f0f66aaf2.
- Antigravity term_d7692e4e-e693-4b08-a91f-26abfbcc78d3: accepted,
  request c3f5b1d8-b57c-4706-86b6-76374affdca8 (provider lacks turn_started receipts).

Latest focused audit; previous packets remain backlog, not completion evidence.
Preserve dirty shared edits. No reset/clean/broad staging. Existing sessions only.

## Independently executed
- pnpm --filter @du/orchestrator test -- --runInBand: 20 PASS.
- pnpm --filter @du/document-kit test -- --runInBand: 77 PASS (6 suites).
- pnpm --filter @du/document-core test -- --runInBand tests/multi-container-e2e.integration.test.ts:
  9 FAIL, all blocked in beforeAll at enableResp status 401 (line 299).
97 passing tests do NOT imply green integration. Historical 9/9 PASS is superseded.

## Verified deltas
Claude: distinct-token boot rejection and stable logical grant ID/input-hash conflict tests exist.
SDK task-context.ts now uses hashInvocationInput. Do not continue waiting solely because the
Claude report is stale (still wave05). Canonical consumer compatibility needs unshimmed execution.
Antigravity: parser validation, direct parser wait wrapper, cleanup/late completion tests are
implemented; 77 document-kit tests pass. This closes W11-A1 parser wait-contract work,
not hard execution cancellation or propagation of budgets from profiles.

## Current gaps
1. E2E createApp has no adminToken and enable request uses runtimeToken. New fail-closed behavior
   correctly rejects this. Use independent admin credential; seed a real hashed API key in test
   setup as required by current auth. Do not weaken auth or use enableVersionForTest.
2. grants.ts checks epoch and RUNNING state but does not load/check lease expiry. An expired lease
   that has not been swept/reclaimed can still request a grant.
3. Empty declaredSlots allows ANY requested binding. Manifest slots are not a pinned profile
   binding; connector identity/revision still comes from global opts.
4. Stable ID concatenates task|step|slot, omits generation, and uses delimiter encoding. Document/
   test exact logical identity semantics and use unambiguous serialization. Do not invent a
   generation field unless reconciled with existing contracts/checkpoint lifecycle.
5. P0 evidence still inaccurate: compatibility matrix references nonexistent
   lib/pipelines/executor.ts and lib/db/operations.ts. New-business tests do not by themselves
   characterize legacy handlers. workload-assumptions marks schema depth unenforced despite
   SchemaValidator.MAX_DEPTH=5 and marks profile binding implemented based only on SHA256 lookup.
   Do not approve all G0 merely from the report.

## Claude - W12-C: finish grant security milestone, then continue prior plan
Own platform/SDK/contracts/shared integration/infra and narrowly scoped Connector hash tests.
Do not edit Antigravity business/tests/docs.

- Update reports/claude.md now with actual current changes, unfinished work and exact consumer
  hash contract (export/package, canonical fields, supported options). Report ongoing work too.
- Close gaps 2-4 with integration tests: expired lease before sweep, zero slots denied,
  unauthorized slot/profile revision, concurrent same-request grant issuance, conflict input,
  legitimate checkpoint-generation semantics, cancelled/terminal operation.
- Keep UNKNOWN/lost-response reconciliation from becoming a new blind provider call.
- Run SDK/Connector contract tests and shared integration suite, adapting YOUR fixtures to new auth.
  Antigravity owns its E2E fixture and unshimmed consumer verification.
- Once this milestone passes, continue existing artifact lifecycle/bootstrap/separate migration,
  then typed child-results/wait/resume. No UI/release expansion ahead of these gates.

## Antigravity - W12-A: repair integration now, then targeted P0 corrections
Own document-core/example-review/document-kit and own reports/requests. No platform changes.

Priority 1: fix E2E setup credential contract as described in gap 1. Inspect current
SDK task-context.ts and shared hash export READ-ONLY: canonical implementation is now present.
Remove pendingHashes/custom GrantVerifier claim replacement and run unchanged signed grants.
If mismatch remains, report concrete canonical fields and failing test to Claude; do not add a bypass.
Retain semantic six-action and retry/checkpoint assertions. P5-10 stays PARTIAL until its full
original row (facade parity/checkpoint/version matrix included) has evidence, not just nine tests.

Priority 2: validate EVERY compatibility source path/symbol against legacy source. Replace false
references and distinguish observed legacy behavior from proposed changes. New-only matrix tests
must not be called legacy characterization. Add a small local characterization/alias fixture
table grounded in the legacy handlers; no production deployment prerequisite.
Correct schema-depth and key/profile-binding claims in workload docs using actual source.
Check source_file/target_file string mapping claim against InputNormalizer (it currently casts
the value to an object): either fix the supported alias and test it or mark explicitly unsupported
according to original facade plan. Do not silently change required compatibility.
Deliver a P0 acceptance evidence table with only remaining gaps, not another blanket DONE report.

## Plan status
W11 parser wait-contract slice VERIFIED. Auth core and stable grant identity slice VERIFIED.
P0 remains IN REVIEW for factual corrections; P5-10 REGRESSED/PARTIAL; P7 continuation BLOCKED.
Do not reimplement accepted parser work. P6/P8 queued; P9 excluded.
