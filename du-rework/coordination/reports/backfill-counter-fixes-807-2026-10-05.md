# BACKFILL-COUNTER-FIXES — two reviewer/tester findings fixed — 2026-10-05

**Packet:** BACKFILL-COUNTER-FIXES (task `task_62b94672e22a` follow-up).
**Mode:** COUNT ONLY. No data modified, nothing deleted, nothing overwritten. No commit/tick.
**Lease:** the counting SQL + this receipt. `runtime.ts`, `metadata-crypto.ts` and every migration untouched. **The A2 flip was NOT closed.**
**Run:** twice on a throwaway PostgreSQL 16 container (`du-counter-fix`, :54397) — **not** the project DB, **not** the project container, no real Vault/S3/provider. Container removed after.

## 0. The two findings

| # | Finding | Fix |
|---|---|---|
| 1 | The read-only guard was a **no-op**. `SET LOCAL default_transaction_read_only = on` only affects FUTURE transactions in the session, so the running transaction stayed writable. | `SET LOCAL transaction_read_only = on`, plus a query that reads the setting back so the run **proves** it rather than asserting it |
| 2 | `outbox.payload` had no sealed/plaintext classification, and nothing said the predicate is shape-only. | Section 9 now classifies it with the same shape predicate, and the header carries an explicit shape-only caveat |

## 1. Finding 1 — proven on PG16 before the fix

```sql
BEGIN; SET LOCAL default_transaction_read_only = on; SHOW transaction_read_only; COMMIT;
-- transaction_read_only = off      <-- the transaction was NOT read-only

BEGIN; SET LOCAL transaction_read_only = on; SHOW transaction_read_only; COMMIT;
-- transaction_read_only = on       <-- fixed

BEGIN; SET LOCAL transaction_read_only = on; CREATE TABLE should_fail(x int); COMMIT;
-- ERROR: cannot execute CREATE TABLE in a read-only transaction
```

The third query is the load-bearing one: the fixed setting actually **blocks a write**, not merely reports a value.

## 2. Finding 2 — the shape-only caveat

Every predicate in this file is a **shape test, not a decryption**. An envelope whose AAD or tag is broken still satisfies the shape predicate and is therefore counted as `sealed`. `sealed` in this file means **LOOKS sealed**, not **OPENS**.

That is stated in the file header and again in section 9. A small sample that actually opens each envelope is a separate check and is not this file's job.

## 3. Measured, two different seeds

### Seed A — mixed sealed / plaintext / `{}` / NULL (4 ops, 4 tasks, 3 waits, 4 checkpoints, 1 outbox)

| slot | non_null | sealed | leftover_plaintext | empty_object |
|---|---|---|---|---|
| `operations.input_ref` | 4 | 2 | 2 | 1 |
| `tasks.payload_ref` | 4 | 2 | 2 | 1 |
| `human_waits.response_ref` | 2 | 1 | 1 | – |
| `step_checkpoints.output_ref` | 3 | 2 | 1 | – |
| `step_checkpoints.session_ref` | 3 | 2 | 1 | – |
| `operations.prompt_overrides_ref` | 2 | 1 | 1 | – |
| `tasks.result_ref` | 2 | 1 | 1 | – |
| `operations.result_ref` | 2 | 1 | 1 | – |
| **total** | | | **10** | **2** |

```
 transaction_read_only | read_only_proof
 on                    | READ-ONLY PROVEN

 total_leftover_plaintext | total_empty_object | actionable_leftover | flip_gate
                       10 |                  2 |                   8 | GATE FAILS - rows are still plaintext at rest
```

### Seed B — everything sealed, plus one envelope-shaped outbox row (2 ops, 2 tasks, 1 wait, 2 checkpoints, 2 outbox)

| slot | non_null | sealed | leftover_plaintext |
|---|---|---|---|
| `operations.input_ref` | 2 | 2 | 0 |
| `tasks.payload_ref` | 2 | 2 | 0 |
| `human_waits.response_ref` | 1 | 1 | 0 |
| `step_checkpoints.output_ref` | 2 | 2 | 0 |
| `step_checkpoints.session_ref` | 2 | 2 | 0 |
| `operations.prompt_overrides_ref` | 1 | 1 | 0 |
| `tasks.result_ref` | 1 | 1 | 0 |
| `operations.result_ref` | 1 | 1 | 0 |

```
 transaction_read_only | read_only_proof
 on                    | READ-ONLY PROVEN

 outbox.payload (NOT a metadata slot) | total_rows | job_envelope_rows | other_rows | shape_sealed | plaintext
 outbox.payload (NOT a metadata slot) |          2 |                 1 |          1 |            1 |         1

 total_leftover_plaintext | total_empty_object | actionable_leftover | flip_gate
                        0 |                  0 |                   0 | GATE PASSES (full-table run, not a sample)
```

Seed B is the one that exercises the new outbox classification: the envelope-shaped row reports `shape_sealed = 1` and the `BusinessJobV1` row reports `plaintext = 1`.

## 4. What changed in the file

`coordination/backfill-leftover-counter-803.sql`

- `SET LOCAL default_transaction_read_only = on` → `SET LOCAL transaction_read_only = on`.
- New section **0a** reads `current_setting('transaction_read_only')` back and prints `READ-ONLY PROVEN` / `NOT READ-ONLY - DO NOT TRUST THIS RUN`.
- Section **0** renamed to **0b** (coverage invariant).
- Section **9** gains `shape_sealed` and `plaintext` columns for `outbox.payload`.
- Header gains the shape-only caveat.

## 5. Unchanged, deliberately

- The eight metadata-slot predicates and their numbers (seed A reproduces the pre-fix totals exactly).
- The flip-gate formula: `actionable_leftover = total_leftover_plaintext - total_empty_object`.
- The hard rules: read-only transaction, count-only, never select the column value.
- `runtime.ts`, `metadata-crypto.ts`, all migrations. **The A2 flip was not closed.**

## 6. Limitations

- The shape-only caveat means the counter can over-count `sealed` for a broken envelope. That is a known, documented limitation, not a silent one.
- Both seeds are small. They prove the predicates distinguish the classes and that the gate flips correctly in both directions; they do not measure production runtime.

READ-ONLY compliance: no product file edited; the only writes were to the throwaway container, which was removed; no commit/push/tick.