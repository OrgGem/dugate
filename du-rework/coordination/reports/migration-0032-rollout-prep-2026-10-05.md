# MIGRATION-0032-ROLLBACK-PREP — prep for the live rollout (NOT executed) — 2026-10-05

**Packet:** MIGRATION-0032-ROLLBACK-PREP (task `task_fe684ee996f6`, dispatch `ctx_e2a17589afcc`).
**Mode:** READ-ONLY prep. No live DB, nothing applied, no commit/tick.
**Lease:** migration 0032 + new offline test. Other migrations untouched.
**Run:** all checks offline, including the runner's own functions (`migrate`, `verifyMigrations`) against a fake `Db`.

## 0. The migration

```sql
-- Durable connector continuation reference for checkpoint resume.
ALTER TABLE step_checkpoints
  ADD COLUMN IF NOT EXISTS session_ref jsonb;
```

Three lines. One statement. No companion file, no down script.

## 1. Documentation (item 1)

Complete as written for what it does: it names the table, the column, the type, and the purpose in the comment. It is also the **only** migration in this packet's scope.

What it does NOT document (this packet adds it): the rollback path, the ordering constraint against the code, and the false-green trap in `verifyMigrations`. See §2-§4. Those belong in the runbook, not in the file.

## 2. Forward steps, idempotency, rollback, checkpoint semantics (item 2)

### 2.1 Forward

Exactly one step: add a nullable `jsonb` column. Because it is nullable with no default, PG performs the add **without rewriting the table** — a brief `ACCESS EXCLUSIVE` lock, then done. Existing rows read back as `NULL`.

The runner (`migrate()`, `src/db/migrations.ts`) wraps the DDL and the `schema_migrations` INSERT in one `db.tx`, so a failed migration leaves **no** ledger row and is retried on the next run.

### 2.2 Idempotent / re-runnable — YES, twice over

1. `ADD COLUMN IF NOT EXISTS` — a bare second run is a SQL no-op.
2. The runner skips any sequence already in `schema_migrations`.

Pinned by the offline test: two `migrate()` calls apply the DDL **exactly once** and leave one ledger row.

### 2.3 Rollback — there is NO framework for it

`migrate`, `migrationStatus`, `verifyMigrations` exist. **There is no `migrateDown` / `rollbackMigration` / `revertMigration`** (pinned by an offline test that all three are `undefined`). Rollback is therefore hand-authored:

```sql
ALTER TABLE step_checkpoints DROP COLUMN session_ref;
DELETE FROM schema_migrations WHERE sequence = 32;   -- REQUIRED, see §4
```

**`DROP COLUMN` is destructive here.** This is not an ordinary column: `step_checkpoints.session_ref` is a **sealed `METADATA_SLOTS` entry** (`metadata-crypto.ts:49`). Every non-null value is an AES-256-GCM envelope whose AAD binds `(tenantId, slot, refId)` with `refId = taskId + ':' + stepKey + ':' + generation` (`runtime.ts:700-732`). Dropping the column destroys every continuation reference written since the migration.

The reader (`runtime.ts:1880-1914`) opens the value and 422s with `INVALID_SCHEMA` if it is not a string. After a drop, any checkpoint with a sealed ref simply has no continuation — resume starts fresh rather than continuing the provider session.

**So: rollback is only safe before any row has a non-null `session_ref`.** After that, rollback requires restoring the column from a pre-rollback export, not just re-adding it.

### 2.4 Checkpoint semantics RCR/claim depends on

- `step_checkpoints` are documented **immutable** (`0001_platform_v1.sql:100`); a successful row is never rewritten.
- `session_ref` is the durable connector continuation reference. Because the AAD `refId` includes the **generation**, an envelope from generation N cannot be replayed as generation M. Reads are latest-first: `ORDER BY step_key, generation DESC`.
- Consequence: the column is **identity**, not just data. Copying values between rows breaks the binding silently. Only ever write what the writer sealed.

## 3. Does it rewrite old data without backup/transaction? (item 3)

**No.**

- No `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, or `ALTER COLUMN ... SET DEFAULT` anywhere in the file (asserted by an offline regex test).
- No existing row is touched; the column is added with no default.
- The single DDL is atomic on its own, and the runner additionally runs it inside a transaction with the ledger write.

A backup is still required before the live window — not because 0032 rewrites data, but because the window's whole purpose is to make a schema change safely reversible, and the sealed values in §2.3 are the thing a rollback would destroy.

## 4. Three traps the live window must not fall into

### 4.1 `verifyMigrations` cannot catch a half-done rollback

`verifyMigrations` (`src/db/migrations.ts:137-176`) compares **files on disk against the `schema_migrations` ledger**. It never inspects the actual columns. So a hand-rolled `DROP COLUMN` that leaves the ledger row in place **still passes verify** while the column is gone.

That is pinned by an offline test: delete the column from the model, keep the ledger row, and `verifyMigrations` resolves. **Do not rely on `verify` to notice a bad rollback** — check the schema directly.

### 4.2 The ledger row must be deleted by hand

`DELETE FROM schema_migrations WHERE sequence = 32;` is not optional. Leave it and `migrate()` skips 0032 forever (ledger says applied), so the missing column is never re-created — a silent divergence that `verify` will not report (§4.1).

### 4.3 Code-first is the dangerous order

`runtime.ts:717` INSERTs `session_ref`; `runtime.ts:1880` SELECTs `session_ref as "sessionRef"`. If that code is live before the column exists, **both** fail with `column "session_ref" of relation "step_checkpoints" does not exist` — checkpoint writes and reads break together.

The documented order in `migrate-cli.ts` — `migrate` first, then `start` — is **mandatory here, not advisory**. The reverse (apply migration first, then deploy code) is safe because the column is nullable and old code never references it.

## 5. Pre-flight checklist for the live window (item 5)

**Before the window opens**

- [ ] Full DB backup taken and **signed off** (ENC-09 retains legacy pending backup sign-off).
- [ ] Targeted export of the affected rows, so a rollback can restore them rather than re-add an empty column:
  `COPY (SELECT task_id, step_key, generation, session_ref FROM step_checkpoints) TO '/.../step_checkpoints_session_ref.backup.csv' WITH (FORMAT csv, HEADER true);`
- [ ] `npm run migrate:status` — confirm sequence 32 is **pending** and the sequences immediately before it are applied.

**Baseline counts (record before running)**

```sql
SELECT count(*) AS total FROM step_checkpoints;
SELECT count(*) AS with_session FROM step_checkpoints WHERE session_ref IS NOT NULL;
```

**Apply**

```bash
npm run migrate        # applies 0032, then verifies
```

**Verify (schema, not the ledger)**

```sql
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'step_checkpoints' AND column_name = 'session_ref';
-- expect: session_ref | jsonb | YES
```

```sql
SELECT count(*) FROM step_checkpoints WHERE session_ref IS NOT NULL;  -- must equal the baseline
```

**Abort criteria — stop and roll back if any hold**

- [ ] `npm run migrate` exits non-zero, or its post-apply `verifyMigrations` fails.
- [ ] The `information_schema` query does not return exactly one row with `data_type='jsonb'`, `is_nullable='YES'`.
- [ ] `step_checkpoints` row count differs from the baseline.
- [ ] Any lock/timeout error during the DDL.
- [ ] The deploy cannot be brought up after the window because the new code still cannot see the column.

**Rollback (hand-authored — no framework)**

```sql
COPY (SELECT task_id, step_key, generation, session_ref FROM step_checkpoints) FROM '...backup.csv' ...;  -- or an insert-restore
ALTER TABLE step_checkpoints DROP COLUMN session_ref;
DELETE FROM schema_migrations WHERE sequence = 32;
```

Order matters: restore the exported sealed values **only if** you intend to keep them; dropping the column loses them irretrievably. Re-adding the column without the values gives you a table of `NULL` continuations.

## 6. Offline test (item 4)

`tests/migration-0032-rollback.test.ts` — 6 tests, **3× literal exit 0**, typecheck 0 errors.

| Group | Tests | Proves |
|---|---|---|
| the statement itself | 3 | nullable column; no data-rewriting statement; it is a sealed slot; **no down-migration API exists** |
| idempotent re-run | 2 | two `migrate()` calls apply the DDL once and leave one ledger row; a fresh instance picks 0032 up |
| rollback semantics | 1 | **the `verifyMigrations` false-green** (§4.1) |

`migrate()` and `verifyMigrations()` are exercised for real against a fake `Db` — not mocked away — so the idempotency claim rests on the runner's actual skip logic.

## 7. Mutation probe

| # | Mutation | RED | Honest reading |
|---|---|---|---|
| 1 | 0032 → `ADD COLUMN session_ref jsonb NOT NULL` (drop idempotency) | 3/6 | 1 genuine content assertion; the other 2 are downstream of the fake's own `IF NOT EXISTS` pattern matcher, not independent behaviour |

Migration reverted; `git diff --numstat` on 0032 is **empty** (byte-identical to HEAD), and a `grep MUTATION` over the file returns no matches.

## 8. Limitations

- **No live execution.** The fake models the tracking table, the ledger and the DDL; it does not model PG's actual locking, `information_schema`, or planner behaviour. `ADD COLUMN ... IF NOT EXISTS` on a large `step_checkpoints` table is assumed cheap (nullable, no default) — that assumption is **not measured** against a real table.
- The rollback `COPY ... FROM` restore is sketched, not verified; the exact restore statement depends on how the export was taken.
- This packet does not touch `runtime.ts` (native Luna's lease) beyond reading it to establish the dependency.
- `step_checkpoints` row volume in production is unknown; if it is very large, the DDL lock window should be re-evaluated before the live run.

READ-ONLY compliance: migration 0032 unchanged (proven by empty numstat), no other migration edited, no live DB access, no commit/push/tick.