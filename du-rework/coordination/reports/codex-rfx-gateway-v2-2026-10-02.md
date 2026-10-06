# RFX Gateway V2 — implementation and offline verification

Date: 2026-10-02  
Scope: RFX-04 removal, RFX-05 in-lease partial, and RFX-06 claim fencing.  
Lease respected: only `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts`, `services/orchestrator/tests/public-upload-encryption-gateway.test.ts`, and this receipt were changed. No gate was ticked; no commit was made.

## Outcome

- **RFX-04 — removed `originalToken`.** The claim query no longer selects `token` twice under two names; `StagingUpload`/`ClaimedUpload` no longer carry `originalToken`. Release clears the expiry only when the current claim token matches, and commit leaves the claim token in place while clearing expiry. It no longer restores the initialization bearer. The gateway does not set an authorization mode, and the READY row has no active claim expiry; tests assert that the original bearer was not restored. Existing upload/replay journey coverage remains green.
- **RFX-05 — partial, in-lease gateway work complete.** Manifest PutObject VersionId is required and captured; manifest HeadObject/GetObject verification requests that exact version; both manifest cleanup paths delete by exact VersionId. The test MemoryS3 now stores version history and honors VersionId for Head/Get/Delete. A takeover race verifies that the stale attempt's manifest version is individually removed and the committed attempt's manifest/ciphertext versions remain readable.
- **RFX-06 — configurable claim lease with claim-token CAS.** The factory accepts a positive safe-integer `claimTtlMs`; the documented/default value remains **3,600,000 ms (one hour)**. While a claim is unexpired, another attempt still receives 409. Once the same artifact's stored `upload_token` session passes the configured grace, a retry takes a new claim token; the old attempt cannot commit or release over it because commit/release remain conditional on that token. A simulated lost release leaves the claim until expiry, after which retry succeeds. The race test also confirms only one attempt makes the row READY.

The concurrent test uses distinct internally generated claim tokens against one stable row-bound `upload_token`; `upload()` itself receives artifact ID and tenant ID and loads that upload token from the row. It does not model two separately initialized logical uploads, which have separate artifact rows.

Implementation/test pointers: removal of the duplicate claim alias is at `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:53-65,339-386`; release and commit preserve claim-token CAS without restoring the initialization token at `:388-393,705-716`. Manifest version capture and exact-version Head/Get/Delete are at `:619-706,720-740`, called/stored for cleanup at `:873-909`. The default/configurable claim TTL is at `:39,113-121,321-342`; crash-shaped retry and takeover/race tests are at `services/orchestrator/tests/public-upload-encryption-gateway.test.ts:719-823`.

## Verification

Working directory for commands: `D:\Git\dugate\du-rework`.

Command:

```text
pnpm --filter @du/orchestrator test -- tests/public-upload-encryption-gateway.test.ts
```

Exit code: **0**. Raw Jest summary:

```text
Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
Snapshots:   0 total
```

Command:

```text
pnpm --filter @du/orchestrator exec tsc --noEmit
```

Exit code: **0**; no diagnostics (empty stdout/stderr).

`git diff --check` for the two leased source/test paths exited **0**. Git emitted only its line-ending notice that LF will be converted to CRLF on a future touch.

## Explicit residuals / evidence limits

1. **RFX-05 full manifest-version binding remains outside this lease.** The manifest VersionId is currently held for the upload attempt and used for verification/cleanup, but is not persisted with the artifact row. Migration `services/orchestrator/migrations/0013_artifact_storage_version.sql:7` adds only `storage_version_id` (the ciphertext version). `completeReplay` remains unchanged: it requires READY plus the stored ciphertext checksum (`services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:932`) and verifies ciphertext using `row.storageVersionId` (`:938-942`); it does not resolve a persisted manifest VersionId. The decrypt reader interface accepts only `readManifest(manifestKey)` (`services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts:55-62`) and reads by expected key (`:220-230`); server's S3 reader likewise issues GetObject by key only (`services/orchestrator/src/server.ts:209-212`). Schema/migration and reader plumbing were expressly excluded and remain follow-up work.
2. **No live versioned-S3 evidence was collected.** The version/delete acceptance was exercised only against the version-aware in-memory S3 mock; a real versioned bucket was not run. Treat live S3 behavior as unverified.
3. The configurable grace is available as a gateway factory option and exercised at 25/40 ms in tests. The production composition at `services/orchestrator/src/server.ts:601-611` does not pass that option, so it continues to use the default one-hour TTL; no environment variable was added.
4. The overlap test models a slow/stale uploader and a retry after advancing the injected clock, then verifies the stale claim fails its commit CAS and its own exact object versions are deleted. The crash-shaped retry test simulates release loss in the database adapter; it is not a process-kill test or a live multi-process test.

Release gates remain unchanged / NO-GO.
