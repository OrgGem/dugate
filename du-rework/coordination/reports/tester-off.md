## LEASE-AUDIT-803 - fleet lease and commit audit (2026-10-05)

**Dispatch:** task_5015268590d1 / ctx_6ba1e17111b3 / run_069ecd6957cd. **Scope:** read-only audit; this new receipt is the only file written by this lane. **Verdict:** one shared receipt target was found between the two tester lanes and escalated immediately; coordinator adjudication A9 split the write targets. After A9, no duplicate active file lease was found, and no commit was created during this run.

### State snapshot and Git

Read coordination/agent-watch-state.json and coordination/coordinator-state.json in the du-rework project. Agent watch reports updated=2026-10-05T04:56:26+07:00 and round804b at 04:56:26; its legacy lastCheckedAt field remains 03:26:02, so I used the current Run task list as the live status source. Coordinator state last_tick is 04:56:01 and records adjudication_A9. The live task-list for run_069ecd6957cd returned 181 tasks: 170 completed, 3 failed, 6 dispatched, and 2 ready.

HEAD is b088eececcb5f3df0b4edbe073a29401dafda624 (expected prefix b088eec). git log since 2026-10-04T00:00:00+07:00 returned no commits; the latest reflog entry is that same HEAD at 2026-10-02T14:27:29+07:00. The index is empty (git diff --cached --name-only returned no paths). git status is not clean and shows broad existing modified/untracked work across the shared checkout; status alone cannot attribute those paths to this run. No reset, stage, commit, or push was performed for this audit.

### Dispatched and ready file scopes

The active write target means the exact path/pattern declared by a dispatched task. Receipt and generated verification artifacts are listed separately as that task's output paths. The two ready tasks are not currently editing files.

| File or write scope | Lane | Task | In declared lease? | Outside lease observed? |
|---|---|---|---|---|
| docs/04-data-state.md:102 only, plus A8 receipt/validator artifacts | codex_arch | task_73a006598be3 (dispatched) | Yes; one-claim docs edit | No |
| coordination/reports/tester.md §VFY-803; source verification only | codex_tester_live | task_a02a97db2a6e (dispatched) | Yes, retained by A9 | No |
| Disposable PG restore rehearsal; migration-0032-restore-rehearsal receipt and raw logs; no product file lease | qwen_1 | task_538601995d62 (dispatched) | Yes | No |
| Read-only source inventory; encmeta-window-design receipt only | dsh_3 | task_b41da4599f3f (dispatched) | Yes | No |
| Read-only source/settings gap design; settings-writer-design receipt only | codex_worker_1 | task_9cf1ec6660c6 (dispatched) | Yes | No |
| Read-only fleet audit; coordination/reports/tester-off.md §LEASE-AUDIT-803 | codex_tester_offline | task_5015268590d1 (dispatched) | Yes, per A9 | No |
| services/orchestrator/src/http/bff, related admin routes/tests; admin-web only after ACK; identity-bff-routes receipt | dsh_2 | task_42bb7c8166a1 (ready) | Yes, but not active | No |
| packages/contracts settings/identity exports; services/orchestrator/src/app/admin/bff settings.ts, identity.ts, handle.ts; tests and bff-settings-identity receipt | dsh_2 | task_6fa1b100409c (ready) | Yes, but not active | No |

The ready tasks belong to the same dsh_2 lane and have not started; the settings/identity task explicitly composes the identity route work. They therefore do not create concurrent writers. No other product-file overlap appears among the six dispatched scopes.

### Duplicate receipt target and resolution

Before resolution, task_5015268590d1 requested appending LEASE-AUDIT-803 to coordination/reports/tester.md, while dispatched task_a02a97db2a6e requested appending VFY-803 to the same tester.md. Different sections still share one file, so I reported it immediately by escalation msg_b0312492c7ee and deferred that write. Coordinator response msg_6bdcad719bad / adjudication_A9 at 04:56:01 explicitly assigns tester_live to tester.md and tester_offline to the new tester-off.md; existing tester.md sections stay in place. This receipt follows that resolution.

### Worker completion payloads versus receipts

Queried the latest 500-message inbox window for run_069ecd6957cd and cross-referenced worker_done payload task IDs with the Run task specs. It contained 30 worker_done messages; 20 had a non-empty filesModified list. Every declared modified path and every supplied reportPath resolved to an existing file across the workspace/project roots checked; no missing report or payload file was found. Source/doc paths matched the task's named write scope, and the remaining files were the specified receipt, raw log, validator, snapshot, diff, or screenshot outputs. No outside-lease file was detected in this bounded inbox sample.

Representative checks: task_73a006598be3 listed docs/04-data-state.md and its A8 report/validation artifacts, matching the one-claim lease; task_31b00c61a6c4 listed only docs-screen.tsx and its receipt, matching apps/admin-web/src/features/docs/**; task_0d4dd38898e6 listed acquisition-ref-resolver.ts, main.ts, its test, receipt, and raw log, matching its file-url-auth plus related-file/main/test scope; task_fa67a1eded62 listed the three named traceability docs plus its report/validation artifacts; task_b26e9232f603 listed only worker-sdk fan-out source and test, matching its R4 implementation target. This checks declared paths and receipt presence, not byte-level attribution of every pre-existing dirty worktree file.

### Scope limitation

The worker_done comparison is bounded to the latest 500 messages returned by Orca inbox, not every historical message in the Run. Git status is a shared dirty-tree snapshot with no per-lane attribution; ownership conclusions above come from current dispatched/ready task specs and the worker_done path declarations. No commit appeared in HEAD, git log, or reflog for this run.

## VFY-LEFTOVER-COUNTER-806

**Dispatch:** task_6d551b2fcb9b / ctx_29a6d05b10fd / run_069ecd6957cd. **Mode:** independent verification, product source read-only. **Verdict:** the counter is an exhaustive aggregate over its eight declared METADATA_SLOTS columns, not a sample. The disposable PG16 rerun changed counts with a different seed and showed identical table row counts and full-row fingerprints before/after the counter. Two open findings remain: the SQL's read-only setting does not make the current transaction read-only, and outbox_payload is an ENC09 kind that the current metadata gate reports separately without classifying as plaintext/sealed.

### PG16 run and seed delta

Started a new PG16 container with loopback-only host port and tmpfs storage, applied the orchestrator's 32 migrations (literal exit 0), inserted fixture rows only, ran coordination/backfill-leftover-counter-803.sql (literal exit 0), and removed the task-owned container (cleanup exit 0). No project or live database was contacted. This is a new seed relative to BACKFILL-LEFTOVER-COUNTER-803: prior seed counts were operations=4, tasks=4, human_waits=3, step_checkpoints=4, outbox=1; seed-806-b counts were operations=5, tasks=6, human_waits=4, step_checkpoints=7, outbox=2.

| Slot | total_rows | non_null | sealed | leftover_plaintext | empty_object |
|---|---:|---:|---:|---:|---:|
| operations.input_ref | 5 | 5 | 2 | 3 | 1 |
| tasks.payload_ref | 6 | 6 | 2 | 4 | 2 |
| human_waits.response_ref | 4 | 3 | 1 | 2 | not reported |
| step_checkpoints.output_ref | 7 | 5 | 2 | 3 | not reported |
| step_checkpoints.session_ref | 7 | 6 | 2 | 4 | not reported |
| operations.prompt_overrides_ref | 5 | 4 | 1 | 3 | 1 |
| tasks.result_ref | 6 | 4 | 1 | 3 | not applicable |
| operations.result_ref | 5 | 4 | 1 | 3 | not applicable |

All eight coverage rows returned covered. The gate result was total_leftover_plaintext=25, total_empty_object=4, actionable_leftover=21, GATE FAILS, literal exit 0. These changed with the new fixture from the prior disposable result (leftover=10, empty=2, actionable=8). Seed-806-b also put one empty object in step_checkpoints.session_ref; its slot query counts it as leftover, while the gate supplies zero for that slot's empty-object subtraction, so it remains actionable. That is conservative over-counting, not a false clearance.

### Full-table and independent count evidence

Inspected the unchanged SQL file directly: LIMIT tokens=0, OFFSET tokens=0, top-level WHERE=0. Each slot query uses count(*) from the full containing relation; classifications are aggregate FILTER predicates, not a row-sampling predicate. The separate outbox report also counts the full outbox relation, and the gate recomputes slot counts over full-table UNION ALL branches.

Independent reconciliation output was sum_slot_count_star=45, sum_slot_non_null=37, independent_slot_total=45, distinct_table_rows=22. Thus the sum of each slot's count(*) agrees with the independently calculated 5*3 + 6*2 + 4 + 7*2 = 45; the 22 unique table rows are operations + tasks + human_waits + step_checkpoints. The non-null sum also agrees with the per-slot output.

Before/after snapshots included each complete row serialized to JSON inside an MD5 fingerprint, plus table row counts; only counts and digests were printed. The exact result was:
- human_waits: 4 / c4ab7e199a2cb4497e66a5c87e657629 both before and after
- operations: 5 / 5eae569b581afdee2ac72f6e4f8ee239 both before and after
- outbox: 2 / a28e45d481c27a91cce1f0a29275d5f5 both before and after
- step_checkpoints: 7 / 474f019c6dc9ecccbb33b5d44544c187 both before and after
- tasks: 6 / f9e552c5b6029de76b7a6a8a7c2bcc67 both before and after
- tenants: 1 / 99f5cac4ede479e72aafd271826d1de7 both before and after
Final comparison: BEFORE_AFTER_COUNTS_AND_FULL_ROW_HASHES_IDENTICAL=True. Fixture INSERTs happened before the baseline snapshot in the throwaway database; the counter changed no seeded value or row.

### Read-only enforcement finding

The SQL has BEGIN followed by SET LOCAL default_transaction_read_only=on. On PG16, the direct control returned transaction_read_only=off and default_transaction_read_only=on (literal control output: BEGINSEToff|onROLLBACK). The counter still exited 0 and its statements are SELECT/COUNT only, but the advertised setting does not protect the already-open transaction against a future accidental write. OPEN FIX: use SET TRANSACTION READ ONLY immediately after BEGIN (and assert transaction_read_only=on), or set the default before opening the transaction. No SQL/source fix was made in this verification.

### Outbox kind and gate scope

legacy-payload-migration.ts:12 registers outbox_payload in ENC09_PAYLOAD_KINDS. metadata-crypto.ts:44-62 defines the eight METADATA_SLOTS and does not include outbox.payload. However, operations/submission.ts:155-168 confirms the outbox BusinessJobV1 may contain sourceUrl: when MetadataCrypto is composed that field is sealed with the tasks.payload_ref / root-task binding; with no crypto seam it passes through as the historical plaintext string. The existing counter section 9 returned outbox total_rows=2, job_envelope_rows=1, other_rows=1, but section 9 is informational and section 10 does not gate on it; it does not inspect the nested sourceUrl value to distinguish plaintext from an envelope.

Conclusion: outbox_payload is an ENC09 kind and must have an explicit status in the broad ENC09 completeness/retirement gate. It is not one of the eight metadata-column slots, so it needs an outbox-specific classifier/gate rather than being silently omitted from all acceptance. The current query does not prove outbox payloads are sealed or safe; its contractVersion count is not that proof.

### Backfill and window wiring search

Repository production-code grep excluded tests, specs, dist, and node_modules and covered services, packages, and apps. Matches were only declarations in services/orchestrator/src/modules/encryption/legacy-payload-migration.ts: backfillLegacyPayloads at line 324; createBoundedDualReadWindow at line 507; ResultRefPgMigrationStoreOptions / class declarations at lines 771 / 798. There was no production new ResultRefPgMigrationStore call, backfillLegacyPayloads invocation, or createBoundedDualReadWindow call. The options.window field at line 780 is optional, and windowOpen at line 867 returns true when no window was passed. Therefore the store, backfill orchestration, and bounded-window creation/enforcement are not wired in production; this run did not simulate a successful production backfill.

**Offline-provable:** fresh schema on disposable PG16; the changed synthetic seed; full-table aggregate outcomes; independent slot arithmetic; pre/post counts and row fingerprints; source-level absence of production backfill/window callers; outbox enum/writer shape; the ineffective current-transaction read-only setting. **Live-only / not run:** production database counts, production-scale scan cost, real outbox backlog and feature-flag mix, Vault-backed envelope correctness across existing rows, operational maintenance window/replica behavior, and any production backfill or retirement decision.

## VFY-ENVELOPE-INTEGRITY

**Dispatch:** task_2f3e29ee7096 / ctx_6fe42ce0e132 / run_069ecd6957cd. **Mode:** independent offline verification, no product-source or counter-SQL edits. **Verdict:** CONFIRMED — the shape predicate counts broken AES-GCM envelopes as sealed and the full-table gate false-passes; it does not authenticate ciphertext, tag, or tenant/AAD binding.

### Isolated PG16 fixture and real crypto path

Created a fresh PostgreSQL 16.10 container named `du-vfy-envelope-integrity-2f3e29ee`, using tmpfs for `/var/lib/postgresql/data` and loopback-only port `127.0.0.1:58417`; no existing project/PG container or project database was used. The database was freshly migrated with `pnpm --filter @du/orchestrator migrate`: **literal command exit 0**, 32 migrations applied and migration verification passed; TypeScript build ran as part of this command. The probe loaded the compiled current `createMetadataCrypto` and actual `adaptKeyProviderForMetadata`; AES-256-GCM sealing/opening used the real Node crypto implementation. The key-provider was a local reversible test stand-in, not Vault.

Inserted four operation rows into `operations.input_ref`: one valid envelope and three shape-preserving invalid envelopes. Ciphertext and tag variants were made by flipping one decoded byte and re-encoding; the AAD case was sealed using a different tenant ID, then placed in the target tenant's row while retaining the row's slot/ref ID. The reader test used the row's actual `tenant_id`, `operations.input_ref` slot, and operation ID.

| Fixture | Shape test | Actual `readStored` result |
|---|---|---|
| Valid envelope | true | Opens successfully |
| Ciphertext byte flipped | true | `AUTHENTICATION_FAILED` |
| GCM tag byte flipped | true | `AUTHENTICATION_FAILED` |
| Envelope bound to other tenant/AAD | true | `CONTEXT_MISMATCH` |

### Counter result and raw output

Ran the unchanged `coordination/backfill-leftover-counter-803.sql` against the disposable database. Its query completed successfully (the harness exit was 0); it emitted no authentication/context error because it never decrypts. The exact `operations.input_ref` result was total_rows=4, non_null=4, sealed=4, leftover_plaintext=0, empty_object=0. The final gate returned total_leftover_plaintext=0, actionable_leftover=0, `GATE PASSES (full-table run, not a sample)` despite the three actual-reader failures.

Raw probe stdout (no key or plaintext printed):

```text
CRYPTO_IMPLEMENTATION=compiled current createMetadataCrypto + actual adaptKeyProviderForMetadata; AES-GCM seal/open used, local reversible key-provider stand-in (not Vault)
FIXTURE_COUNT=4; ALL_SHAPE_PREDICATE_TRUE=true
READER_RESULTS=[{"variant":"valid","opens":true,"errorCode":null,"shapeSealed":true},{"variant":"ciphertext-byte-flip","opens":false,"errorCode":"AUTHENTICATION_FAILED","shapeSealed":true},{"variant":"tag-byte-flip","opens":false,"errorCode":"AUTHENTICATION_FAILED","shapeSealed":true},{"variant":"wrong-tenant-aad","opens":false,"errorCode":"CONTEXT_MISMATCH","shapeSealed":true}]
COUNTER_OPERATIONS_INPUT_REF={"slot":"operations.input_ref","total_rows":"4","non_null":"4","sealed":"4","leftover_plaintext":"0","empty_object":"0"}
COUNTER_GATE={"total_leftover_plaintext":"0","total_empty_object":"0","actionable_leftover":"0","flip_gate":"GATE PASSES (full-table run, not a sample)"}
OPERATIONS_FULL_ROW_SNAPSHOT_BEFORE={"row_count":"4","full_row_fingerprint":"d9165f44ce6c718d48547f95715588be"}
OPERATIONS_FULL_ROW_SNAPSHOT_AFTER={"row_count":"4","full_row_fingerprint":"d9165f44ce6c718d48547f95715588be"}
ASSERTIONS=PASS reader/auth-context failures observed; counter classified all 4 as shape-sealed; gate false-cleared all 3 broken envelopes; row snapshot unchanged
probe_exit=0
```

The fixture was inserted before the snapshot. Operation row count and full-row fingerprint were identical before and after running the counter, so the counter changed no fixture data. The focused probe syntax check, migration/build command, and probe all exited 0. Counter SQL SHA-256: `872DAFD3EF769E6EF98CA2E02BE7E724A0F2C62A87F3830A9276D39F543EB2F3`. Current metadata-crypto source SHA-256: `C614ECDCFDA50EAC79A29EAC2098B92CB3BBA77280D90DDEC6F3A815A4A602A1`; key-adapter source SHA-256: `0EEF381292961B1460448819C42F6EFCA78B45E398C411CC4152C875D68ED82B`.

### What this establishes and gate recommendation

This is direct evidence that the predicate is shape-only: `createMetadataCrypto.isSealed` and SQL both accepted all four shapes, while the real reader opened only the valid one. Keep the current shape count as a fast full-table census for non-envelope/plaintext leftovers; do not treat its `sealed` count or a passing gate as proof of cryptographic integrity. For an integrity gate, attempt actual `readStored`/open on every non-null row that passes shape across each of the eight `METADATA_SLOTS`, using the production key provider and that row's tenant, slot, and ref ID; separately block on every open/authentication/context failure and on every non-shape legacy value. `outbox.payload` is outside these eight slots and needs its own classification/decrypt gate if it remains in the broader ENC09 acceptance set.

**Offline-provable:** actual AES-GCM seal/open behavior for this fixture, three failure codes, shape predicate outcome, counter false-pass, and unchanged fixture snapshot on a fresh PG16 database. **Live-only / not tested:** Vault Transit unwrapping, production key/context correctness, completeness of production rows, full production slot coverage, and operational cost of authenticating every candidate. The production-source files and counter SQL were only read; no source or SQL change, DB-project access, or commit was made. The source file already showed a shared-worktree Git delta when this task started; that delta was left untouched.

Disposable PG cleanup: docker rm -f du-vfy-envelope-integrity-2f3e29ee exit 0; confirmed absent afterward. No other container was removed.


## VFY-AUTH-GATE-808

**Dispatch:** task_1ef12cc43501 / ctx_4f9e32362abe / run_069ecd6957cd. **Mode:** independent offline verification; no product source, test, or counter SQL edits; no project DB access, commit, or tick. **Verdict:** the authenticated gate blocks every populated fixture with broken envelopes and authenticates shape-passing rows using each row's actual tenant/slot/refId across all eight slots. One edge remains: with zero non-null rows and no crypto seam, the current count function returns PASS (vacuous zero blockers); if policy requires a missing seam to fail unconditionally, that behavior remains open.

### Independent PG16 execution

Started a new disposable PostgreSQL 16.10 container, `du-vfy-auth-gate-808-1ef12cc4`, with tmpfs storage and loopback-only mapping `127.0.0.1:58419`; it was removed after the run (docker rm exit 0; confirmed absent). No existing PG container or project database was used. `pnpm run build` exited 0. With `GATE_AUTH_PG_URL` pointed only to this container, ran:

```text
pnpm exec jest --runInBand --runTestsByPath tests/gate-authenticate-808.test.ts tests/gate-authenticate-808-pg16.test.ts
Test Suites: 2 passed, 2 total
Tests:       6 passed, 6 total
independent_named_suites_exit=0
```

The PG16 test's five `tasks.result_ref` values were valid, ciphertext-flipped, tag-flipped, wrong-tenant, and plaintext. Its assertions verified slot nonNull=5, shapePass=4, sealedValid=1, sealedBrokenAuth=2, sealedBrokenContext=1, plaintext=1, shapePassAuthFail=3, and whole-run blockers=10 / gate FAIL. The extra whole-run blockers include default `{}` input/payload refs, which the gate correctly treats as plaintext.

Then created three separate migrated databases inside the same fresh container for an independent expanded fixture, a clean populated control, and an empty control. The expanded probe used the compiled current `countUnsealedWithAuth`, `createMetadataCrypto`, and actual `adaptKeyProviderForMetadata`; AES-256-GCM came from the real Node crypto path, with the suite's reversible local HMAC key-provider stand-in, not Vault. It inserted seven result_ref variants: the five baseline cases plus an envelope originally sealed for the row whose AAD field was changed to the other tenant, and an envelope sealed for a different refId. The tenant-AAD replay and refId case are distinct controls; both retain envelope shape and must fail the row's actual context check.

| tasks.result_ref value | Shape pass | Reader classification |
|---|---:|---|
| Valid envelope for this row | yes | sealedValid |
| Ciphertext byte flipped | yes | AUTHENTICATION_FAILED |
| Tag byte flipped | yes | AUTHENTICATION_FAILED |
| Valid envelope sealed under other tenant | yes | CONTEXT_MISMATCH |
| Plaintext ref | no | plaintext; no reader call is appropriate |
| Originally valid row envelope with AAD changed to other tenant | yes | CONTEXT_MISMATCH |
| Valid envelope sealed with a different refId | yes | CONTEXT_MISMATCH |

The expanded slot result was nonNull=7, shapePass=6, sealedValid=1, sealedBrokenAuth=2, sealedBrokenContext=3, plaintext=1, shapePassAuthFail=5. Across all eight slots, the fixture had 20 non-null values: 14 sealedValid, 2 sealedBrokenAuth, 3 sealedBrokenContext, and 1 plaintext; blockers=6 and gate=FAIL. The shape-only projection reported shapeSealed=19 and shapeLeftover=1, so after the one plaintext row is repaired it would cease to expose any of the five still-broken envelopes.

### Per-row reader binding, clean controls, and no-seam behavior

Wrapped the actual MetadataCrypto.readStored method to capture every call while retaining the real implementation. The all-eight-slot PG run made 19 calls with allowPlaintext=false; all 19 captured tuples matched the expected row-derived values. The capture included operations.input_ref and operations.prompt_overrides_ref / operations.result_ref bound to the operation UUID; tasks.payload_ref and each shape-passing tasks.result_ref bound to that task UUID; human_waits.response_ref bound to wait_id; step_checkpoints.output_ref bound to taskId:stepKey; and session_ref bound to taskId:stepKey:generation. The malformed result_ref calls returned exactly two AUTHENTICATION_FAILED and three CONTEXT_MISMATCH; all other 14 calls opened. No fixed or assumed binding was used by the counter in this fixture.

A populated clean PG database with three valid envelopes (operations.input_ref, tasks.payload_ref, tasks.result_ref) returned nonNull=3, sealedValid=3, blockers=0, gate=PASS. Calling the same counter against those rows with crypto undefined returned plaintext=3, blockers=3, gate=FAIL. The 20-value populated fixture without a seam returned nonNull=20, plaintext=20, blockers=20, gate=FAIL. However, an empty migrated database with crypto undefined returned nonNull=0, blockers=0, gate=PASS; this is a genuine zero-row/vacuous-pass case, not a populated row passing without authentication. No source change was made. If the intended invariant is “no seam can never PASS, even on an empty database,” add a global missing-seam blocker before counting; otherwise document that the PASS proves only there are no non-null values to authenticate.

Raw expanded-probe outputs:

```text
PROBE_RESULT_SLOT={"total":7,"nonNull":7,"plaintext":1,"sealedValid":1,"sealedBrokenAuth":2,"sealedBrokenContext":3,"sealedBrokenOther":0,"shapePass":6,"shapePassAuthFail":5,"shapeFailAuthPass":0,"slot":"tasks.result_ref","table":"tasks","column":"result_ref"}
PROBE_TOTALS={"total":15,"nonNull":15,"plaintext":1,"sealedValid":9,"sealedBrokenAuth":2,"sealedBrokenContext":3,"sealedBrokenOther":0,"shapePass":14,"shapePassAuthFail":5,"shapeFailAuthPass":0}
PROBE_SHAPE_ONLY={"shapeSealed":14,"shapeLeftover":1,"authSealed":9,"authBlockers":6}
PROBE_GATE=FAIL; blockers=6
READ_STORED_CALLS=14; exact_per_row_tenant_slot_ref_bindings=true; allowPlaintext_false=true
PROBE_ROW_FINGERPRINTS_UNCHANGED=true
NO_SEAM_WITH_DATA={"nonNull":15,"plaintext":15,"blockers":15,"gate":"FAIL"}
CLEAN_POPULATED_DB={"nonNull":3,"sealedValid":3,"blockers":0,"gate":"PASS"}
CLEAN_POPULATED_DB_NO_SEAM={"nonNull":3,"plaintext":3,"blockers":3,"gate":"FAIL"}
EMPTY_DB_NO_SEAM={"nonNull":0,"blockers":0,"gate":"PASS"}
ASSERTIONS=PASS all requested contaminated/clean cases matched expected counts; per-row bindings captured; counters made no writes
independent_probe_exit=0
```

The 14-call raw line is from the initial three-populated-slot probe; the subsequent all-slot capture is 19 calls and is recorded below. The counters themselves only query rows; fixture writes occurred before counter execution. Snapshot counts/fingerprints around the initial counter were identical.

All-eight-slot binding capture (no plaintext/ciphertext values logged):

```text
ALL_8_SLOT_CONTEXT_MATCH=true; calls=19; allowPlaintext_false=true
ALL_8_SLOT_GATE=FAIL; blockers=6; sealedValid=14; authFailed=5
ASSERTIONS=PASS all 8 slots populated; every shape-pass row opened using captured row tenant/slot/refId
all_slot_probe_exit=0
ALL_8_SLOT_NO_SEAM={"nonNull":20,"plaintext":20,"blockers":20,"gate":"FAIL"}
all_8_slot_no_seam_exit=0
```

### A2 path check and live boundary

Repository search excluding reports and state-history JSON found the old `backfill-leftover-counter-803.sql` only as the standalone SQL itself and in explanatory source/test comments; no executable app or script reads its result and converts `GATE PASSES` into an A2 decision. `countUnsealedWithAuth` has no production-source caller in this checkout; its only callers are the two named test suites. The current `coordination/coordinator-state.json` adjudication_A12 says the shape counter is census-only and auth-gate counts are the accepted protection evidence. This proves no automated code path in the searched repo, not that a human could not manually run the old SQL or misread its output; A2 remains a review/operator decision.

**Offline-provable:** fresh PG16 schema; real AES-GCM seal/open behavior with a deterministic non-Vault wrapping stand-in; baseline five-case and expanded seven-case counts; all eight slot joins/bindings; clean/no-seam results; empty/no-seam vacuous-pass behavior; no matching executable old-SQL/A2 consumer in the repository search. **Live-only / not proven here:** production Vault Transit unwrapping, production key availability and allowlist, actual production row/context integrity, A2 switch behavior, and review of a production-scale auth-gate receipt. No source, test, migration, or counter SQL was changed and no commit/tick was made.

Evidence hashes: metadata-auth-counter.ts `35B5A3A713BBB32B806AAC799A306D2DE2F35ACFA128D6A07CF1DEB1A1204B77`; gate-authenticate-808.test.ts `ECCF8B63E17B31069F30065161149CD8BF9850CB5A5C94A262A5DA09DBBB8F45`; gate-authenticate-808-pg16.test.ts `9FCB5B5916ADE943E2506B31404E11C7BE93E09356F6B791DAB742774B68059F`; legacy SQL `872DAFD3EF769E6EF98CA2E02BE7E724A0F2C62A87F3830A9276D39F543EB2F3`.

Disposable PG cleanup: docker rm -f du-vfy-auth-gate-808-1ef12cc4 exit 0; confirmed absent afterward. No other container was removed.


#### Exact all-slot readStored tuple audit

Every observed call used tenantId `11111111-1111-4111-8111-111111111111` and allowPlaintext=false. Row-derived refIds captured for each slot were:

| Slot | Calls and exact refIds | Outcomes |
|---|---|---|
| operations.input_ref | 1: `55555555-5555-4555-8555-555555555555` | open |
| tasks.payload_ref | 7: `aaaaaaaa-0000-4000-8000-000000000001` through `...0007` | 7 open |
| human_waits.response_ref | 1: `auth-gate-wait-808` | open |
| step_checkpoints.output_ref | 1: `aaaaaaaa-0000-4000-8000-000000000001:auth-gate-step-808` | open |
| step_checkpoints.session_ref | 1: `aaaaaaaa-0000-4000-8000-000000000001:auth-gate-step-808:2` | open |
| operations.prompt_overrides_ref | 1: `55555555-5555-4555-8555-555555555555` | open |
| tasks.result_ref | 6: task IDs `...0001`, `...0002`, `...0003`, `...0004`, `...0006`, `...0007` (plaintext task `...0005` correctly skipped) | 1 open, 2 AUTHENTICATION_FAILED, 3 CONTEXT_MISMATCH |
| operations.result_ref | 1: `55555555-5555-4555-8555-555555555555` | open |

This is the captured tuple set compared against expected row bindings, not inferred solely from the implementation. It also exercises the JSONB direct-reader path and TEXT readStoredText path.

## VFY-BYPASS-FIX-811 — independent BA-01/02/04/05 verification

**Dispatch:** task_7e9e4922998d / ctx_aa2dd5523ba7 / run_069ecd6957cd. **Scope:** independent read-only verification; no durable product source, test, or counter SQL edits; no commit, tick, or project DB access. Temporary verification test/shim files were removed after capture. **Verdict:** BA-01 now performs an actual authenticated TEXT envelope open when the seam exists, and the mutation probe proves its regression assertion catches the old bypass. The stronger requested condition is **not fully met**: the runtime wrapper still permits legacy plaintext (`allowPlaintext=true`) and returns a raw sealed string immediately when crypto is absent; BA-04's sourceUrl helper also returns every string before crypto. BA-05 is enforced; one additional mock regression remains in the outbox-source test suite.

### Reader, crypto, and independent PG16 fixture

Inspected `runtime.ts` `openMetadata` (string branch routes through `readStoredText`) and `metadata-crypto.ts` `open` (`createDecipheriv('aes-256-gcm')`, `setAAD(expectedAad)`, `setAuthTag`, `decipher.final()`, authentication failures map to `AUTHENTICATION_FAILED`). This is cryptographic authentication, not JSON parsing alone. The binding mismatch check returns `CONTEXT_MISMATCH` before GCM for a different tenant/slot/refId. The separate no-seam early return in `openMetadata` remains before this path.

Started a fresh disposable PostgreSQL **16.11** container (`vfy-bypass-fix-811-pg16`, loopback port 55451) and fresh database `vfy811b`; applied the real orchestrator migrations. Inserted five `step_checkpoints.output_ref` TEXT rows and fetched them back through the actual `step_checkpoints → tasks → operations` join. Values were: valid envelope; ciphertext-flipped envelope; tag-flipped envelope; envelope sealed for tenant B but stored on tenant A row; and ordinary plaintext. AES-GCM was real Node crypto with the independent fixture's deterministic local wrapping provider, not Vault.

| Stored TEXT case | `openMetadata(..., crypto)` runtime wrapper | `readStoredText(..., false)` strict gate reader |
|---|---|---|
| Valid, correct tenant/slot/taskId:stepKey | Opens to `artifact://checkpoint-valid` | Opens to the same value |
| Ciphertext flipped | `AUTHENTICATION_FAILED` | `AUTHENTICATION_FAILED` |
| Tag flipped | `AUTHENTICATION_FAILED` | `AUTHENTICATION_FAILED` |
| Wrong tenant AAD | `CONTEXT_MISMATCH` | `CONTEXT_MISMATCH` |
| Plaintext | **Passes through** as `artifact://checkpoint-plaintext` | `NOT_SEALED` |

Thus the strict reader rejects all four invalid/nonsealed cases, but the actual runtime wrapper does **not** satisfy “only the valid envelope is accepted” while the ENC-09 plaintext window remains open. An additional direct no-seam control returned the valid envelope's raw JSON text from `openMetadata(undefined, ...)`; calling `readStoredText(undefined, sameEnvelope, ...)` instead threw `KEY_PROVIDER_FAILED`. The wrapper's `if (!crypto) return value` therefore bypasses the BA-02 helper's no-seam guard.

The real `countUnsealedWithAuth` ran on the same five rows using its full default eight-slot manifest. For `step_checkpoints.output_ref`: total/nonNull=5, shapePass=4, sealedValid=1, sealedBrokenAuth=2, sealedBrokenContext=1, plaintext=1, shapePassAuthFail=3. The other populated test-control slots were validly sealed, so whole-gate blockers=4 and gate=FAIL, exactly the checkpoint defects above. `bypass-fix-810.test.ts` verifies non-string `readStoredText` rejects `INVALID_INPUT` instead of `String()` coercion; the trimmed and empty `specs` tests reject with the exact-eight-slots coverage error.

### Mutation and regression results

For the BA-01 mutation probe, copied the existing BA-01 test unchanged except for routing `openMetadata` to a temporary shim containing the old behavior (`crypto.readStored(value, context, true)` for raw TEXT). The product source was not reverted or changed. **4/13 failed, 9 passed, exit 1**: valid TEXT envelope returned raw JSON instead of the URI; tampered TEXT did not reject; ciphertext-tampered TEXT did not reject; and reader/counter values diverged. The current implementation passes the same suite as part of the 6-suite run.

Confirmed both regressions described in the owner receipt are corrected: the migration `count(*)` mock branch precedes the generic ledger-row branch in `enc-meta-sentinel-runtime-refs.test.ts` and `encmeta-resultref-offline.functional.test.ts`; `gate-authenticate-808.test.ts` now invokes the full default spec list and its fake DB returns the fixture only for the tasks query. The named six-suite rerun passed **6 suites / 153 tests, exit 0** (`bypass-fix-810`, `gate-authenticate-808`, the two migration mock suites, `encmeta-enc09-kind`, `runtime-encryption-metadata`).

I found one more regression of the same migration-mock class: `enc-meta-sentinel-outbox-source-url.test.ts` lacks a `count(*)::int` branch before its `FROM schema_migrations` branch. Running it together with `url-ingestion-consumer-offline.functional.test.ts` produced **1 suite failed / 1 passed, 5 failed / 39 passed, exit 1**; the five failures are boot failures at `verifyMigrations` because the count query receives the full ledger rows (reports count 0 vs 32 sequence rows). No fix was made. This leaves the outbox-source test coverage red until that mock is repaired.

### BA-04 and remaining risk

`openDispatchSourceUrl` (`ingestion-consumer.ts`, currently checks `typeof raw === 'string'` and returns it before `crypto`) still has the bypass. An independent real-envelope probe passed a correctly bound JSON-stringified envelope and a ciphertext-flipped JSON-stringified envelope; both were returned byte-for-byte as raw JSON text (probe exit 0). Existing tests cover plaintext strings, object-form misbinding/malformed envelopes and no-seam object envelopes, but not stringified envelopes.

The current consumer later opens `tasks.payload_ref` and compares its `sourceUrl` with the dispatch copy before `openGate`/network acquisition; a mismatch escalates first, and the offline consumer suite's disagreement test passed. So this probe proves an authentication bypass at the helper boundary, not a successful network fetch through the current consumer with a tampered dispatch copy. BA-04 remains a real defense-boundary gap, with that later equality check limiting the demonstrated path. The plaintext/no-seam compatibility behavior elsewhere is also still open while the ENC-09 window is active.

### Offline-provable vs live-only

**Offline-provable:** AES-GCM open and tamper/AAD rejection; row-derived checkpoint binding from PG16; current `openMetadata` plaintext and no-seam pass-through behavior; strict `readStoredText` no-seam/non-string behavior; exact eight-slot gate enforcement; mutation sensitivity of BA-01 tests; the two repaired mocks and one additional failing mock suite; BA-04 string bypass and the consumer's later equality check. Evidence is in `coordination/reports/raw/vfy-bypass-fix-811-20261005/` (`pg16-checkpoint-text-jest.txt`, `mutation-old-open-jest.txt`, `regression-six-suites-jest.txt`, `ba04-string-bypass-probe-jest.txt`, and `ba04-consumer-regression-jest.txt`; each has a literal exit file).

**Live-only / not established:** production Vault Transit unwrap/key policy and availability, actual production database rows and all-row migration completeness, production rollout/closing of the plaintext window, and any live network/Vault behavior. The disposable PG container was stopped and auto-removed; no project DB was used.