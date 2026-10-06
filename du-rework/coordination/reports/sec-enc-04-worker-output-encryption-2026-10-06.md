# SEC-ENC-04 — Encrypted Worker Outputs and PostgreSQL Blobs (SD-03)

- **Task:** `SEC-ENC-04` (`tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md:64`), SD-03 từ `coordination/reports/sensitive-data-security-review-2026-10-06.md:29`
- **Owner:** OpenCode 4 (`oc_4`), Worker SDK & artifact storage integrator; phối hợp `qwen_2`
- **Ngày:** 2026-10-06
- **HEAD:** `b088eececcb5f3df0b4edbe073a29401dafda624` (branch `codex/fix-workflow-builder`)
- **Trạng thái:** IMPLEMENTED một phần (server-mediated single-upload seal cho **cả PG và S3**, reader decrypt tenant-bound, multipart worker fail-closed); **CHƯA nối boot (`create-app.ts` ngoài lease), CHƯA wire live, CHƯA VERIFIED độc lập**.
- **Directives tuân thủ:** không commit, không push, không cutover; chỉ sửa trong write lease (`packages/worker-sdk/src/artifact*`, `packages/worker-sdk/src/storage*`, `services/orchestrator/src/modules/artifacts/**`, `packages/worker-sdk/tests/**`).

## 1. Kết luận ngắn

- Worker artifact single-PUT giờ được **Orchestrator seal phía server** trước khi ghi xuống PostgreSQL (`artifact_blobs.bytes`) hoặc S3 (object + sidecar `*.crypto-manifest.json`); worker **không cần key/Vault token**.
- Khi encryption được cấu hình, `requestUpload` **không phát presigned S3 grant** nữa — mọi write đi qua proxy URL của Orchestrator, nên worker không thể bypass admission.
- Reader dùng đúng carrier/AAD của reader canonical (`artifact-read-decrypt`): `tenantId + artifactId + upload_token (objectVersion) + purpose`; sidecar chứa **raw envelope/manifest đúng shape `parseManifest` tiêu thụ**; marker `du-encrypted`/`du-manifest-key` + `manifest_version_id`/`storage_version_id` được pin ở admission. Smoke xác nhận `decryptStoredArtifact` **mở được worker envelope** và từ chối sai tenant.
- `finalize` xác thực envelope (giải mã bằng AAD từ row + ciphertext pinned version) rồi commit: `artifacts.sha256/size_bytes` giữ **plaintext business metadata**, `storage_version_id/manifest_version_id` là **ciphertext generation** (tách đúng theo invariant SEC).
- Multipart worker (client PUT trực tiếp vào S3) **bị chặn fail-closed 501** khi encryption required — **chưa** có encrypted multipart writer (xem §7 OPEN); legacy compat inline upload cũng fail-closed.
- **Chưa nối vào boot** vì `create-app.ts` ngoài lease: feature đang off mặc định; cần integrator truyền option (hướng dẫn §8) rồi Tester/live verify.

## 2. Hiện trạng trước (SD-03)

- `packages/worker-sdk/src/task-context.ts:728` chỉ fail-closed khi `encryptionEnabled` được set; mặc định không set → upload plaintext.
- `services/orchestrator/src/modules/artifacts/artifacts.ts` (bản trước): `requestUpload` phát **direct S3 upload grant**; `finalize` chỉ verify size/hash/version, không có envelope; `putBlob` insert plaintext vào `artifact_blobs`.
- Public upload gateway đã seal, nhưng **worker output không đi qua gateway** → có thể nằm plaintext trong khi strict read path (`artifact-read-decrypt` với `encryptionRequired`) lại từ chối đọc (fence lệch hai đầu).

## 3. Thay đổi

| File | Thay đổi |
|---|---|
| `services/orchestrator/src/modules/artifacts/artifact-encryption.ts` (**mới**, ~330 dòng) | Module canonical server-side: `sealWorkerArtifact` (:163) chọn single-shot ≤5 MiB / chunked 4 MiB, sidecar = **raw envelope/manifest** (shape `parseManifest`); `parseWorkerArtifactSidecar` (:234) shape-check fail-closed; `openWorkerArtifact` (:263) verify GCM/MAC dưới context từ row; `verifyWorkerArtifact` (:287); `artifactEncryptionContext`; metadata carrier `sealedObjectMetadata`/`manifestObjectMetadata`; `WORKER_ARTIFACT_PURPOSE = PUBLIC_UPLOAD_PURPOSE` để một reader canonical phục vụ cả hai. |
| `services/orchestrator/src/modules/artifacts/storage-facade.ts` | Thêm code `ENCRYPTION_UNAVAILABLE/ENCRYPTION_REQUIRED/ENVELOPE_INVALID`; port optional `putServerObject`/`readServerObject` (server-mediated write/read). |
| `services/orchestrator/src/modules/artifacts/postgres-storage-facade.ts` | `PostgresArtifactBlobPort.write?` + implement `putServerObject` (content-hash version) / `readServerObject`; `OBJECT_NOT_FOUND` khi thiếu. |
| `services/orchestrator/src/modules/artifacts/s3-storage-facade.ts` | Implement `putServerObject` (PutObject + metadata identity/marker, **bắt buộc VersionId** — unversioned write bị xoá và từ chối) và `readServerObject` (bounded 16 MiB) cho sidecar. |
| `services/orchestrator/src/modules/artifacts/artifacts.ts` | Option `encryption?: WorkerArtifactEncryption` (:108) + validation (:127); `requestUpload` seal-mode: proxy-only, pin `upload_token` = objectVersion (:221-226); `putBlob` seal trước khi ghi, ghi ciphertext + sidecar cho PG **và** S3 và pin `storage_version_id`+`manifest_version_id` ở STAGING (:686-785); `finalize` nhánh sealed: đọc raw sidecar, `openRead` đúng pinned version, decrypt-verify plaintext, commit plaintext business metadata + ciphertext version (:417-485); `getBlob` decrypt server-side + tamper/legacy strict refusal (:858-910); `putPublicArtifact` fail-closed khi encryption bật (:790); map lỗi mới sang HTTP (503 TEMPORARY_UNAVAILABLE / 409 STATE_CONFLICT). |
| `services/orchestrator/src/modules/artifacts/multipart-service.ts` | Option `encryptionRequired?: boolean` (:212, default = boot predicate `encryptionIsRequired`); `assertWorkerMultipartSealingAvailable` (:275) gọi ở worker `init` (:778), `grantPart` (:877), `complete` (:901) → 501 `ENCRYPTED_MULTIPART_UNAVAILABLE` **trước khi** có session/upload/presign; `abort` vẫn mở. |
| `packages/worker-sdk/src/storage-policy.ts` (**mới**) | `ARTIFACT_STORAGE_POLICY_CODES` + `isArtifactStoragePolicyCode` — bề mặt policy cho worker transport. |
| `packages/worker-sdk/src/artifact-streams.ts` | `ArtifactStreamErrorCode` thêm `STORAGE_POLICY_REJECTED`; tách `readErrorResponse` (giữ machine code + detail bounded) khỏi `readErrorDetail`; PUT `uploadArtifactStream` map 501/policy code → `STORAGE_POLICY_REJECTED` (không retry ngầm). |
| `packages/worker-sdk/src/artifact-multipart.ts` | `retryablePutStatus(501) = false`; part PUT policy refusal → `STORAGE_POLICY_REJECTED` thay vì 5xx retry. |
| `packages/worker-sdk/src/index.ts` | Export storage-policy + `readErrorResponse`/`ArtifactErrorResponse`. |
| `packages/worker-sdk/tests/sec-enc-04-storage-policy.test.ts` (**mới**) | 6 test offline: mã policy, map 501→non-retryable (một attempt), 503 vẫn retry theo budget, abort session khi policy refusal. |

### Quyết định thiết kế chính

1. **Seal ở server, không ở worker** (SD-03 fix ưu tiên): worker gửi plaintext qua internal transport (được phép theo user exception transport-only); Orchestrator seal trước byte đầu tiên chạm store. Worker không giữ key.
2. **Carrier tương thích reader canonical**: AAD `{tenantId, artifactId, objectVersion=upload_token, purpose}` + marker/metadata giống public gateway; sidecar lưu **raw envelope/manifest** — đúng shape `parseManifest` của `modules/encryption/artifact-read-decrypt` tiêu thụ — nên reader canonical mở được worker objects mà **không cần thêm envelope format thứ hai**; PG đọc decrypt trong `getBlob`. `requestUpload` pin `upload_token` mới cho mỗi worker grant (column vốn chỉ dùng cho public) — đây là objectVersion cho AAD.
   - **Quan sát MISMATCH (pre-existing, ngoài packet):** smoke ban đầu phát hiện `upload-encryption-gateway.ts` (public branch) ghi sidecar **có wrapper** `{version,kind,...,encryption}` trong khi `parseManifest` chỉ parse **raw** envelope. Đây là lệch pha sẵn có giữa gateway writer (đang được lane khác sửa trong working tree, +114/-24) và canonical reader — worker carrier của packet này chủ động chọn raw để tương thích reader hiện tại; coordinator cần đưa mismatch gateway/reader vào lane public-api/encryption để public upload live không vỡ.
3. **Tách plaintext/ciphertext metadata**: `artifacts.sha256/size_bytes` = plaintext business (dùng cho output refs/download verify); `storage_version_id` = ciphertext generation (PG content hash / S3 VersionId); `manifest_version_id` = sidecar generation (S3 VersionId / PG content hash). Finalize replay semantics giữ nguyên theo plaintext metadata.
4. **Fail-closed mọi thiếu hụt**: thiếu seam/backend writer/sidecar/unsealed row trên strict → 503/409, không có plaintext fallback; S3 write thiếu VersionId → xoá object và từ chối.

## 4. Bằng chứng (cwd `D:\Git\dugate\du-rework`, Node v22.16.0)

| # | Lệnh | Kết quả | Raw |
|---|---|---|---|
| 1 | `pnpm --filter @du/orchestrator run typecheck` | exit **0** | (rỗng) |
| 2 | `pnpm --filter @du/orchestrator run build` | exit **0** | (rỗng) |
| 3 | `node coordination/reports/raw/sec-enc-04-seal-roundtrip.cjs` | **37/37 checks PASS**, exit **0** — seal/open single + chunked (>5 MiB), ciphertext-only (sentinel không xuất hiện), wrong-tenant/tamper refusal, PG facade server-write/pin/read, S3 facade metadata/versioning (fake client), **canonical `decryptStoredArtifact` mở worker envelope + từ chối sai tenant**, **full service flow** `requestUpload → putBlob (ciphertext) → finalize (READY, plaintext metadata + ciphertext version) → getBlob (plaintext)`, tamper-at-rest → `HASH_MISMATCH`, unsealed row strict → `TEMPORARY_UNAVAILABLE`, multipart guard 501 không chạm DB/presign | `coordination/reports/raw/sec-enc-04-seal-roundtrip-2026-10-06.txt` |
| 4 | `pnpm --filter @du/worker-sdk exec jest tests/sec-enc-04-storage-policy.test.ts` | **6/6 pass** | `coordination/reports/raw/sec-enc-04-worker-sdk-artifact-suites-2026-10-06.txt` (chạy cùng nhóm artifact) |
| 5 | `pnpm --filter @du/worker-sdk exec jest tests/sec-enc-04-storage-policy.test.ts tests/artifact-streams.test.ts tests/artifact-multipart.test.ts tests/artifact-multipart-rss.test.ts tests/artifact-stat.test.ts tests/artifact-read-metadata.test.ts tests/artifact-sweep-guard.test.ts tests/artifact-stream-bounds.test.ts tests/artifact-direct-band.test.ts --runInBand` | **9 suites / 253 passed**, exit 0 | `coordination/reports/raw/sec-enc-04-worker-sdk-artifact-suites-2026-10-06.txt` |
| 6 | `pnpm --filter @du/orchestrator exec jest --config jest.unit.config.cjs --runInBand <17 artifact/storage suites>` | **16 suites passed / 432 tests passed**, exit 1 do **6 failure pre-existing** ở `artifact-read-authorization.test.ts` (không thuộc packet này — §5) | `coordination/reports/raw/sec-enc-04-orchestrator-artifacts-2026-10-06.txt` |
| 7 | `pnpm --filter @du/worker-sdk test` | **31 suites pass / 1 suite fail (1 test) / 1 todo / 711 passed** — failure duy nhất là `crypto-seam.test.ts` port-fidelity **pre-existing** (§5) | `coordination/reports/raw/sec-enc-04-worker-sdk-full-2026-10-06.txt` |
| 8 | `pnpm --filter @du/worker-sdk run lint` | exit **0** | (rỗng) |
| 9 | Targeted typecheck chỉ module artifacts + transitive imports: `pnpm --filter @du/orchestrator exec tsc --noEmit -p ../../coordination/reports/raw/sec-enc-04-tsconfig.json` | exit **0** — chứng minh diff của packet compile sạch | (rỗng) |
| 10 | Compile riêng module set ra outDir tạm: `pnpm --filter @du/orchestrator exec tsc -p ../../coordination/reports/raw/sec-enc-04-build-tsconfig.json` | exit **0**; smoke #3 chạy trên `sec-enc-04-dist` (vì full build bị chặn bởi WIP `modules/webhooks/*` — §5) | (rỗng) |

Smoke harness: `coordination/reports/raw/sec-enc-04-seal-roundtrip.cjs` (fake key provider symmetric in-process; fake Db định tuyến SQL theo shape; fake S3 client; không dùng DB/Redis/S3 thật). Config tạm: `sec-enc-04-tsconfig.json`, `sec-enc-04-build-tsconfig.json`, outDir `sec-enc-04-dist/`.

## 5. Failure pre-existing (không do packet này)

- `packages/worker-sdk/tests/crypto-seam.test.ts` — “port fidelity” so **thân hàm** `packages/worker-sdk/src/crypto-storage.ts` với `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`. Orchestrator facade đã được lane khác thêm `StorageContextAadSchema.parse(...)` trong working tree; worker port chưa sync. Cả hai file **không nằm trong diff của packet này** (tôi không sửa `crypto-storage*`/`crypto-seam*`); failure tồn tại trước khi tôi chỉnh artifact transport. **Cần owner SEC-ENC-01/qwen_2 sync port** trước khi worker-sdk suite xanh toàn bộ.
- `services/orchestrator/tests/artifact-read-authorization.test.ts` — 6 failure thuộc **lease semantics** (`STATE_CONFLICT` vs `PERMISSION_DENIED`, `LEASE_LOST` 409 vs 403) trong `requestAccess`/`assertLease`, là pre-existing working-tree changes của lane khác (file đã dirty trước packet; tôi không sửa `requestAccess`/`assertLease`; lỗi `requestUpload` trong test bắn từ `assertLease` trước nhánh encryption của tôi).
- **Full-package orchestrator typecheck/build hiện đỏ vì WIP của lane khác**: `services/orchestrator/src/modules/webhooks/oauth2-client.ts` (mới, 16:00) lỗi `TS1117 duplicate property`, `outbound-auth.ts` lỗi `TS2304 Cannot find name 'OutboundDispatchResult'`. Hai file này không thuộc packet; vì chúng, `pnpm --filter @du/orchestrator run typecheck/build` toàn package fail dù **module artifacts compile sạch** (bằng chứng #9/#10). Cần lane webhooks sửa trước khi CI toàn package xanh.
- Không có failure nào khác trong các suite artifact/storage đã chạy.

## 6. An toàn / quyền hạn

- Worker **không nhận key/Vault token**: toàn bộ seal/open nằm ở Orchestrator (`CryptoStorageFacade` + `KeyProvider` inject qua boot).
- Untrusted worker không thể “tự khai báo đã mã hóa”: policy được enforce ở admission (chọn proxy-only) và finalize (xác thực envelope); marker/boolean phía client không có giá trị.
- Mọi nhánh thiếu seam/thiếu sidecar/tamper/wrong-tenant đều từ chối trước khi dữ liệu thành READY hoặc được trả về.

## 7. CHƯA làm / OPEN (phải nói rõ)

1. **Boot wiring (`create-app.ts`, ngoài lease)** — feature hiện **off mặc định**. Integrator cần:
   ```ts
   // createArtifactService(db, { ...,
   //   encryption: { facade, keyRef, keyVersion?, required: artifactEncryptionRequired } })
   // createMultipartService(db, { ..., encryptionRequired: artifactEncryptionRequired })
   ```
   với `facade` là `CryptoStorageFacade` của artifact-storage key (S3 hiện tái dùng được `config.publicUploadEncryption`; PG cần key ref artifact-storage riêng từ `DU_VAULT_TRANSIT_OPTIONS.allowedKeyRefs` — thuộc SEC-ENC-01/05). Không có wiring này, worker writes vẫn là plaintext như trước (không hồi quy, nhưng chưa đóng SD-03).
2. **Encrypted multipart writer** — client-driven multipart (parts PUT trực tiếp vào S3) bị **chặn fail-closed 501** khi encryption required, chưa được seal. Đây là quyết định mở giống RFX-03 public branch (“variant (b) server-side seal chưa làm, coordinator quyết”). Cần: streaming ingress qua Orchestrator hoặc sealed-part protocol + manifest carrier (contracts — SEC-ENC-01).
3. **Live verification** — chưa chạy PG thật/S3 thật/Vault thật; acceptance “inspect actual `artifact_blobs.bytes` và S3 bytes/manifests cho cả 3 worker” thuộc VFY-SEC-ENC-01 (cần DB/S3 window). Smoke #3 là bằng chứng offline trên compiled module + fake backend.
4. **Unit test server-side trong repo** — write lease không bao gồm `services/orchestrator/tests/**`, nên packet này không thêm test file ở đó; logic được phủ bằng smoke #3 + các suite hiện có. Tester packet nên chuyển smoke thành suite chính thức.
5. **Worker entrypoints document-core/lc-checker/example-review/template** — server-mediated nên các worker hưởng lợi tự động, không cần key; nhưng nếu entrypoint nào vẫn set `encryptionEnabled` + crypto seam (client-seal cũ), cần qwen_2 thống nhất bỏ/cấu hình lại để tránh double-seal khi boot wiring bật.
6. **Legacy compat inline upload** — fail-closed khi encryption configured (writePublicArtifact ngoài lease, không có envelope carrier). Cần quyết định: bổ sung seam cho compat writer hoặc chấp nhận deprecated.
7. **Docs** — chưa cập nhật `docs/19/28/35` hay connector/artifact docs; đề xuất docs lane sync sau receipt độc lập.

## 8. Files & SHA256 (working tree, chưa commit)

| File | SHA256 (16 hex đầu) |
|---|---|
| `services/orchestrator/src/modules/artifacts/artifact-encryption.ts` (mới) | `A322002A5DD46826` |
| `services/orchestrator/src/modules/artifacts/storage-facade.ts` | `00A1778641EB09B3` |
| `services/orchestrator/src/modules/artifacts/postgres-storage-facade.ts` | `5DC12787E58B5B90` |
| `services/orchestrator/src/modules/artifacts/s3-storage-facade.ts` | `8747087048CA53AC` |
| `services/orchestrator/src/modules/artifacts/artifacts.ts` | `9FF8EADF498B0F4C` |
| `services/orchestrator/src/modules/artifacts/multipart-service.ts` | `9F938C65472F88D0` |
| `packages/worker-sdk/src/storage-policy.ts` (mới) | `0A96AACF29EC65EA` |
| `packages/worker-sdk/src/artifact-streams.ts` | `3BE562D74C0ED174` |
| `packages/worker-sdk/src/artifact-multipart.ts` | `9C8D9FB0ECB10E96` |
| `packages/worker-sdk/src/index.ts` | `EB6A907FD3D84896` |
| `packages/worker-sdk/tests/sec-enc-04-storage-policy.test.ts` (mới) | `345C2184B46220B0` |

HEAD không đổi (`b088eec`), không commit, không tick task row. Worktree đang bẩn bởi nhiều lane song song; các file `crypto-storage.ts`, `crypto-seam.ts`, `artifact-read-authorization.test.ts` là thay đổi/failure của lane khác, không thuộc diff này.

## 9. Đề xuất bước tiếp

1. **Boot integrator** nối `encryption` vào `createArtifactService` + `encryptionRequired` vào `createMultipartService` (§7.1) — đây là điều kiện bắt buộc để SD-03 thực sự đóng.
2. **Coordinator quyết** hướng encrypted multipart (§7.2) trước khi coi acceptance “multipart outputs roundtrip” đạt.
3. **Tester độc lập (VFY-SEC-ENC-01)** chạy live PG/S3 byte-scan trên candidate sau wiring, dùng sentinel; gồm cả tamper/wrong-tenant/keys-off.
4. **Claude Code review** phần carrier/AAD và semantics finalize trước acceptance; parent `SEC-ENC-04` giữ `[ ]`.
