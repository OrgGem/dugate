# GATE-AUTHENTICATE-808 — the shape predicate no longer false-passes a broken envelope — 2026-10-05

**Packet:** GATE-AUTHENTICATE-808 (task `task_c653962b85c2`, dispatch `ctx_5a310d0913c3`).
**Mode:** offline logic proof + one throwaway PG16 run. No commit/tick. **The A2 flip was NOT closed.**
**Lease:** the counter helper + tests. `runtime.ts`, `metadata-crypto.ts` and every migration untouched.

## 0. The defect (A11)

The shape-only counter has a false-pass. The tester showed: 1 valid envelope + 3 broken envelopes, all four keeping the envelope shape → the shape counter called all four sealed, the real reader failed on three (`AUTHENTICATION_FAILED` x2, `CONTEXT_MISMATCH` x1), and the SQL still reported **GATE PASSES exit 0**.

A shape predicate cannot distinguish a sealed envelope from a corrupted one. Counting shape as `sealed` makes the gate a claim about JSON keys rather than about integrity.

## 1. The fix (items 1, 2)

New file `services/orchestrator/src/modules/encryption/metadata-auth-counter.ts`:

`countUnsealedWithAuth({ db, crypto, specs? })` walks the eight `METADATA_SLOTS` and, for every non-null value:

1. applies the shape predicate (cheap, no key material), then
2. for every **shape-passing** row, calls the REAL `readStored` / `readStoredText` under that row's own `(tenantId, slot, refId)` binding and classifies the outcome.

| group | meaning | gate |
|---|---|---|
| `sealedValid` | opens under its own binding | OK |
| `sealedBrokenAuth` | shape-passes, reader says `AUTHENTICATION_FAILED` | **BLOCKS** |
| `sealedBrokenContext` | shape-passes, reader says `CONTEXT_MISMATCH` | **BLOCKS** |
| `sealedBrokenOther` | shape-passes, some other open failure | **BLOCKS** |
| `plaintext` | never sealed | **BLOCKS** |

`gate = 'PASS'` iff `plaintext + sealedBrokenAuth + sealedBrokenContext + sealedBrokenOther === 0`. A broken envelope now blocks exactly as hard as plaintext.

**Item 2 — separate reporting.** `shapeOnlyCounts(result)` returns the old view (`shapeSealed`, `shapeLeftover`) beside the authenticated one (`authSealed`, `authBlockers`), so a run can show the gap between the two numbers rather than assert it. `shapePassAuthFail` (shape-true, auth-failed) and `shapeFailAuthPass` (shape-false, opens anyway) are separate counters; the second is expected to be 0 for a real envelope and is pinned as such.

**Items 3 & 4 — kept.** The SQL keeps the real `SET LOCAL transaction_read_only = on` and the `outbox.payload` classification from the previous packet; neither was touched.

## 2. Three bugs found while building it

All three were caught by running the thing rather than reading it.

| # | Bug | Symptom |
|---|---|---|
| 1 | Used `readStored` for TEXT columns | `readStored` expects an already-parsed value and answers `NOT_SEALED` for a string, so **every** text envelope was classified broken (`sealedValid = 0`). Text columns must go through `readStoredText`, which parses the JSON text first. |
| 2 | `operations` has **no** `operation_id` column | Three slots used `refIdExpr: 'operation_id'`. PG16: `column "operation_id" does not exist`. The operation id is `operations.id`. |
| 3 | Unqualified column in a JOIN | `tasks.result_ref` and `operations.result_ref` both exist, so the joined query raised `column reference "result_ref" is ambiguous`. The column is now alias-qualified. |

A fourth was a **test** bug, worth recording because it is a trap: the fixtures were all sealed under one `refId` but stored in five different rows. `open()` compares the AAD **before** touching the cipher, so every fixture reported `CONTEXT_MISMATCH` and never reached the GCM check. Each fixture is now sealed under the refId of the row it lives in.

## 3. Measured

### 3.1 Offline (fake Db) — `tests/gate-authenticate-808.test.ts`, 5 tests, 3× literal exit 0

Fixture: 1 valid + ciphertext-flip + tag-flip + wrong-tenant + plaintext, all in `tasks.result_ref`.

| metric | value |
|---|---|
| nonNull | 5 |
| shapePass | 4 |
| sealedValid | **1** |
| sealedBrokenAuth | **2** |
| sealedBrokenContext | **1** |
| plaintext | 1 |
| shapePassAuthFail | 3 |
| blockers | **4** |
| gate | **FAIL** |

The gap, quantified:

```
shape-only view : shapeSealed = 4, shapeLeftover = 1
authenticated    : authSealed   = 1, authBlockers   = 4
authSealed + authBlockers = 5
```

The old counter would have shown one leftover; once that one row was backfilled it would have cleared the gate while three broken envelopes remained.

Also pinned: a clean database passes; **no seam means every non-null value is plaintext and the gate FAILS** (never a silent pass); `shapeFailAuthPass` is 0.

### 3.2 Real PostgreSQL 16 — `tests/gate-authenticate-808-pg16.test.ts`

Run against a throwaway PG16 container (`du-gate-auth`, :54396) — **not** the project DB, **not** the project container. Container removed. The suite skips unless `GATE_AUTH_PG_URL` is set, so CI needs no database.

Fixture: 5 tasks, one value each (valid / ciphertext-flip / tag-flip / wrong-tenant / plaintext), all eight slots scanned.

```
tasks.result_ref slot : nonNull 5, shapePass 4, sealedValid 1,
                        sealedBrokenAuth 2, sealedBrokenContext 1,
                        plaintext 1, shapePassAuthFail 3
whole run           : sealedValid 1, sealedBrokenAuth 2, sealedBrokenContext 1,
                      blockers 10, gate FAIL
```

(blockers 10, not 4, because the run scans all eight slots and the seeded `operations.input_ref` and five `tasks.payload_ref` rows are plaintext too — that is the correct answer, not an artifact.)

`npx tsc --noEmit` → **0 errors, Exit Code 0**. New + existing tests 3× literal **Exit Code: 0**.

## 4. Live wiring (item 5)

**The real key provider is Vault. The offline and disposable runs therefore prove the LOGIC, not the production crypto path.** The deterministic key provider in both suites stands in for Transit.

For a live run: construct the `MetadataCrypto` the same way `create-app.ts` does (`createMetadataCrypto(adaptKeyProviderForMetadata(keyProvider), keyRef)`) from the live Vault provider, then call `countUnsealedWithAuth({ db, crypto })`. A live run adds two things neither of these runs can show: whether the Vault-transit unwrap path behaves identically, and whether key rotation is mid-flight (an envelope under a retired key version will report `AUTHENTICATION_FAILED` or a key-provider error — that is a real finding, not a counter bug, and must be triaged before the flip).

## 5. Unchanged, deliberately

- `coordination/backfill-leftover-counter-803.sql` — untouched by this packet; it keeps the real `transaction_read_only` and the outbox classification.
- `runtime.ts`, `metadata-crypto.ts`, every migration.
- **The A2 flip was NOT closed.** Nothing here is authorization to flip `allowPlaintext` or close the window.
- The helper only ever SELECTs. It reads column VALUES because authentication is impossible without them, but it never logs, returns, or persists one — only counts and error codes.

## 6. Limitations

- Offline proof only (see §4). A live Vault run is still outstanding.
- The counter authenticates every row it classifies, which on a large table means one Vault transit unwrap per sealed row. That is a **cost**, and on a big database it argues for the file being run on a replica and/or sampled for the open check while the counts stay exhaustive. Not measured here.
- `shapeFailAuthPass` being 0 is pinned for a real envelope; it would be non-zero only for a value that opens without looking sealed, which the crypto does not permit.
- The three offline bugs in §2 were all found by running the code against a real database. That is an argument for keeping the disposable-PG test, not just the fake-Db one.

READ-ONLY compliance: no existing product file edited; the helper and the tests are new; the only writes were to a throwaway container, which was removed; no commit/push/tick.