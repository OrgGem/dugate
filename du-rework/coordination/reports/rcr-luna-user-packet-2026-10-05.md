# RCR Luna user packet — 2026-10-05

User request: call Luna sub-agents at max reasoning to handle RCR-01..06 from `orchestrator-app-core-review-2026-10-05.md`.

**Current result:** all six findings have implementation candidates and a green independent offline regression run: **7 suites, 229/229 tests, exit 0**. Independent `pnpm exec tsc --noEmit -p tsconfig.json` also exited **0**, without output. Runtime and HTTP product write leases are released. Parent confirmed the released product hashes still match. This is scoped offline verification, not release acceptance.

Three native sub-agents were started with `gpt-6-luna`, reasoning `max`: `/root/rcr_http_luna`, `/root/rcr_runtime_luna`, and `/root/rcr_verify_luna`. This is a user-owned packet, not a second Orca dispatcher or schedule. The Command Code coordinator remains the ledger owner; no task rows, active ledger, watch-state, commits, or release gates are changed by this packet.

## Ownership and handoff

The existing coordinator had already dispatched RCR-HTTP to cc_1 (`ctx_162171357e12`, `task_0a7e017eb66e`) and RCR-RUNTIME to dsh_1 (`ctx_505e2ce3892b`, `task_fa1463127729`). Native Luna agents began read-only diagnosis and independent verification to avoid overlapping writes. Coordinator notified through `msg_60581e46c3af`; subsequent diagnosis notes sent in `msg_970354146a41`.

cc_1 published `rcr-http-2026-10-05.md`, completed focused/regression tests, and reached an idle terminal with an explicit credit error. This is positive completion evidence rather than an assumption from silence. Its receipt leaves a delivery-encryption residual in the restored legacy download adapter. The user lane notified cc_1 to hand off that slice and coordinator through `msg_9fed6b8ec384` (enqueue receipts do not prove recipient consumption).

| Native lane | Write scope | Acceptance |
|---|---|---|
| HTTP Luna | `services/orchestrator/src/http/routes/public.ts`; new `tests/rcr-luna-http-encryption.test.ts`; own report | Legacy raw download obeys authenticated tenant delivery policy; encrypted envelope has JSON headers, no plaintext fallback; disabled policy preserves exact bytes; denied tenant cannot read content |
| Runtime Luna | Released runtime source/routes, additive metadata slot, new migration 0032, own report (implemented and released) | RCR-02 live lease/business/epoch fence and rollback; RCR-04 schema default/422; RCR-05 durable encrypted sessionRef save→claim |
| Verify Luna | New `tests/rcr-luna-verification.test.ts`; narrow existing metadata slot-inventory test refresh; own report/raw output | Independent focused source-path tests for all six; distinguish offline evidence, skipped/live gaps, and source drift |

Runtime owner notified in `msg_575b3050b416` and one terminal prompt; its exclusive product write lease remains in force. Other source paths and existing tests are read-only for native Luna. Each editor must re-read current files before a narrow edit and preserve the dirty tree.

## Handoff evidence (chronological)

- HTTP diagnostic: `rcr-http-luna-2026-10-05.md`.
- Runtime diagnostic: `rcr-runtime-luna-2026-10-05.md`.
- Independent verification: `rcr-luna-verification-2026-10-05.md` (baseline recorded; candidate verification pending).
- Candidate snapshot, exact digests, commands, raw output, and residual results will be appended after implementation and verification.

Current status: HTTP residual implementation and independent tests in progress; runtime fixes still owned by dsh_1. No ACCEPTED claim. Offline tests do not replace PostgreSQL/Redis/Vault/storage or deployment acceptance evidence and the required independent reviewer verdict.

Baseline verifier observation: the new test suite compiles and executes seven cases, with three passing (durable child replay and two raw download paths) and four failing on the pre-fix runtime (expired spawn, expired wait, missing default status, and dropped sessionRef). These are defect characterization results, not a completed green verification. Wrong-business, stale-epoch, and write-time expiry rollback cases are being added. Runtime owner notified through `msg_85155f71f712`.

Extended baseline: two suites, sixteen tests, eight passing and eight failing against unchanged runtime digest. The expanded failures cover expired spawn/wait, foreign business, write-time lease expiry/rollback, missing default status, and dropped sessionRef. Raw output: `rcr-luna-verification-baseline-2026-10-05.raw.txt`. A dirty `git status` does not indicate a new candidate; the verifier confirmed the runtime SHA-256 still matched the review baseline.

HTTP Luna completed the delivery-policy follow-up and explicitly released `public.ts`. Focused run: three suites / 57 tests passed, exit 0; TypeScript exit 0. Candidate source SHA-256: `422DB30E924DB063C30405B26BE73CCC867CE4E4DEDE8E344B411A169CBB057C`. See its receipt for exact commands and test hash. The original HTTP owner authored the RCR-01/03/06 base fixes; Luna authored the policy follow-up and its regression suite.

Runtime handoff request superseded the earlier finish-then-release request: dsh_1 was asked to pause safely before product edits and explicitly release its write set to native runtime Luna. Coordinator notified in `msg_29474381db7a`. Until positive release evidence, runtime Luna remains read-only. No silence-based lease revocation.

Positive release subsequently observed in `rcr-runtime-2026-10-05.md`: dsh_1 explicitly states RELEASED, zero product edits, and the released source paths/hash pins. Native runtime Luna resumed as the sole product editor for `runtime.ts`, `http/routes/runtime.ts`, the additive metadata session slot, and new `0032_checkpoint_session_ref.sql` (subject to rechecking allocation). No existing verifier test edits are permitted. Coordinator notified in `msg_d958e29cf365`. The earlier waiting status is historical; runtime implementation is now active in the native Luna lane.

## Current six-finding matrix

| Finding | Resulting behavior required | Current evidence |
|---|---|---|
| RCR-01 | Malformed request cannot escape listener error boundary; next request still answers | Base HTTP fix + listener tests green |
| RCR-02 | New spawn/wait requires business, epoch, RUNNING, and live DB-clock lease; expiry at transition rolls back; exact durable replay retained | Independent final offline regression green |
| RCR-03 | Scoped same-body idempotent retry precedes current admission; different body still 409, foreign scope does not replay | Base HTTP fix + scoped submission tests green |
| RCR-04 | SaveStep schema default applies; invalid payload rejects 422 before transaction | Independent final offline regression green |
| RCR-05 | SessionRef survives save→claim under metadata encryption, full checkpoint AAD, compatible null/absent history; latest generation first | Independent final offline regression green |
| RCR-06 | Exact output bytes reach wire; tenant delivery policy protects plaintext; unavailable crypto fails closed | Base bytes fix + native policy follow-up and focused tests green |

This table describes the user packet only. Release acceptance remains with the current coordinator/reviewer gates.

The runtime ordering decision was narrowed using the actual consumer: `packages/worker-sdk/src/task-context.ts:378,420` uses the first checkpoint matching a step key, and `connector-session.ts:293-294` restores its sessionRef. Claim now keeps all rows but orders `step_key, generation DESC`, so restart reads the latest generation first. No shared DTO or SDK edit. The verifier's scripted DB sorts only when the production query requests it, making the multiple-generation regression sensitive to removal of that ordering.

Verifier also owns a narrow test-only refresh of the two obsolete slot inventory assertions in `tests/runtime-encryption-metadata.test.ts`. The pre-packet source already had result/prompt slots while those assertions still expected four slots and no result_ref. The refresh names the current slots plus new session_ref; cryptographic negative coverage is retained.

Native runtime reports complete/frozen source and migration, TypeScript exit 0, lease-fencing 33/33 and runtime metadata sentinel 10/10. Independent final verification on the frozen candidate is in progress. Parent inspected the new read-side guards, write-side CAS/rollback, save schema/default, encrypted save/claim binding, additive migration, and route identity plumbing; no new defect found in those paths. `git diff --check` on changed tracked product/test paths exited 0 (line-ending warnings only).

## Final independent test run

Command (cwd `D:\Git\dugate\du-rework\services\orchestrator`):

`pnpm exec jest --runInBand --runTestsByPath tests/rcr-http-offline.functional.test.ts tests/rcr-luna-http-encryption.test.ts tests/rcr-luna-verification.test.ts tests/rv01-loopback-http-offline.test.ts tests/runtime-lease-fencing-offline.test.ts tests/runtime-encryption-metadata.test.ts tests/migrations-ledger-guard.test.ts`

Result: **7 suites passed, 229 tests passed, exit 0**. Raw output: [candidate test output](rcr-luna-verification-candidate-2026-10-05.raw.txt). Jest prints its existing open-handle warning after one second; it exits normally, without `forceExit`. This packet does not claim to fix that test cleanup warning. Raw typecheck output: [candidate typecheck output](rcr-luna-verification-candidate-tsc-2026-10-05.raw.txt).

Independent final receipt: [rcr-luna-verification-2026-10-05.md](rcr-luna-verification-2026-10-05.md), SHA-256 `8DB5284C1EB4CE85A2413A7DEDBFF4BBD46591FA7808A9AA44475FA0BA47AED3`. It records **0 skipped**, source/test fingerprints, exact commands, and raw artifact hashes. Verification/test ownership was explicitly released. Completion was enqueued to the existing coordinator as `msg_c42b0726b140`; enqueue is not an acknowledgement or acceptance verdict.

Deployment follow-up: apply `services/orchestrator/migrations/0032_checkpoint_session_ref.sql` using the normal migration rollout before running the new code. No migration was executed against a real database here. PostgreSQL rollback/lease timing, Vault key behavior, storage delivery and worker restart integration still require live acceptance evidence. Required reviewer APPROVED and coordinator acceptance remain separate. No commit, push or deployment was performed.
