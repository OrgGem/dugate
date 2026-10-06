# RFX-05-V2 — in-lease manifest-version persistence receipt

## Scope and result

Implemented and verified only the authorized module/migration/test seam: a nullable `artifacts.manifest_version_id`, gateway persistence and replay verification by the committed sidecar `VersionId`, and the optional decrypt-reader version argument with a documented legacy fallback. No `server.ts`, existing migration, unrelated source/test, gate, or commit was changed by this task.

The interface/module behavior is covered offline. This is **not end-to-end runtime wiring**: the concrete `server.ts` S3 reader and its decrypt call sites remain unchanged and are an explicit residual owned by the RFX-SERVER lease.

## Implementation evidence

- New migration [0025_artifact_manifest_version.sql](../../services/orchestrator/migrations/0025_artifact_manifest_version.sql:1) adds nullable `text` with `ADD COLUMN IF NOT EXISTS`; no default or backfill is applied. This follows the additive artifact-column convention visible in migration 0013 (`storage_version_id text`) and 0015 (nullable multipart metadata additions).
- Gateway `commit` persists the sidecar ID in `manifest_version_id` ([upload-encryption-gateway.ts](../../services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:706), especially :717-722). `completeReplay` selects the column and verifies the manifest with that `VersionId` when non-NULL ([same file](../../services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:972), :994-995; exact-version Head/Get in :727-770). A historical NULL value skips this additional manifest-version check and retains prior key-only/legacy replay behavior.
- `StoredObjectReader.readManifest` accepts optional `versionId`; its contract documents that `undefined` means legacy key-only lookup. `SealedArtifactRef.manifestVersionId` is optional and nullable, and `decryptStoredArtifact` forwards it as `undefined` for null/absent values ([artifact-read-decrypt.ts](../../services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts:57), :69-76, :234-237).
- Gateway tests assert the ID returned by the sidecar PUT is committed, and that replay Head/Get use the committed ID even after a newer object is written at the same key ([public-upload-encryption-gateway.test.ts](../../services/orchestrator/tests/public-upload-encryption-gateway.test.ts:610), :831-834). A pre-0025 READY row with NULL version retains legacy behavior ([same test](../../services/orchestrator/tests/public-upload-encryption-gateway.test.ts:587-607)). The decrypt module test asserts a committed ID is forwarded and selects the corresponding manifest despite a newer one at that key; the NULL case forwards `undefined` ([artifact-read-decrypt-offline.test.ts](../../services/orchestrator/tests/artifact-read-decrypt-offline.test.ts:181-212)).

## Verification

Commands were run from `D:\Git\dugate\du-rework`.

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts tests/artifact-read-decrypt-offline.test.ts` | 0 | 2/2 suites, 41/41 tests passed; 0 snapshots. |
| `pnpm --filter @du/orchestrator test -- tests/migrations-ledger-guard.test.ts` | 0 | 1/1 suite, 17/17 tests passed. The guard checks migration-file/ledger naming consistency offline; it does not execute SQL against PostgreSQL. |
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | 0 | No diagnostics (no output). |

The focused test harness uses a version-aware in-memory S3 fake. No live versioned-S3 bucket or PostgreSQL migration run was attempted; both remain unverified.

## Explicit residuals

1. **RFX-SERVER wiring, outside this lease:** `server.ts:209-213` implements `readManifest(manifestKey)` using only `{Bucket, Key}` and does not pass `VersionId`. The decrypt refs constructed at `server.ts:1619-1624` and `:2154-2159` also omit `manifestVersionId` (and their surrounding row reads do not select it). Therefore the concrete runtime reader/call paths do not yet consume the new persisted column; queue this after the `server.ts` lease is available.
2. **Live infrastructure:** no live versioned-S3 behavior or live PostgreSQL application/rollback behavior is claimed. The migration was checked for sequence discovery through the offline ledger-guard suite only.

No release gate was ticked and no commit was made.

## Shared-worktree notes

At final scoped status inspection, `services/orchestrator/src/server.ts` also appeared modified in the shared worktree. It is outside this lease; I did not edit it. The residual description above records the current read-only inspection of its reader and decrypt call sites. A repo-wide `git diff --check` returned exit 1 because the shared diff contains trailing whitespace in coordination-state JSON; those files were not touched for this task.
