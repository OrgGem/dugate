# RFX-05-FULL — scope blocker (read-only inspection)

Date: 2026-10-03. No source, test, or migration was changed for this follow-up; no database or S3 service was contacted. The requested runtime behavior cannot be completed under the stated lease because its production adapter and both metadata call sites are in the explicitly excluded `server.ts`.

## Evidence

| Required link | Current code | Consequence |
|---|---|---|
| Persisted manifest reference in READY row | `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:705-716` commits ciphertext `storage_version_id`, but has no manifest-version field in its row/commit shape. `:916-942` replay selects and verifies the ciphertext version only. | The gateway and migration can add/persist the manifest version within lease, but that alone cannot provide it to existing decrypt callers. |
| Decrypt module handoff | `services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts:55-71` defines `readManifest(manifestKey)` and `SealedArtifactRef` has no manifest version; `:220-230` calls the reader with only the key. | These are in lease and could be extended, but do not determine how the concrete S3 reader uses the optional value. |
| Concrete production S3 reader | `services/orchestrator/src/server.ts:190-215` creates `s3StoredObjectReader`; `:209-213` implements `readManifest(manifestKey)` with `GetObject({ Bucket, Key })`, no `VersionId`. | An extra argument from the module would be ignored by this callback; production decrypt would still fetch the latest sidecar. This file is expressly excluded. |
| Worker read caller | `services/orchestrator/src/server.ts:1608-1613` passes artifact ID, tenant ID, storage key, and upload token to `decryptStoredArtifact`, not a manifest version. | The caller cannot supply the committed manifest version without an out-of-lease change. |
| Public download caller | `services/orchestrator/src/server.ts:2131-2148` types/selects the artifact fields used for decrypt without `manifest_version_id`, then passes only the storage key and upload token. | The download path likewise cannot reach the pinned sidecar under the current lease. |
| Migration sequence | Existing migration files end at `services/orchestrator/migrations/0024_legacy_parity_columns.sql`; the next available sequence is `0025`. | A new additive migration is in lease, but it cannot close the reader/caller gap by itself. No migration was created or applied in this blocked attempt. |

## Required scope decision

The requested success condition—gateway commit, replay, and production decrypt all resolving the same committed manifest version—requires changes to the excluded `services/orchestrator/src/server.ts`: pass `manifest_version_id` at both decrypt call sites and make `s3StoredObjectReader.readManifest` issue `GetObject` with the supplied VersionId (while preserving the undefined fallback). The tests must cover that concrete adapter/call-site wiring, not only a fake `StoredObjectReader` that records the optional argument.

I stopped before editing because the task explicitly excludes `server.ts`. No focused tests or typecheck were run, and no live versioned-S3 or PostgreSQL migration was attempted. The gateway and its test remain modified from the prior RFX-GATEWAY-V2 task; those prior edits were not changed in this follow-up. Other pre-existing worktree changes were left untouched.

Please authorize a lease extension for the two `server.ts` regions and their focused tests, or confirm that this task should remain limited to the module seam with the known production integration gap documented.
