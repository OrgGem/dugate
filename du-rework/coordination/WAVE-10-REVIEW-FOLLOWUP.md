# Wave 10 - verified review and focused follow-up (2026-09-21)

This packet refines the immediate execution order of wave 09, without cancelling unfinished
FIX-07/08 or weakening acceptance. Preserve the shared dirty checkout. No broad staging,
reset, cleanup, or unrelated edits. Continue the existing sessions.

## Independent verification

Coordinator reran:
- document-core: pnpm --filter @du/document-core test -- --runInBand tests/multi-container-e2e.integration.test.ts: 8/8 PASS.
- document-kit: pnpm --filter @du/document-kit test -- --runInBand tests/limits-boundary.test.ts: 19/19 PASS.
These are focused results, not a new whole-workspace certification.

Antigravity added six-action HTTP integration and three P0 documents. Acceptance remains PARTIAL:
- The restart test merely starts a second worker and GETs an already completed invocation.
  It does not stop the original worker, interrupt execution, redeliver a task or prove recovery.
  The adjacent replay test is a GET lookup, not repeated invocation.
- E2E still replaces signed inputHash via pendingHashes/custom GrantVerifier.
- Five additional action tests mostly assert SUCCEEDED/resultRef (and usage for provider actions),
  not actual returned business output. The mock provider returns invoice-shaped data.
- traceability-matrix.md changes UC-08 from lost provider response/UNKNOWN to lease fencing.
  UC-06 also omits the planned parallel/human-input continuation. Keep canonical meanings.
  Claimed admin/runtime separation and artifact validation are desired controls, not implemented facts.
- limits-boundary.test.ts passes 19 tests but its bounded-parser section tests small fixtures,
  not memory ceilings, parser timeouts or oversize rejection.
- Claude report is still wave 05; grants.ts still creates random invocationId per request,
  and server.ts still falls back from unknown API keys to the default tenant.
  No completion credit for wave 07-09 platform fixes is supported by those inspected sources.

## Claude Code - W10-C1, immediate blocking platform slice

You are implementation owner, not coordinator/delegator for this packet.
Own existing platform/SDK/contracts/integration paths. Additionally you may change ONLY the
Connector canonical-hash contract implementation and its directly related tests as needed;
do not refactor unrelated Connector functionality. Antigravity does not edit those paths.

1. FIRST close fail-open authentication (R08-01): unknown/revoked keys denied, no production
   dev fallback; admin/runtime credentials cannot substitute for each other. Regression tests.
2. NEXT publish canonical invocation hashing across SDK, grants and Connector, and persist
   stable identity for the same logical task/step/generation/input. Validate pinned binding,
   active lease/state/expiry; conflicting input must fail. Prove duplicate grant/request delivery
   does not create a new provider invocation. UNKNOWN after lost response must not be blindly
   retried as a fresh invocation.
3. Update reports/claude.md immediately with actual current task, changed files, commands and
   remaining blockers; replace stale wave05 claims. Publish consumer contract/test instructions
   there so Antigravity can remove its shim.
4. Continue remaining W09-C1 artifact/bootstrap fixes, then W09-C2 typed child/wait continuation.
   Do not start Admin UI/release breadth before these dependencies pass.

Do not edit Antigravity business tests or reports. Run them read-only as consumers as appropriate.
Keep central task statuses evidence-based; use this snapshot when reconciling wave09 claims.

## Antigravity - W10-A1/A2, independent work now

Keep ownership: businesses/document-core, businesses/example-review, packages/document-kit,
your own report and requests. No platform/SDK/Connector or central task/gate edits.

W10-A1: Strengthen integration assertions and correct test claims.
- Read each action's result artifact and assert meaningful schema/content: classification,
  summary, parsed text, actual redaction absence of original PII, nonempty expected diff.
  Make mock provider responses action-appropriate; assert per-operation provider/ledger/usage
  counts, including no provider calls for native cases.
- Scope ledger queries to the operation created by each test, not global latest row or test order.
- Rename current GET/restarted-idle-worker tests truthfully. Implement actual interrupted-task
  recovery with deterministic failure barrier and evidence that work was redelivered/reclaimed,
  checkpoints reused, provider count stable. If runtime cannot support it, report the precise
  missing API/state transition and keep this scenario BLOCKED, not a passing substitute.
- When Claude publishes canonical hash, remove all hash replacement and prove unchanged signed
  claims verify. Until then mark the suite explicitly shimmed and P5-10 PARTIAL.

W10-A2: Correct P0 evidence.
- Restore UC-01..08 definitions from docs/01-product-scope.md, especially UC-06 and UC-08.
- Separate planned authorization/TTL/isolation guarantees from verified implementation.
  List actual test names/files, verified scope, missing coverage and owner per requirement.
- Validate that every linked test/file exists. Add concrete legacy handler references and
  executable characterization evidence or explicitly mark P0-03 partial.
- Replace bounded-memory claims with actual tested guarantees. Add deterministic oversize/
  timeout budget tests and implementation within document-kit where scoped and specified;
  do not invent arbitrary production limits or claim memory bounds from small-fixture tests.
- Update your report to distinguish implemented, verified, planned and blocked.

Then resume W09-A3 only once typed child/wait API exists. Do not invent TaskContext extensions.

## Exit / status

Subsequent user-requested resend SUCCEEDED: Claude accepted request
abb5d2d7-44ba-4a52-87f8-eb63251dd25e with input_accepted AND turn_started.
Existing terminal term_2ab5a374-94b4-4c30-ae04-cbc8f2fa2941 in D:/Git/dugate
was reused. W10-C1 is now delivered and started; the failed attempts below are historical.

Dispatch: Antigravity accepted request 82157e7e-b821-4597-9287-b0672fe5c078;
terminal preview subsequently showed the new prompt and Generating. Existing session reused.
Claude terminal reports connected/writable and tui-idle, but two sends returned accepted=false,
bytesWritten=0 (requests cfeadf04-5ba1-4bd2-9712-64213fd72571 and
02baaf13-2461-428c-83b9-3de2930d2c01). W10-C1 is prepared, NOT delivered.
Do not mistake terminal presence or earlier wave receipts for acceptance of this packet.
No session was interrupted, closed or replaced.

No P0/P5/P7 promotion in this review. Six-action happy paths are progress, not full replay,
security or extension proof. P6/P8 remain pending platform prerequisites; P9 out of scope.
