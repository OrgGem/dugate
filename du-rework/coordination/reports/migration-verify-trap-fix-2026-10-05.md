# MIGRATION-VERIFY-TRAP-FIX — `verifyMigrations` false-green closed — 2026-10-05

**Packet:** MIGRATION-VERIFY-TRAP-FIX (task `task_3af47864f554`, dispatch `ctx_4a26306d35bb`).
**Origin:** finding from this lane's own `MIGRATION-0032-ROLLBACK-PREP`.
**Mode:** offline; no live DB; no migration edited; no commit/tick.
**Lease:** runner `verifyMigrations` + new offline test.

## 0. TL;DR

- **Exactly which condition false-greens (§1):** `verifyMigrations` returns OK iff the tracking table exists AND every file's sequence is present in the ledger with the matching filename. It iterates `files`, never the ledger, and never the schema. So it passes while (a) the ledger holds rows for sequences with no file, (b) the ledger READ lost rows relative to the table, or (c) the ledger and the real schema objects diverge in any way.
- **Fix (§2):** an independent `SELECT count(*)::int FROM schema_migrations` cross-check against the number of sequences the read actually registered, plus an orphan check (ledger sequence with no file on disk). Both fail loudly with the row numbers and the exact repair SQL.
- **Tests (§3):** 8 new offline tests — consistent resolves; count mismatch throws with both numbers; key collapse throws; orphan throws; empty ledger throws; no table throws. 3x literal exit 0.
- **Rollback (§4):** there is NO rollback framework. Real rollback is restore-from-backup plus hand-run commands. Nothing here invents one.

## 1. The trap, precisely

`verifyMigrations` (before this packet) did three things: check the tracking table exists, compare recorded filenames for files it knows about, and report files with no ledger row. Its loop was `files.filter(...)` in both checks — the ledger was only ever consulted by key lookup, never enumerated, never counted.

So the function returns true whenever:

| # | Divergence | Caught before? |
|---|---|---|
| 1 | ledger row for a sequence with NO file on disk | No — every check iterated `files` |
| 2 | the ledger read LOST ROWS relative to the table | No — nothing compared the read against the table |
| 3 | ledger says applied but the schema object is MISSING (e.g. a column dropped by hand) | No — verify never inspects the schema |

Case 2 has a concrete mechanism, not just a theoretical one: `appliedMigrations` builds `new Map(res.rows.map(r => [Number(r.sequence), r.filename]))`. A `Map` collapses equal keys, so two rows resolving to the same number (or a non-numeric sequence) register as FEWER entries than the table has rows — and every file-level check below still passes.

Case 3 is the one my 0032 prep hit, and it is NOT closable here: it needs schema introspection, which is per-table knowledge the migration runner deliberately does not have. It stays a runbook obligation (§4).

## 2. The fix

`src/db/migrations.ts` — +45 / -0, no existing line changed.

### 2.1 Independent count cross-check (closes case 2)

```ts
const countRes = await db.query<{ count: number | string }>(
  'SELECT count(*)::int AS count FROM schema_migrations'
);
const ledgerRows = Number(countRes.rows[0]?.count ?? 0);
const done = await appliedMigrations(db);
if (!Number.isSafeInteger(ledgerRows) || ledgerRows < 0 || done.size !== ledgerRows) { /* throw */ }
```

The error carries BOTH numbers (`SELECT count(*) reports N row(s) but only M distinct sequence(s) could be registered`) plus the inspection query an operator needs. A partial read or a collapsed key can no longer pass.

### 2.2 Orphan check (closes case 1)

```ts
const onDisk = new Set(files.map((f) => f.sequence));
const orphaned = [...done.keys()].filter((seq) => !onDisk.has(seq));
```

Throws with the offending sequences and the repair SQL (`DELETE FROM schema_migrations WHERE sequence IN (...)`).

### 2.3 What was deliberately NOT changed

- The existing mislabeled-filename check and the missing-files check are untouched — including their exact wording, which `migrations-ledger-guard.test.ts` asserts.
- The query order: the tracking-table check still runs first, so an empty DB still fails with the established message before any count query.
- `verifyMigrations` remains read-only; the new statement is a SELECT.

## 3. Tests

| File | Tests | Notes |
|---|---|---|
| `tests/migration-verify-trap-fix.test.ts` | 8 | new — drives `verifyMigrations` for real, with count and rows independently controllable |
| `tests/migrations-ledger-guard.test.ts` | — | Δ-DEVIATION, +3 lines: its fake now answers the count query |

| Case | Expectation |
|---|---|
| consistent ledger | resolves |
| table has more rows than the read registered | throws `/ledger is not readable as recorded/` + both numbers |
| rows collapsing onto one sequence key | throws, reports `only N distinct sequence` |
| non-numeric sequence | throws (never silently accepted) |
| orphan ledger row (sequence 99) | throws `/records sequence(s) [99] that have no migration file on disk/` + the `DELETE ... IN (99)` hint |
| empty ledger | throws `/missing migrations/` |
| no `schema_migrations` table | throws `/no schema_migrations table found/` before any count |
| read-only | the fake throws on any write, and on any unexpected statement |

**Literal exit codes:** 31/31 across the three migration suites x3 runs, every run Exit Code: 0. `npx tsc --noEmit` → 0 errors, Exit Code: 0.

## 4. Rollback — stated plainly, because there is no framework

**There is no rollback framework in this codebase.** `migrate`, `migrationStatus` and `verifyMigrations` exist; `migrateDown` / `rollbackMigration` / `revertMigration` do NOT (pinned by a test in `migration-0032-rollback.test.ts`).

Real rollback is therefore:

1. **Restore from backup** — the full DB backup, or the targeted pre-window `COPY` export of the affected rows.
2. **Run the inverse command by hand** — e.g. for 0032, `ALTER TABLE step_checkpoints DROP COLUMN session_ref;` and then, mandatorily, `DELETE FROM schema_migrations WHERE sequence = 32;`.
3. **Verify the schema directly**, via `information_schema` — never via `verifyMigrations`, which cannot see a dropped column (§1 case 3).

**Do not invent a rollback.** Do not assume `verify` will catch a half-done one; it will not, and now it will not pretend to either. Nothing in this packet adds, implies, or automates a down path.

## 5. Mutation probe

| # | Mutation | RED |
|---|---|---|
| 1 | count cross-check short-circuited | — (combined) |
| 2 | orphan filter replaced with an empty array | — (combined) |
| 1+2 | both guards disabled together | 4/8 |

Under the combined mutation every "mismatch reports" case RESOLVED instead of rejecting — i.e. the exact false-green behaviour the fix removes. Both mutations reverted; `grep MUTATION` over the file returns no matches; the suite is back to 8/8.

## 6. Δ-DEVIATION

+3 lines in `tests/migrations-ledger-guard.test.ts` (outside the named lease): its `fakeLedgerDb` throws on unexpected SQL, so the new count statement had to be answered or a currently-green suite would go red. Minimal and additive; flagged for ratify-or-revert.

`tests/migration-0032-rollback.test.ts` (this lane's own file from the previous packet) also gained a count branch for the same reason.

## 7. Limitations

- **Case 3 remains open by construction.** `verifyMigrations` still cannot detect a ledger that disagrees with the real schema objects (a dropped column, a missing index). That is a runbook obligation, and §4 says so explicitly.
- The fake models the ledger table; it does not model PG's `count(*)` semantics or a real partial read. The collapse case is simulated by feeding rows that share a key.
- No live execution.

READ-ONLY compliance: no migration file touched (0032 numstat empty), no live DB, no commit/push/tick.