# BACKFILL-LEFTOVER-COUNTER (P730 / REVIEW-803) — count unsealed rows before the flip — 2026-10-05

**Packet:** BACKFILL-LEFTOVER-COUNTER (task `task_62b94672e22a`, dispatch `ctx_d3aec5d4a5d8`).
**Mode:** COUNT ONLY. No data modified, nothing deleted, nothing overwritten. No commit/tick.
**Lease:** the counting SQL + this receipt. `runtime.ts`, `metadata-crypto.ts` and every migration untouched.
**Run:** on a throwaway PostgreSQL 16 container (`du-leftover-counter`, :54398) — **not** the project DB, **not** the project container, no real Vault/S3/provider. Container removed after the run.

## 0. Why this exists

REVIEW-803's point: an attacker does not need to break the crypto. They only need to find rows that were never backfilled. So before flipping `allowPlaintext` and before the A2 window flip, someone must be able to answer, with counts, **how many rows are still plaintext at rest** — and the answer must not depend on trusting a sample.

## 1. What is and is not sealed (item 1)

Every `METADATA_SLOTS` entry, its column, and its type:

| # | slot | column | type | migration |
|---|---|---|---|---|
| 1 | `operations.input_ref` | `operations.input_ref` | jsonb | 0001:47 |
| 2 | `tasks.payload_ref` | `tasks.payload_ref` | jsonb | 0001:76 |
| 3 | `human_waits.response_ref` | `human_waits.response_ref` | jsonb | 0005:19 |
| 4 | `step_checkpoints.output_ref` | `step_checkpoints.output_ref` | **text** | 0001:107 |
| 5 | `step_checkpoints.session_ref` | `step_checkpoints.session_ref` | jsonb | 0032:3 |
| 6 | `operations.prompt_overrides_ref` | `operations.prompt_overrides_ref` | jsonb | 0031:15 |
| 7 | `tasks.result_ref` | `tasks.result_ref` | **text** | 0001:85 |
| 8 | `operations.result_ref` | `operations.result_ref` | **text** | 0001:48 |

**Sealed vs plaintext, per column type:**

- jsonb — sealed iff `jsonb_typeof(c)='object'` AND `c->>'version'='1'` AND `c->>'algorithm'='aes-256-gcm'` AND `jsonb_typeof(c->'dek')='object'` AND `jsonb_typeof(c->'nonce')='string'` AND `jsonb_typeof(c->'tag')='string'` AND `jsonb_typeof(c->'ciphertext')='string'`. That is exactly `isSealed()` in `metadata-crypto.ts`; the discriminator pair cannot occur in a legacy plaintext object, so a plaintext row is never miscounted as sealed.
- text — sealed iff the value carries `"version":1`, `"algorithm":"aes-256-gcm"` and `"ciphertext"`. The envelope is `JSON.stringify` of the `SealedMetadata` object, so those member names are always present.

**Reported separately, deliberately NOT gated on:** `outbox.payload`. It is an ENC-09 kind (`outbox_payload`) but it is **not** a `METADATA_SLOTS` entry and is **not** sealed by the metadata seam — `runtime.ts:912` writes a plain `BusinessJobV1` job envelope (`contractVersion`, `deliveryId`, `taskId`, `operationId`, …). It is operational routing metadata, not tenant business content. Section 9 of the SQL reports it so nobody assumes it was covered.

## 2. The counting SQL (item 2)

`coordination/backfill-leftover-counter-803.sql` — one read-only transaction, ten sections:

| Section | Purpose |
|---|---|
| 0 | coverage invariant: every `METADATA_SLOTS` entry appears exactly once in 1..8 |
| 1..8 | per slot: `total_rows`, `non_null`, `sealed`, `leftover_plaintext`, `empty_object` |
| 9 | `outbox.payload` — the different class, reported not gated |
| 10 | **the flip gate** |

**Hard rules the file enforces for itself:**

- `SET LOCAL default_transaction_read_only = on` plus a `statement_timeout` and an idle timeout. The transaction cannot write even if a statement were wrong.
- Only `SELECT`/`count(*)`/`FILTER`. No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`, `DROP`, `CREATE`, `GRANT`.
- Never selects the column value — only aggregate predicates over it. No envelope, no ciphertext, no plaintext ref can reach the output.

### 2.1 A bug in the first cut, found and fixed

The first version of the jsonb predicate was not NULL-safe. `NOT (predicate)` is **NULL**, not TRUE, in SQL, so any row missing the `version` key evaluated to NULL and **silently vanished from `leftover_plaintext`**. On the disposable run the counter reported `leftover_plaintext = 0` for `operations.input_ref` when the seed plainly contained a plaintext row.

That is the dangerous direction for a pre-flip gate: an undercount reads as "nothing left to do". Fixed by `COALESCE`-guarding every comparison so the predicate is never NULL. After the fix the same seed reports the correct numbers (§3).

## 3. Measured on the disposable instance (item 4)

Schema: the project's own migrations `0001`..`0032` applied in order (26 tables). Seed: 4 operations, 4 tasks, 3 human_waits, 4 step_checkpoints, 1 outbox row — deliberately mixed sealed / plaintext / `{}` / NULL.

| slot | non_null | sealed | leftover_plaintext | empty_object |
|---|---|---|---|---|
| `operations.input_ref` | 4 | 2 | **2** | 1 |
| `tasks.payload_ref` | 4 | 2 | **2** | 1 |
| `human_waits.response_ref` | 2 | 1 | **1** | – |
| `step_checkpoints.output_ref` | 3 | 2 | **1** | – |
| `step_checkpoints.session_ref` | 3 | 2 | **1** | – |
| `operations.prompt_overrides_ref` | 2 | 1 | **1** | – |
| `tasks.result_ref` | 2 | 1 | **1** | – |
| `operations.result_ref` | 2 | 1 | **1** | – |
| **total** | | | **10** | **2** |

Gate output, verbatim:

```
 total_leftover_plaintext | total_empty_object | actionable_leftover | flip_gate
                       10 |                  2 |                   8 | GATE FAILS - rows are still plaintext at rest
```

The numbers match the seed by hand: 8 plaintext rows plus 2 `{}` rows that were never populated. `outbox.payload` reported 1 `job_envelope_rows`, 0 `other_rows`, and is not part of the gate.

**Read-only proof:** after the run the row counts were re-checked and were unchanged (`4,4,3,4,1`).

## 4. Conditions for running this on the real database

**Do not run it on the project DB without all of the following. If any is missing, stop and hand it to the owner.**

- [ ] A maintenance window is agreed, and the run is expected to be a **full-table** scan on 8 columns across 5 tables. On a large `operations`/`tasks` table this is not free.
- [ ] It runs against a **read replica** if one exists, or with an agreed `statement_timeout` and an explicit acceptance of the primary's load.
- [ ] The metadata seam is **enabled** (`DU_ENCRYPTION_METADATA_ENABLED`), otherwise `sealed` will be 0 everywhere and the numbers are meaningless.
- [ ] Someone is watching for lock waits / replication lag during the run.
- [ ] The output is treated as **counts only** and is never joined to or printed alongside row values.

## 5. Abort conditions

- [ ] Any statement errors, times out, or is cancelled.
- [ ] The coverage invariant (section 0) reports anything other than `covered` for all eight slots — that means the SQL and `METADATA_SLOTS` have drifted and the numbers cannot be trusted.
- [ ] `sealed + leftover_plaintext != non_null` for any slot — the predicate is broken.
- [ ] Row counts move during the run (they must not; the transaction is read-only).
- [ ] The run cannot be completed inside the agreed window.

## 6. What must NOT be done

- [ ] **Do not seal.** This is a counter, not a backfill. Sealing is a separate, write-path operation with its own packet.
- [ ] **Do not delete.** Not rows, not columns, not the `{}` defaults.
- [ ] **Do not overwrite.** No `UPDATE`, no `INSERT`, no `ALTER`.
- [ ] **Do not select the column value.** Only aggregate predicates.
- [ ] **Do not run it on the project DB** outside the conditions in §4.

## 7. Limitations

- The sealed predicate is a **shape** test, not a decryption. A row could carry the envelope shape and still fail to open (wrong AAD, tampered tag). The counter therefore measures "looks sealed", not "opens". A small sample that actually opens each envelope is a reasonable complement before the flip, and is a different task.
- The text-column predicate matches on three substrings. A plaintext value that happened to contain all three would be miscounted as sealed; that is implausible for a ref/URI but is not impossible.
- The disposable run used a handful of rows. It proves the predicates distinguish the classes, not the runtime cost on production volume.
- `empty_object` is reported but the gate subtracts it; whether an operator wants to treat `{}` as "nothing to do" is a product call, recorded here rather than made.

READ-ONLY compliance: no product file edited; the only writes were to the throwaway container, which was removed; no commit/push/tick.