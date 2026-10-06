# MIGRATION-0032-RESTORE-REHEARSAL — real restore rehearsal on a disposable PG16 — 2026-10-05

**Packet:** MIGRATION-0032-RESTORE-REHEARSAL (task `task_538601995d62`, dispatch `ctx_c5386f464adf`).
**Mode:** rehearsal only. Nothing applied to any real system, no commit/tick.

## 0. Environment — explicitly NOT the real one

**This rehearsal ran on a throwaway PostgreSQL 16 instance created for this packet. It is NOT the project database, NOT the project's docker container, and no real Vault, S3, MinIO or provider was involved.**

| | |
|---|---|---|
| container | `du-mig0032-rehearsal` (removed at the end of the run) |
| image | `postgres:16` (already local, no pull) |
| port | `127.0.0.1:54399` (below the Windows ephemeral band, verified free first) |
| database | `du_mig0032_rehearsal` |
| schema | the project's own migrations `0001`..`0031`, applied in order |
| data | synthetic: 2 tenants, 2 api_keys, 2 operations, 2 tasks, 3 checkpoints |

Container removed with `docker rm -f` after the run.

## 1. Rehearsal steps and evidence

Raw log: `.qwen/tmp/mig0032-rehearsal.log`. Backup: `.qwen/tmp/mig0032-backup.sql`.

| Step | Command (abridged) | Result |
|---|---|---|
| 1. build pre-0032 schema | apply `0001`..`0031` in order | 26 tables; `step_checkpoints` = 7 columns; `session_ref` ABSENT |
| 2. seed | synthetic rows | `tenants=2 ops=2 tasks=2 checkpoints=3 cols=7` |
| 3. **backup** | `pg_dump -U du_rehearsal -f /dump.sql du_mig0032_rehearsal` | 56,943 bytes, sha256 `FAA01E7BBBC1F472B778FC9755359677A1A6003A85B24AC3644E7196D56C9454` |
| 4. **apply 0032** | `psql -f 0032_checkpoint_session_ref.sql` | `ALTER TABLE`, exit 0; columns 7 -> 8, `session_ref jsonb YES` |
| 5. post-migration write | insert a checkpoint with a sealed `session_ref` | `checkpoints=4 with_session=1 cols=8` |
| 6. **simulate failure** | `ALTER TABLE step_checkpoints DROP COLUMN session_ref` | exit 0; **DAMAGED: cols=7 checkpoints=4** |
| 7. **restore** | `CREATE DATABASE du_mig0032_restored` + `psql -f /dump.sql` | exit 0; **RESTORED: tenants=2 ops=2 tasks=2 checkpoints=3 cols=7** |

### 1.1 What the restore proved

| | schema | data |
|---|---|---|
| pre-migration baseline | 7 columns, no `session_ref` | 3 checkpoints |
| damaged (after DROP COLUMN) | 7 columns, no `session_ref` | 4 checkpoints, the gen-3 row's sealed ref **destroyed** |
| **restored from backup** | **7 columns, `session_ref` ABSENT** | **3 checkpoints — exactly the baseline** |

The restored database is byte-for-byte the pre-migration state: the column is gone AND the post-migration row is gone, because the backup predates it. That is the property a rollback must have.

## 2. Restore procedure (checklist)

**Prerequisites**

- [ ] Full DB backup taken and signed off (ENC-09 retains legacy pending backup sign-off).
- [ ] Targeted export of the affected rows, so a rollback can restore values rather than re-add an empty column:
  `COPY (SELECT task_id, step_key, generation, session_ref FROM step_checkpoints) TO '/.../step_checkpoints_session_ref.backup.csv' WITH (FORMAT csv, HEADER true);`
- [ ] Baseline recorded: `SELECT count(*) FROM step_checkpoints;` and `SELECT count(*) FROM step_checkpoints WHERE session_ref IS NOT NULL;`

**Apply (forward)**

```bash
npm run migrate        # applies 0032, then runs verifyMigrations
```

Verify the SCHEMA, not the ledger:

```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_schema='public' AND table_name='step_checkpoints' AND column_name='session_ref';
-- expect exactly one row: session_ref | jsonb | YES
```

**Abort criteria (stop and roll back if any hold)**

- [ ] `npm run migrate` exits non-zero, or its post-apply verify fails.
- [ ] The `information_schema` query does not return exactly one `jsonb`/`YES` row.
- [ ] `step_checkpoints` row count differs from the baseline.
- [ ] Any lock/timeout error during the DDL.

**Rollback — restore, do not reverse**

```sql
-- 1. restore the exported sealed values (only if you intend to keep them)
COPY (SELECT task_id, step_key, generation, session_ref FROM step_checkpoints) FROM '/.../step_checkpoints_session_ref.backup.csv' WITH (FORMAT csv, HEADER true);

-- 2. drop the column
ALTER TABLE step_checkpoints DROP COLUMN session_ref;

-- 3. remove the ledger row, or migrate() will skip 0032 forever
DELETE FROM schema_migrations WHERE sequence = 32;

-- 4. verify the SCHEMA directly; verifyMigrations cannot see a dropped column
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='step_checkpoints' AND column_name='session_ref';
-- expect 0 rows
```

## 3. Rollback is NOT running the SQL backwards

**There is no rollback framework.** `migrateDown` / `rollbackMigration` / `revertMigration` do not exist (pinned by a test in `migration-0032-rollback.test.ts`). A migration's SQL is not automatically reversible — `ALTER TABLE ... ADD COLUMN` has no generated inverse.

Real rollback is **restore from backup plus hand-run commands**, in this order:

1. **Restore** — the full DB backup, or the targeted `COPY` export of the affected rows.
2. **Run the inverse command by hand** — `ALTER TABLE step_checkpoints DROP COLUMN session_ref;`
3. **Remove the ledger row by hand** — `DELETE FROM schema_migrations WHERE sequence = 32;` (mandatory; without it `migrate()` skips 0032 permanently and the column is never recreated).
4. **Verify the schema directly** via `information_schema` — never via `verifyMigrations`, which compares files to the ledger and cannot see a dropped column.

**Do not invent a rollback.** Do not assume `verify` will catch a half-done one.

## 4. Artifacts

| Artifact | Value |
|---|---|
| backup | `.qwen/tmp/mig0032-backup.sql` |
| backup size | 56,943 bytes |
| backup sha256 | `FAA01E7BBBC1F472B778FC9755359677A1A6003A85B24AC3644E7196D56C9454` |
| raw log | `.qwen/tmp/mig0032-rehearsal.log` |
| disposable container | `du-mig0032-rehearsal` — **removed** |

## 5. Limitations

- The rehearsal used synthetic data on a small table. It proves the restore mechanics, not PG's behaviour on a large `step_checkpoints` (lock duration, dump/restore time).
- The `COPY ... FROM` restore is sketched; the exact statement depends on how the export was taken and on whether the target rows still exist.
- The rehearsal did not exercise a partial/corrupt dump, or a restore into a database that already has conflicting objects.
- No real Vault/S3/provider was involved, by design.

READ-ONLY compliance: no real database touched, no migration file edited, no commit/push/tick.