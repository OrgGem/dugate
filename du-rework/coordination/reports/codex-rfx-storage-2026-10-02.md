# RFX-STORAGE — RFX-09 + RFX-13

## Result

- Base HEAD: `b088eececcb5f3df0b4edbe073a29401dafda624` (working-tree changes uncommitted).
- RFX-13: `storage-migration.ts:150` reads an optimistic snapshot with `db.query` and no artifact `FOR UPDATE`. S3 import and verification therefore run outside a transaction. The final short transaction at `storage-migration.ts:190` performs a compare-and-set guarded by READY/PostgreSQL state, `storage_version_id IS NULL`, tenant, storage key, and the snapshot's size/hash.
- RFX-09: a failed CAS or integrity check deletes only the imported `(objectKey, versionId)` at `storage-migration.ts:220` and `:284-290`. Cleanup failure is surfaced as `ORPHAN_VERSION_CLEANUP_FAILED` rather than silently ignored.
- `s3-storage-facade.ts:907-913` already retains the `PutObject` response `VersionId`, verifies that exact generation, and returns it; `:931-940` deletes an exact version. No source change to that file was needed. `s3-storage-facade.test.ts:194` now explicitly asserts the pinned VersionId.

## Verification

All commands were invoked from `D:\Git\dugate\du-rework`; package scripts execute in `D:\Git\dugate\du-rework\services\orchestrator`.

| Command | Result | Exit |
|---|---|---:|
| `pnpm --filter @du/orchestrator test -- tests/storage-migration.test.ts tests/s3-storage-facade.test.ts` | 2 suites passed; 19 tests passed; 0 failed | `0` |
| `pnpm --filter @du/orchestrator typecheck` (`tsc --noEmit -p tsconfig.json`) | Typecheck passed | `0` |
| `git diff --check -- services/orchestrator/src/modules/artifacts/storage-migration.ts services/orchestrator/tests/storage-migration.test.ts services/orchestrator/tests/s3-storage-facade.test.ts` | No whitespace errors; line-ending warnings only | `0` |

- An unscoped workspace diff check also reported existing trailing whitespace in `coordination/agent-watch-state.json`; that coordinator-owned file was not changed. The scoped check above is clean.
- The concurrent migration test at `storage-migration.test.ts:329` forces two imports to overlap, observes one committed pointer, one exact-version deletion, and one remaining fake-S3 version.
- The lock-window test at `storage-migration.test.ts:358` runs the real `requestAccess` service while a 4 MiB migration import is gated; it completes before the import is released. The offline DB fake serializes transactions, so this detects a transaction held across the S3 wait. This is not a PostgreSQL lock-wait measurement.
- Raw output was captured in the task terminal; no separate raw-log file was created.

## Live Gap

No real PostgreSQL or versioned S3 was used. The one-version evidence is from the offline version-aware fake, not a bucket listing; RFX-13 has not been measured against a live database. A live versioned-S3 concurrency run and real `requestAccess` lock-wait/statement-timeout measurement remain outstanding. No gate was ticked and no commit was created.
