# W48-CX5 — P8-07 progress

## Phạm vi

Đã soạn bộ tài liệu dashboard/alerts và incident runbooks cho nhánh `du-rework`. Theo yêu cầu Reviewer Turn 6/6, toàn bộ tài liệu đã chuyển từ root `docs/ops/`, `docs/runbooks/` vào `du-rework/docs/ops/`, `du-rework/docs/runbooks/`; các link/tài liệu tham chiếu tương đối đã được cập nhật. Không sửa backend/source code; không mở DB/Redis/provider window.

## Tài liệu đã tạo

- `du-rework/docs/ops/p8-07-dashboards-alerts.md` — panel, nguồn dữ liệu, metric-label policy, alert condition/severity và các budget cần chốt sau benchmark.
- `du-rework/docs/runbooks/README.md` — index, quy tắc an toàn và tiêu chí đóng incident.
- `du-rework/docs/runbooks/bullmq-queue.md` — queue/worker, lease, version pinning và recovery.
- `du-rework/docs/runbooks/outbox-retry-fencing.md` — task-dispatch, webhook và usage outbox được phân biệt; retry/fencing.
- `du-rework/docs/runbooks/unknown-reconciliation.md` — đối chiếu provider evidence; ngăn blind retry/manual state edits.
- `du-rework/docs/runbooks/artifact-storage.md` — artifact loss/failure, read-only checks, restore guardrails và S3 gap.
- `du-rework/docs/runbooks/credential-rotation.md` — provider secret rotation, emergency revoke và encryption-key rotation boundary.

## Phát hiện chi phối nội dung

- Tài liệu cũ `du-rework/docs/17-operational-runbooks.md` có review ghi rõ một số mutating SQL/route không khớp implementation; không sao chép các lệnh đó.
- Hiện có health probe và thư viện metric in-memory, nhưng dashboard/alerts cho queue age, outbox lag, UNKNOWN, storage và credential chưa được nối/kiểm chứng trong source snapshot. Ngưỡng absolute cần benchmark/SLO và owner.
- Có ba luồng delivery khác nhau: `outbox` → BullMQ; `webhook_deliveries`; `connector_usage_outbox`. Runtime `lease_epoch` fencing worker khác với transaction row lock của dispatcher.
- Connector giữ ledger `UNKNOWN` và chặn replay mù, nhưng chưa có operator reconciliation endpoint đã được nghiệm thu; runbook yêu cầu dừng/escalate thay vì cập nhật DB.
- Artifact bytes hiện lưu trong PostgreSQL `artifact_blobs`; S3/object-storage production vẫn là G-DATA gap.
- Provider secret rotation có path ghi version mã hóa trong snapshot; Vault/OIDC là plan. `CONNECTOR_ENCRYPTION_KEY` chưa có migration/rollback rotation được chứng minh.

## Trạng thái và kiểm tra

P8-07 đang **PARTIAL/DRAFT**, chưa đủ căn cứ đánh dấu `[x]`: cần metric exporter/dashboard và alerts thực tế, ngưỡng đã duyệt sau benchmark, on-call ownership, recovery API/tool có audit cho các luồng cần thao tác, cùng rehearsal cô lập.

## Reviewer Turn 6/6 — di chuyển tài liệu

- Đã chuyển 7 tài liệu vào đúng đích: `du-rework/docs/ops/` và `du-rework/docs/runbooks/`; các file nguồn ở root không còn nội dung.
- Đã cập nhật link nội bộ và tham chiếu source/plan theo vị trí mới. Kiểm tra 7 tài liệu: mọi Markdown link và đường dẫn tương đối `../../...` đều resolve được.
- Không sửa backend/source code, không chạy test, không truy cập DB/Redis/provider. Không thay đổi task checklist hoặc báo cáo khác.

## R1-E / FR24-14 — 2026-09-25

### Thay đổi

- `businesses/example-review/src/review.ts`: loại bỏ fallback dùng tên file làm nội dung source. Nếu không đọc được source artifact, child review và single-item review dừng lỗi; không ghi artifact kết quả, không tạo approval/wait.
- Join chỉ chấp nhận result reference hợp lệ và child result JSON đầy đủ, nhất quán với review ID/task index. Lỗi đọc 403/404, JSON hỏng, ref thiếu hoặc result thiếu/không hợp lệ đều dừng xử lý; không còn nhánh tổng hợp child result giả `passed: true`.
- Checkpoint mới mang `evidenceVersion`. Cả replay xử lý thường lẫn resume approval đều từ chối checkpoint legacy thiếu dấu xác minh, tránh tổng hợp hoặc duyệt kết quả giả đã được lưu trước khi sửa.
- Harness offline `businesses/example-review/tests/r1-e-unreadable-evidence.test.ts` bao phủ source 403/404, child result 403/404, join thiếu/hỏng, và legacy checkpoint trong cả replay thường lẫn approval resume.

### Kiểm tra

- `pnpm --filter @du/example-review exec jest tests/r1-e-unreadable-evidence.test.ts --runInBand` — exit 0; 1 suite, 11 tests passed.
- `pnpm --filter @du/example-review test:unit` — exit 0; 12 suites, 110 tests passed.
- Không chạy integration phụ thuộc DB/Redis/provider; harness mới dùng mock offline.

## Reviewer 6/6 follow-up — khử dữ liệu nhạy cảm trong artifact — 2026-09-25

- `businesses/example-review/src/review.ts`: không ghi thông báo lỗi provider, nội dung exception hoặc response provider vào review artifact; artifact chỉ giữ reasoning status cố định. Luồng resume không log exception thô; log chỉ chứa mã an toàn ổn định (`REVIEW_RESUME_FAILED`, `REASONING_INVOCATION_FAILED`...) và `details: [REDACTED]`. Lỗi đọc evidence cũng không đưa artifact ID do caller cung cấp vào thông báo. Tăng evidence policy version để từ chối checkpoint cũ có thể trỏ tới artifact reasoning chưa khử dữ liệu.
- Bổ sung sentinel test trong `businesses/example-review/tests/r1-e-unreadable-evidence.test.ts`: connector reject mang credential giả, signed URL và đường dẫn giả; kiểm tra cả artifact lẫn log không chứa sentinel, đồng thời chỉ log safe error code. Test cũng bao phủ provider response text, resume, và reasoning thô từ child/checkpoint cũ ở cả child lẫn single-item review. Child result cũ được chuẩn hóa; checkpoint từ phiên bản trước redaction bị từ chối. Cập nhật kỳ vọng tương ứng trong test `child-review.test.ts`.
- `pnpm --filter @du/example-review exec jest tests/r1-e-unreadable-evidence.test.ts --runInBand` — exit 0; 1 suite, 11 tests passed.
- `pnpm --filter @du/example-review test:unit` — exit 0; 12 suites, 110 tests passed.
## R1-A / R3-03 + R3-04 — 2026-09-25

### Changes

- `services/orchestrator/src/modules/artifacts/artifacts.ts`: finalize now requires `taskId` and `leaseEpoch`. It locks the producer task row, checks the current epoch, unexpired lease, and `RUNNING` state, then locks the artifact row and checks producer ownership and `STAGING` state in the same transaction as blob verification and the `READY` transition.
- The `READY` update repeats the producer epoch/state/expiry predicate at the write edge. Cancellation and lease takeover serialize on the task row; lease expiry during blob verification is rejected before finalization.
- `putBlob` locks the artifact row and checks `STAGING` in the same transaction as writing blob bytes. Since finalize locks that same row through verification and the state transition, a delayed upload cannot overwrite bytes after `READY`.
- Updated the contracts schema and worker SDK finalize callers to include producer identity; adjusted the document-core boundary fixture.
- Added `services/orchestrator/tests/artifacts-fencing.test.ts`, an offline database/row-lock harness covering missing/foreign/stale/expired/cancelled producers, concurrent cancellation and takeover, expiry at the READY update, a delayed STAGING PUT racing finalize, and overwrite rejection after READY.

### Verification

- `pnpm --filter @du/contracts build` — exit 0; refreshed the workspace package output consumed by orchestrator.
- `pnpm --filter @du/orchestrator exec jest tests/artifacts-fencing.test.ts` — exit 0; 1 suite, 5 tests passed.

## R1-A / Finalize lost-response retry idempotency - 2026-09-25

- Added `artifacts.finalized_lease_epoch` through migration `services/orchestrator/migrations/0011_artifact_finalize_epoch.sql`; successful finalize persists the producer epoch with the READY metadata.
- A finalize retry returns `{ artifactId, state: READY }` when the artifact is READY and task ID, persisted producer epoch, SHA-256, and size exactly match. This read-only replay is allowed after task completion, lease expiry, or a later task epoch. A producer, epoch, hash, or size mismatch returns `STATE_CONFLICT` (foreign producer returns `PERMISSION_DENIED`).
- Extended `services/orchestrator/tests/artifacts-fencing.test.ts` to simulate a committed finalize whose response is lost, verify an exact replay succeeds after task/lease changes, and verify mismatched producer metadata is rejected.
- `pnpm --filter @du/orchestrator exec jest tests/artifacts-fencing.test.ts` - exit 0; 1 suite, 6 tests passed. Database migration was added but not applied to a live database.

## R1-A Priority 2 / PostgreSQL fencing and retry harness - 2026-09-25

### Implementation

- Added `services/orchestrator/tests/artifacts-fencing-pg.test.ts`, which uses the real `Db`/PostgreSQL pool and `migrate()`; setup asserts migrations `0003_artifacts_grants.sql`, `0008_artifact_grant_fencing.sql`, and `0011_artifact_finalize_epoch.sql` are applied. Test rows use unique tenant/operation/task/artifact IDs and scoped cleanup.
- PostgreSQL cases cover two concurrent service transactions with a real row-lock wait (one READY result and one 409 `STATE_CONFLICT` for metadata drift), expired lease and foreign staging producer rejection (403 `PERMISSION_DENIED`), exact READY lost-response replay with persisted epoch/hash/size, and READY metadata/foreign producer retry conflicts.
- Updated the real HTTP artifact-grant suite expectations for 403 staging ownership rejection and 200 exact finalize replay. Finalize now returns 403 `PERMISSION_DENIED` for expired lease at staging finalization; READY foreign producer/metadata drift remains 409 `STATE_CONFLICT`.
- Added `services/orchestrator/tsconfig.pg-tests.json` for standalone typechecking of the PostgreSQL suite; added the PG suite to the offline unit exclusion list.

### Verification and execution boundary

- `pnpm --filter @du/orchestrator lint` - exit 0.
- `pnpm --filter @du/orchestrator exec tsc -p tsconfig.pg-tests.json` - exit 0.
- `pnpm --filter @du/orchestrator exec jest tests/artifacts-fencing.test.ts` - exit 0; 1 suite, 6 tests passed.
- `pnpm --filter @du/orchestrator test:unit` - exit 1: 18 suites passed, 2 unrelated suites failed (17 assertions: open R1-C webhook boundary findings and Admin shell `EADDRINUSE`); 731 tests passed, 17 failed of 748.
- The PostgreSQL suite and real HTTP suite were not executed in this turn. The follow-up instruction keeps the PostgreSQL DB window with Tester as the sole holder; run `pnpm --filter @du/orchestrator exec jest tests/artifacts-fencing-pg.test.ts --runInBand` in that window.

## R1-A / Storage facade contract and artifact read authorization - 2026-09-25

### Changes

- `packages/contracts/src/runtime.ts` now defines the shared `ArtifactPurposeSchema`/type. `input` and `output` are public-purpose roles; `intermediate` and `session` remain operation-internal. Worker SDK step checkpoints continue to be written as `intermediate`.
- The upload-grant wire contract no longer exposes a standalone `storageKey`; consumers receive `artifactId`, the short-lived facade URL, and expiry. The SDK artifact reference type also no longer carries a storage key. The storage backend remains behind Orchestrator grants.
- `services/orchestrator/src/modules/artifacts/artifacts.ts`: read/write access grant authorization now locks requester task and artifact in one transaction. It checks current lease epoch, active lease, and `RUNNING` requester state. Reads allow same-tenant tasks in the same operation (including parent/child task artifacts), or an exact `submit_artifacts` reference whose purpose is `input`/`output`. Cross-tenant, undeclared, `intermediate`, and `session` cross-operation reads fail closed. Reads require `READY`; writes remain owner-task-only and `STAGING`-only.
- Public operation result and admin result projections now include only declared public inputs/references and operation outputs of purpose `output`. Public downloads require a published `input`/`output` reference and hide internal purposes as 404. Updated the real-HTTP artifact fixture to cover READY checkpoint omission and internal download denial; this DB/Redis-backed suite was not run here.
- SDK wire regression confirms a runtime authorization rejection stops before any storage GET. Added offline Orchestrator cases for parent-to-child and child-to-parent same-operation reads, declared/undeclared and cross-tenant references, internal purpose blocking, STAGING rejection, and producer-scoped writes.

### Offline verification

- `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/artifact-read-authorization.test.ts` — exit 0; 1 suite, 11 tests passed.
- `pnpm --filter @du/worker-sdk test -- --runTestsByPath tests/artifact-streams.test.ts --forceExit` — exit 0; 1 suite, 41 tests passed.
- `pnpm --filter @du/contracts test -- --forceExit` — exit 0; 6 suites, 76 tests passed.
- `pnpm --filter @du/contracts build` — exit 0.
- `pnpm --filter @du/contracts lint`, `pnpm --filter @du/worker-sdk lint`, and `pnpm --filter @du/orchestrator lint` — exit 0 for each typecheck.
- SDK/contracts Jest reported lingering async handles after its assertions completed; both test invocations used `--forceExit` and returned exit 0.
- PostgreSQL/Redis integration was not run. This change defines the stable storage-grant boundary and authorization policy; the PostgreSQL `artifact_blobs` backend is still in place, and the S3 adapter/migration remains part of DATA-01/G-DATA.

## R1-A follow-up / Storage contract compile cleanup and S3 facade port - Cycle 84

- Confirmed `packages/worker-sdk/src/types.ts` uses the shared contracts `ArtifactPurpose` type and its durable `ArtifactStreamRef` has no backend `storageKey`. Clarified that reads must go through runtime grants.
- Removed the obsolete `storageKey` field from the `ArtifactUploadGrant` fixture in `businesses/document-core/tests/bullmq-smoke.test.ts`, matching the current wire contract.
- Added and exported `ArtifactStorageFacade` in `services/orchestrator/src/modules/artifacts/storage-facade.ts`. The port covers scoped upload grants, byte/hash verification with a pinned immutable object version, streaming reads by exact version, and exact-version deletion. It documents tenant/artifact/method/content-type/size/expiry scope and forbids resolving committed reads through a mutable `latest` key.
- This is an interface-only preparation for DATA-01/R2-C. The current Orchestrator still stores bytes in PostgreSQL `artifact_blobs`; no S3 adapter or metadata migration was introduced.

### Verification

- `pnpm --filter @du/contracts build` — exit 0.
- `pnpm --filter @du/worker-sdk lint` — exit 0.
- `pnpm --filter @du/orchestrator lint` — exit 0 (includes the exported storage port).
- `pnpm --filter @du/document-core test:typecheck` — exit 0 (includes `tests/bullmq-smoke.test.ts`).

## R2-C / DATA-01 S3 storage facade adapter - Cycle 84 follow-up

### Implementation

- Added AWS SDK v3 S3 client and request-presigner dependencies to `services/orchestrator` and implemented `createS3ArtifactStorageFacade` behind the existing `ArtifactStorageFacade` port.
- Upload grants use a presigned `PutObject` scoped to the configured bucket, artifact object key, exact declared byte count, content type, artifact ID, tenant ID, and expiry. The default AWS v3 signer was exercised locally without network access; the signer dependency is injectable for offline tests and S3-compatible deployments.
- Finalization reads the latest object metadata to discover its `VersionId`, rejects missing/`null` versions, validates artifact and tenant metadata, then streams that exact version to compute actual byte count and SHA-256 before returning the immutable locator. Storage errors use stable safe codes rather than exposing provider exception text.
- `openRead` and `delete` always address the exact pinned `VersionId`. The S3 bucket must have versioning enabled; suspended/disabled versioning fails closed during pinning.
- Added `services/orchestrator/tests/s3-storage-facade.test.ts`: seven offline cases cover grant constraints, the default AWS presigner, exact-version hash pinning, streaming read, exact-version deletion, missing version, and checksum mismatch.

### Verification

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/s3-storage-facade.test.ts` - exit 0; 1 suite, 7 tests passed, including local AWS SDK signing with fake credentials and no S3 network request.
- `pnpm --filter @du/orchestrator lint` - currently fails on an unrelated type error at `services/orchestrator/src/server.ts:1616` (`resolveAdminAuditPrincipal` is undefined there); the new adapter/test compiled as part of the Jest TypeScript run.
- This adds the S3 adapter boundary only. Existing artifact service persistence remains on PostgreSQL `artifact_blobs`; wiring the facade into request/finalize service and adding storage metadata migration remain follow-up work.

## DATA-01/DATA-02 S3 artifact service integration - Cycle 88

### Implementation

- `ServerConfig.artifactStorage` now selects `postgres` (default) or `s3` with bucket, optional region/endpoint, and path-style configuration. S3 credentials come from the AWS SDK provider chain; the client is closed during app shutdown.
- `createArtifactService` now uses the `ArtifactStorageFacade`. The PostgreSQL fallback retains its grant-protected proxy PUT, verifies bytea through the facade, uses SHA-256 as its generation ID, and exposes it through a `Readable`; S3 upload grants are signed directly for artifact key, tenant/artifact metadata, content type, exact declared size, and expiry, and S3 reads stream from the object store. Both backends enforce the configured ingress byte cap before grant creation.
- Finalize verifies actual content through the selected backend while task/artifact fencing is held, then stores `storage_backend` and the immutable `storage_version_id` with READY state. Authorized worker reads and published public downloads route through `getBlob`; S3 opens the recorded version and the HTTP handler streams it without buffering. PostgreSQL reads verify the content-hash version; old READY rows are pinned lazily on first authorized read.
- Added migration `0013_artifact_storage_version.sql`; existing rows default to PostgreSQL. Updated the public download route to stop joining `artifact_blobs` directly, and absolute URL handling now preserves external presigned URLs.
- Storage adapter and service errors map to stable safe HTTP failures. S3 response stream errors are redacted, and server logs continue to record only error class and request context, not provider text.
- Added offline service integration tests for both backends, upload grant selection, finalize pin persistence, pinned streaming reads, and provider-error redaction. Existing artifact fencing/read-authorization tests and migration-ledger regression remain green.

### Verification and execution boundary

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/artifact-storage-service.test.ts tests/s3-storage-facade.test.ts tests/artifacts-fencing.test.ts tests/artifact-read-authorization.test.ts tests/migrations-ledger-guard.test.ts` - exit 0; 5 suites, 38 tests passed.
- `pnpm --filter @du/orchestrator lint` - exit 0.
- `pnpm --filter @du/contracts build` - exit 0; refreshed contract declarations used by the server typecheck.
- No PostgreSQL connection, DB test window, Docker, or Redis service was used. `migrations.test.ts`, PostgreSQL fencing integration, and other live suites were not run.

## DATA-02 public artifact submit guards - Cycle 93

### Implementation

- `createSubmissionService` now receives the configured `maxBlobBytes` from `ServerConfig` (64 MiB default). Before business validation or database access, it totals file-like byte payloads in input JSON, including data URIs, explicitly named base64/byte fields, serialized Buffer values, and numeric byte arrays. Oversized embedded content returns `413 PAYLOAD_TOO_LARGE`.
- Submission validation collects artifact IDs from both top-level `submission.artifacts` and nested action input. A tenant-scoped lookup requires each referenced artifact to be `READY` and unexpired. Unknown/foreign/expired/deleted refs fail closed with `404 NOT_FOUND`; `STAGING` and other non-ready states return `409 STATE_CONFLICT`.
- The artifact check is repeated in the operation write transaction using `FOR SHARE`, preventing concurrent state/expiry changes between validation and operation/outbox creation.
- Added `services/orchestrator/tests/artifact-submit-guards.test.ts` with offline cases for `STAGING`, foreign tenant, expired artifact, oversized base64 and oversized numeric file bytes. The tenant fake applies the same ownership predicate as the production SQL.

### Verification and execution boundary

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/artifact-submit-guards.test.ts tests/br12-isolation-offline.test.ts` - exit 0; 2 suites, 8 tests passed.
- `pnpm --filter @du/contracts build` - exit 0.
- `pnpm --filter @du/orchestrator build` - exit 0.
- `pnpm --filter @du/orchestrator lint` - exit 0.
- No DB window, live PostgreSQL, Docker, or Redis was opened or used; tests run with offline fakes only.

## DATA-04 worker artifact streaming - Cycle 95

### Implementation

- Added bounded `openArtifactStream` and `uploadArtifactStream` helpers in `packages/worker-sdk/src/artifact-streams.ts`. They apply per-stream byte limits, a 64 KiB default / 1 MiB maximum stream high-water mark, chunk-wise SHA-256 and size verification, and a whole-body deadline that remains active after headers until the stream is consumed. Caller abort and timeout destroy the source/sink; upload does not return integrity metadata on overflow, size drift, or hash mismatch.
- Extended `TaskContext.artifacts` with `readStream` and `writeStream`; legacy `read`/`write` use the bounded stream path as well. Upload grant requests carry the current lease epoch, and finalize is mandatory after a successful verified PUT with `{taskId, leaseEpoch, sizeBytes, sha256}`. Only output refs returned after finalize are recorded as committed for this delivery.
- Completion dispositions now accept typed artifact refs. Before calling complete, the worker checks declared output refs and artifact result refs against its finalized output set, then always sends `outputArtifactIds`; the Orchestrator's existing transaction gate rechecks READY state and exact task/operation ownership. Missing, unfinalized/STAGING, and foreign refs fail closed.
- Added timeout, upload integrity, output-reference gate, and worker completion integration coverage. The integration test proves stream bytes are uploaded and the finalize request carries the mandatory producer lease before the output ID is sent to complete.

### Verification and execution boundary

- `pnpm --filter @du/contracts build` - exit 0.
- `pnpm --filter @du/worker-sdk test -- --runTestsByPath tests/artifact-streams.test.ts tests/worker.test.ts` - exit 0; 2 suites, 69 tests passed.
- `pnpm --filter @du/worker-sdk build` - exit 0.
- `pnpm --filter @du/worker-sdk lint` - exit 0.
- Tests use injected fetch and in-memory worker/queue fakes. No DB window, live PostgreSQL, Redis, or Docker was opened or used.

## DATA-03 S3 multipart / resumable large artifact upload - Cycle 97

### Implementation

- Extended the Orchestrator S3 storage facade with a bounded multipart upload API for large artifacts (>5 MiB). It uses 8 MiB parts by default, enforces S3 part/object limits, rejects source chunks over 1 MiB, and computes each part SHA-256 plus the whole-body SHA-256 while consuming the stream.
- Multipart creation binds artifact ID, tenant ID, object key, content type, producer task and lease epoch. The facade checks the durable lease before starting, before and after each part, and before completion. It stores a serializable internal checkpoint after creation and each uploaded part; checkpoint identity, lease, part layout, ETags, sizes and hashes are validated before resume.
- Resume rereads and hashes the source from its beginning, compares already-uploaded part hashes against the checkpoint, and sends only missing parts. A source interruption returns a safe `MULTIPART_UPLOAD_INTERRUPTED` error carrying the latest checkpoint. Cancellation, lease loss, byte-count drift, per-part hash mismatch, whole-body hash mismatch, or checkpoint persistence failure aborts the active S3 multipart upload. Provider exception text is not returned.
- Before returning a committed immutable version pin, the facade reads the completed S3 version by exact VersionId and verifies artifact/tenant metadata, size, and SHA-256. It rechecks the producer lease at the completion edge and deletes the just-completed version if cancellation, lease loss, or integrity verification fails before publication.
- Added `services/orchestrator/tests/s3-multipart-upload.test.ts` with an in-memory fake S3 client. Coverage includes multi-part upload and version pin, per-part mismatch abort, stream interruption/resume with revalidation of prior parts, cancellation abort, and lease-loss abort.

### Verification and execution boundary

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/s3-multipart-upload.test.ts tests/s3-storage-facade.test.ts` - exit 0; 2 suites, 14 tests passed.
- `pnpm --filter @du/orchestrator build` - exit 0.
- `pnpm --filter @du/orchestrator lint` - exit 0.
- Also ran the configured offline `pnpm --filter @du/orchestrator test:unit` before the final completion-edge test was added: 34 suites / 955 tests passed, 2 unrelated suites failed (`webhook-error-boundaries.boundary.test.ts` expected a mock delivery to start; `admin-shell-server.test.ts` timed out connecting to `127.0.0.1:62013`). The latter touched a loopback TCP port, though no PostgreSQL or Redis access occurred. This broad-suite result is recorded separately from the final passing targeted S3 tests.
- No DB window, PostgreSQL, Redis, Docker, or S3 network service was used. Multipart tests use only the in-memory S3 fake.

## LOG-01 structured logging and redaction boundary - Cycle 99

### Implementation

- Reworked `packages/observability/src/logger.ts` so every emitted JSON record carries `timestamp`, `level`, `service`, `environment`, `correlationId`, `taskId`, `invocationId`, and `message`. Correlation IDs are generated when no context supplies one; task/invocation IDs are explicitly `null` when absent. `service` is preferred while `component` remains a compatibility alias. Environment resolves to `dev|test|staging|prod` from explicit configuration or environment variables.
- Redaction runs recursively before serialization and now covers bearer/JWT tokens, common provider API keys, AWS/GitHub/Slack/Google/Vault keys, private-key blocks, credential-bearing database URLs, sensitive URL query parameters, webhook/body/payload fields, artifact/file/document names and paths, Buffer/Uint8Array contents, and cycles. Inline messages are also scrubbed and kept single-line.
- Error objects follow the ADM-BASE-03 safe taxonomy: only `{ kind: "UNEXPECTED_ERROR", message: "Unexpected error; details redacted." }` is serialized; exception text and stack traces are discarded. Updated the observability README to document the implemented contract.
- Expanded offline tests with sentinel values through individual patterns and the emitted JSON logger boundary. The test asserts zero occurrences for every sentinel, including error messages, database credentials, signed URLs, webhook data, artifact names, paths, and bytes.

### Verification and execution boundary

- `pnpm --filter @du/observability test` - exit 0; 1 suite, 22 tests passed, including a direct stdout sink capture and long-base64 sentinel coverage with zero leakage.
- `pnpm --filter @du/observability lint` - exit 0.
- `pnpm --filter @du/observability build` - exit 0.
- Tests use injected in-memory sinks and fixed clocks. No DB window, live PostgreSQL, Redis, Docker, or external service was used.

## DATA-05 PostgreSQL artifact blob migration and rollback window - Cycle 100

### Implementation

- Added `services/orchestrator/src/modules/artifacts/storage-migration.ts` with a PostgreSQL repository, inventory (legacy blobs, eligible READY rows, remaining PostgreSQL references, orphan blobs, and READY S3 rows without immutable versions), row-locked backfill, and an explicit `complete|incomplete` result. Completion requires zero unresolved references and zero failed rows.
- The backfill reads one retained `artifact_blobs.bytes` row at a time, calculates source size and SHA-256, rejects drift against persisted integrity metadata, imports bytes through the S3 facade, verifies the exact returned S3 version and its full content hash, then atomically pins `storage_backend='s3'` and `storage_version_id`. PostgreSQL blobs remain untouched as rollback copies. S3 import retries reuse an existing matching version after a lost DB commit/response.
- Added migration-window reads that verify and prefer S3, falling back to the PostgreSQL copy only when S3 reports the object is absent. `ARTIFACT_STORAGE_MIGRATION_WINDOW=true` forces newly created artifacts to use S3. Added standalone process configuration documentation and an explicit rollback plan; the migration module cannot drop `artifact_blobs`, and its result always reports `legacyTableDropAllowed: false`.
- Added offline coverage for successful and repeated migration, source and S3 hash drift, incomplete inventory blockers, actual S3 import/version verification, S3-first reads, PostgreSQL fallback, and S3-only new artifact grants during migration mode.

### Verification and execution boundary

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/storage-migration.test.ts tests/s3-storage-facade.test.ts tests/artifact-storage-service.test.ts` - exit 0; 3 suites, 25 tests passed.
- `pnpm --filter @du/orchestrator lint` - exit 0.
- `pnpm --filter @du/orchestrator build` - exit 0.
- Tests use an in-memory migration store and fake S3 clients. No DB window, PostgreSQL, Redis, Docker, or live S3 service was opened or used. `artifact_blobs` remains retained; no table-drop statement was added.

## DATA-INT-01 S3 migration runbook and S3-only cutover harness - Cycle 101

### Implementation

- Added `docs/runbooks/data-05-s3-migration-runbook.md` with four operator phases: S3/PG dual-read, guarded idempotent batch migration and SHA-256 verification, `ARTIFACT_STORAGE_MIGRATION_WINDOW=false` S3-only cutover, and rollback steps. The rollback section distinguishes retained legacy PG copies from artifacts created S3-only after cutover; it requires a separately verified reverse copy before any full PG-only rollback.
- Added the guarded `migrate:artifact-blobs` CLI entrypoint. It requires S3 + dual-read mode, explicit backup verification/sign-off references, and `ARTIFACT_BLOB_MIGRATION_CONFIRM=YES` before opening PG/S3. It never connects to Redis or drops `artifact_blobs`; this CLI was not executed.
- Made explicit `migrationWindow: false` with the S3 backend fail closed on missing S3 objects and unresolved PG-backed references. S3 stays the write backend. Added an offline regression proving the cutover path does not query/read `artifact_blobs`; retained-PG fallback is available only in dual-read mode or explicit PostgreSQL rollback configuration.

### Verification and execution boundary

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/artifact-storage-service.test.ts tests/storage-migration.test.ts tests/s3-storage-facade.test.ts` - exit 0; 3 suites, 26 tests passed.
- `pnpm --filter @du/orchestrator lint` - exit 0 (TypeScript no-emit typecheck).
- Tests use an in-memory database and fake S3 clients. No DB window, live PostgreSQL, Redis, Docker, or live S3 was used. No migration CLI, commit, or push was run.
