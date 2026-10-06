# RFX-GATEWAY — RFX-04/05/06 inspection receipt

**Outcome: STOPPED BEFORE EDITS.** Re-read `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` sections RFX-04/05/06 and current source/tests. The file lease permits only `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts` and its focused tests, plus this receipt. RFX-05 needs durable manifest-version identity that the current artifact schema and decrypt-reader interface do not provide; using an unrelated column would corrupt its meaning. Per the dispatch constraint, I stopped without changing gateway or test code.

## Current evidence and scope decision

### RFX-04 — `originalToken`

- The gateway’s `CLAIM_TTL_MS` is currently one hour (`upload-encryption-gateway.ts:39`). `claim()` selects the current `token` twice as `claimToken` and `originalToken` (`:336-344`), accepts an expired claim (`:354-357`), then replaces `token` with the new claim token (`:371-376`). Thus after a later claim, the aliased “original” value is the previous claim token, not the init value.
- `release()` restores that aliased value (`:380-385`); `commit()` writes it back into `token` (`:678-690`). Init creates a distinct random `token` and stores the public replay key in `upload_token` (`:775-781`), so these are not interchangeable values.
- Evidence supports the plan’s removal alternative for the public gateway: the public PUT authenticates with the tenant API key and calls the gateway with artifact id/tenant/source (`server.ts:1452-1472`); runtime blob authorization requires matching token *and* method mode *and* unexpired grant (`server.ts:1526-1546`). Gateway init does not set `token_mode`, and commit clears `token_expires_at` (`upload-encryption-gateway.ts:775-781,683-689`), so restoring an init bearer is not needed to authorize a READY blob read. **Candidate direction, not implemented:** remove `originalToken` from the gateway type/query and stop restoring it; retain the claim-token compare-and-set, and leave the READY token non-authorizing (mode/expiry remain absent). The requested claim→expire→reclaim→commit/release regression test has not been added or run.

### RFX-05 — sidecar VersionId cannot be durably pinned within lease

- Ciphertext already captures `VersionId` from `PutObject`/multipart completion (`upload-encryption-gateway.ts:443-451,461-475,514-526`), and its verification pins that version for Head/Get (`:568-609`). Commit persists that ciphertext version in `artifacts.storage_version_id` (`:678-690`). Ciphertext cleanup also deletes the exact version (`:702-708`).
- The manifest sidecar path is not version-pinned: `storeAndVerifyManifest()` ignores the `PutObject` response and Head/Get use only bucket+key (`:611-676`); failure cleanup deletes only by key, creating a delete marker on a versioned bucket (`:693-700`). `completeReplay()` currently selects the committed ciphertext `storageVersionId` and verifies ciphertext at that version; it does not read or verify a manifest (`:880-917`).
- The artifact migrations add only `storage_version_id` for the object generation (`migrations/0013_artifact_storage_version.sql:1-8`); no manifest-version column exists in the migration tree. `multipart_upload_id` is the active multipart handle and is cleared at commit (`migrations/0015_artifact_multipart.sql:12`; gateway `:683-685`), while `token` is the blob-grant bearer (`migrations/0001_platform_v1.sql:129-143`; `server.ts:992-1019,1526-1546`). Neither is a safe semantic slot for a manifest VersionId.
- The read/decrypt boundary also has no version parameter: `StoredObjectReader.readManifest(manifestKey)` accepts only a key (`modules/encryption/artifact-read-decrypt.ts:54-61`); the decrypt path derives the fixed sidecar key and reads it without a version (`:220-229`). Therefore a durable fix that makes commit/replay and the actual decrypt reader agree requires an explicit persisted manifest-version reference and reader plumbing outside the lease. I did not smuggle it into `token`, `multipart_upload_id`, or the ciphertext `storage_version_id`.
- The focused `MemoryS3` mock is not version-aware: it stores one object per key and Head/Get/Delete retrieve or delete by key, ignoring a command’s `VersionId` (`tests/public-upload-encryption-gateway.test.ts:78-99,129-149`). It cannot currently prove old-version 404 or exact-version deletion. No live versioned S3 check was run.

### RFX-06 — claim lease

- Current claim expiry is 60 minutes (`upload-encryption-gateway.ts:39,331-345`). A later request gets 409 while the stored expiry is in the future (`:354-357`); otherwise it overwrites the claim token and expiry (`:371-376`). The upload then streams/stores/verifies before commit (`:821-878`); no claim-renewal/heartbeat path exists in this gateway. A crashed process that cannot call `release()` can therefore retain the mutex until expiry.
- No TTL or heartbeat change was made. Shortening the lease alone could allow a still-running slow upload to overlap a retry; until the versioned-write/fencing behavior is resolved, choosing a new duration here would not establish the requested “only one real uploader wins” guarantee.

## Verification commands

Implementation stopped before running post-change tests/typecheck; there are no post-change results to report.

| Command | CWD | Exit / result |
|---|---|---|
| `pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts` | `D:\Git\dugate\du-rework` | **Not run** — stopped before edits because RFX-05 requires durable schema/reader support outside the lease. |
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | `D:\Git\dugate\du-rework` | **Not run** — no source changes were made; same stop condition. |
| Live versioned-S3 concurrent-completion/delete verification | N/A | **Not run** — no live S3 verification; explicitly remains an acceptance gap. |

## Requested scope boundary

No production source or test file was edited, no test/typecheck was run, no gate was ticked, and no commit was made. To resume implementation, the file lease must first be widened to cover the migration/persistence field and the artifact manifest reader path; after that, RFX-04/05/06 can be implemented and tested as one consistent gateway lifecycle.
