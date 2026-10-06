# WINDOW-METRICS-825 — metrics and close authorization

## Implemented

- Added `metadata-window-metrics.ts` and wired it at app composition. The existing `MetadataReader` is decorated outside its implementation: successful sealed reads increment the sealed counter, successful legacy reads increment the plaintext counter, and actual `NOT_SEALED` denials increment the blocked counter. Denials carry only the bounded reasons `forbid`, `expired`, or `outside_window`; expiry remains fail-closed and has no plaintext fallback.
- Added the design’s mode gauge with active mode plus start/expiry timestamps, and backfill migrated, verified, failed, unresolved, and state metrics. `backfill.state` starts as `incomplete`; unresolved count is not fabricated before a progress report. The control exposes `recordBackfillProgress` for the backfill producer.
- The design writes metric names with dots (`metadata_read.*`, `backfill.*`), while `@du/observability` rejects dots and requires snake_case. The registry names preserve the design’s family/metric terms using the existing convention, e.g. `metadata_read_plaintext_total` and `backfill_unresolved`.
- Added `metadata-window-control.ts`. An explicit `requestCloseForNextBoot` requires a server-resolved admin session with CSRF verification and stable issuer/subject, complete backfill, zero unresolved references, zero blockers, and `backupSignedOff=true`. It calls the existing `canRetireLegacyPayloads`; that helper already requires a signed backup and a safe-integer zero unresolved count. A successful request writes `metadata_read.window_close_requested` to the audit ledger with the session issuer and subject, then returns `nextMode: 'forbid'` and `restartRequired: true`.
- The closure request does not mutate the immutable live policy: the design requires an explicit environment change and restart. No timer, metric value, or progress update invokes closure. Audit write failure, missing identity/authority, and unmet gates all fail closed.
- App composition exposes `metadataWindowControl` and `metadataWindowMetrics` on the app handle. No route or deployment integration was added. There is no existing backfill progress producer connected to this API, so unresolved/backfill metrics remain explicitly unreported until that producer reports a snapshot; close authorization remains unavailable without one.

## Verification

- Focused `metadata-window-control.test.ts`: 9/9 tests passed in each of three runs, then 9/9 passed again after the final metric-label type tightening.
- `pnpm --filter @du/orchestrator typecheck`: exit code 2. It reports errors only in out-of-scope worktree changes: `backfill-metadata-cli.ts` passes `MetadataCrypto` where `ControlPlaneSealer` requires `seal()` to return `Record<string, unknown>` (lines 159, 160), and `legacy-payload-migration.ts` has three `payloadKind: string` versus `Enc09PayloadKind` errors (lines 1178, 1195, 1206). Those files were not edited for this task because the task excludes migration changes.
- `canRetireLegacyPayloads` was inspected at `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts:492-498`; its existing unit cases also cover unsigned backup and nonzero unresolved references. The focused control suite isolates that out-of-scope migration module behind a test mock because its current worktree type errors prevent compiling it as part of this suite.

## Files

- `services/orchestrator/src/modules/encryption/metadata-window-metrics.ts` (new)
- `services/orchestrator/src/modules/encryption/metadata-window-control.ts` (new)
- `services/orchestrator/src/app/bootstrap/create-app.ts` (composition wiring)
- `services/orchestrator/tests/metadata-window-control.test.ts` (new)

`metadata-read-policy.ts`, its reader implementation, and migration sources were not edited. No A2 flip, commit, or tick was performed.
