# WTV-05 — Verify CRX / ENC-META seam (CRX-01, CRX-02, ENC-META-FIX-G1) — 2026-10-03

**Dispatch:** 2026-10-03T13:52+07:00 (coordinator command-code) · **Lane:** read-only + test
**Boundary:** READ-ONLY — KHÔNG sửa source/test/plan; chỉ ghi receipt này. Không tick gate; không commit; không chạm `nocobase-10`.
**Acceptance (WTV row):** `crx01/crx02/enc-meta-sentinel` suites pass; không vỡ replay/submission test hiện có.
**Kết luận chung: CONFIRMED** — cả 3 mục đúng thiết kế trên code + suite xanh (chi tiết flake/RED-by-design ở §4).

## 1. CRX-01 — seal VALUE trước INSERT + READY re-seal + read cùng seam → CONFIRMED

### 1.1 Submit side: 3 giá trị sealed TRƯỚC khi tx mở (submission.ts)

- `sealSubmitMetadata` export tại `src/modules/operations/submission.ts:117` — seal VALUE as-given (object cho jsonb), không pre-serialize text (comment CRX-01 tại chỗ).
- `sealOutboxSourceUrl` tại `submission.ts:145` — seal `sourceUrl` string dưới binding `(tenantId, 'tasks.payload_ref', rootTaskId)`.
- Pre-tx sealing tại `submission.ts:278-284`: `sealedInputRef` (`operations.input_ref`), `sealedTaskPayload` (`tasks.payload_ref`), `sealedOutboxSourceUrl` — cả 3 tính xong trước `db.tx` tại `:286`.
- INSERTs cùng tx: `operations` `:315`, `tasks` `:351`, `outbox` `:368` (payload `sourceUrl: sealedOutboxSourceUrl`, comment G1 tại `:385` ghi rõ string-khi-không-seam).

### 1.2 Gate side: re-seal READY per-row sau lock (submission.ts:452-532)

- `markIngestionReady` mở tx `:452` → `markIngestionReadyOn` `:454` (`markIngestionReadyOn` export `:465`).
- Re-seal tại `:503-506`: `sealSubmitMetadata` cho `operations.input_ref` (operationId) và `tasks.payload_ref` (task_id) — per-row sau khi đọc `(tenant_id, task_id) FOR UPDATE OF o,t`; không có row → không seal (gate đã đóng).
- Outbox `ready` row mới tại `:524`. `processIngestionTask` `:537` truyền `metadataCrypto` verbatim vào `markIngestionReady`.

### 1.3 Consumer side: mở bằng CÙNG seam, fail-closed (ingestion-consumer.ts)

- `openDispatchSourceUrl` export tại `:282-303`: plaintext string passthrough `:287`; object không-phải-envelope → `NOT_SEALED` `:288-290`; sealed mà không có seam → `KEY_PROVIDER_FAILED` (retryable) `:291-293`; envelope mở qua `readStored(..., allowPlaintext=false)` `:294-298` — **không fallback đọc plaintext từ envelope méo** (comment `:280`).
- Call site `:585-589`: `KEY_PROVIDER_FAILED` → retry/escalate theo attempts `:591-594`; mọi lỗi crypto khác → `escalate(permanentFailure('dispatch sourceUrl cannot be opened under its binding'))` `:595` — quyết định TRƯỚC mọi network/storage work (`:581-582`).
- `payload_ref` mở tại `:610-625` dưới ĐÚNG binding `(tenant, 'tasks.payload_ref', root taskId)` với `allowPlaintext=true` (backfill window, mirror runtime `openMetadata` policy — comment `:600-608`); open fail → escalate phân biệt key-outage (retry) vs corrupt/mis-bound (permanent).
- Cross-check `:633`: `envelope.sourceUrl !== sourceUrl` → permanent — hai bản copy (outbox dispatch payload + task row) phải khớp.

### 1.4 Seam duy nhất từ boot (create-app.ts / server.ts / main.ts)

- `create-app.ts:286-298`: `metadataCrypto` build MỘT lần từ `config.metadataEncryption`, cùng instance cho submission + runtime + ingestion consumer (comment CRX-01). Không config → `undefined`, mọi cột giữ plaintext lịch sử.
- Wiring: submission `:299-308` (`...(metadataCrypto ? { metadataCrypto } : {})`), runtime `:309-313` (positional), consumer `:443-446`.
- `server.ts:248-251` `ServerConfig.metadataEncryption { keyProvider, keyRef }` — tách riêng khỏi artifact key (comment `:243-246`: một flag chung sẽ vô tình rewrite control-plane rows).
- `main.ts:108-115`: `buildEncryptionBootOptions(env)` resolve trước `createApp`, bad surface fail boot (comment RV01-02 `#8` tại `:106-107`).

### 1.5 Seam primitive (metadata-crypto.ts)

- Interface `:171-186`: `seal` / `open` (refuse wrong-context) / `isSealed` / `readStored(value, ctx, allowPlaintext)`.
- `isSealed` `:228-240`: discriminator `version + aes-256-gcm + ciphertext + dek + nonce + tag` — plaintext legacy không bao giờ nhận nhầm.
- `open` `:274-307`: so AAD lưu-trong-envelope với AAD của context TRƯỚC khi decrypt (`timingSafeEqual`, `:287-291`) → cross-tenant/slot replay báo `CONTEXT_MISMATCH`, không lọt tới cipher.
- `readStored` `:309-321`: plaintext chỉ passthrough khi `allowPlaintext=true`; ngược lại `NOT_SEALED` fail-closed.

## 2. CRX-02 — S3 read guard → CONFIRMED (code + suite cô lập)

- `artifact-read-decrypt.ts:191-217` `decryptStoredArtifact`: object missing → 404 `:197`; marker `du-encrypted/aes-256-gcm-v1` (`:39-40`) sai → `encryptionRequired===true` fail 503 `:205-211`, ngược lại passthrough plaintext `:215-216`; sealed mà không facade → 503 `:219-222`; identity/tenant/manifest-pointer check `:226-241`; decrypt fail → 503 (`SIZE_LIMIT` → 413 per RFX-08, `:115-124`).
- `create-app.ts:345-366`: `encryptedWritesRequired = s3 && backend==='s3' && publicUploadEncryption`; `artifactEncryptionRequired = required && !migrationWindowOpen` (`:352`); `artifactDecryptDeps` chỉ tồn tại khi S3+crypto (`:359-366`); comment `:336-344` — không boot path nào default open, ready-for-production read luôn là requiring.
- Route wiring: worker blob `http/routes/runtime.ts:315-320` (`decryptStoredArtifact` trước khi worker thấy bytes, comment CR28-01 `:311-314`); public download `http/routes/public.ts:540-545` (decrypt TRƯỚC khi chọn plaintext/encrypted-delivery branch, `:536-539`); context type `http/route-context.ts:73`.
- `server.ts:176-181`: `migrationWindow` là operator-signed policy cho object tiền-encryption; đóng window → mọi unsealed fail closed.

## 3. ENC-META-FIX-G1 — outbox `sourceUrl` sealed → CONFIRMED

- Write: `sealOutboxSourceUrl` (`submission.ts:145-154`) + pre-tx `:284` + outbox INSERT `:368-385` (§1.1).
- Read: `openDispatchSourceUrl` + call-site fail-closed (§1.3) — G1c RED → XANH trên code.
- Suite `enc-meta-sentinel-outbox-source-url` xanh cô lập (§4).

## 4. Test evidence (cwd `du-rework/services/orchestrator`, offline, literal)

**Batch 5 suite (lần 1):**
```
pnpm exec jest --runInBand tests/crx01-creatapp-metadata-seam.test.ts tests/crx01-metadata-wiring.test.ts tests/crx02-rfx05res-s3-read-guard.test.ts tests/enc-meta-sentinel-outbox-source-url.test.ts tests/enc-meta-sentinel-runtime-refs.test.ts
Test Suites: 2 failed, 3 passed, 5 total
Tests:       2 failed, 19 passed, 21 total   (JEST_EXIT=1)
```
2 fail đã phân loại, KHÔNG phải drift:
1. `crx02-...s3-read-guard` 1 case `connect ETIMEDOUT 127.0.0.1:61734` — va chạm port loopback khi chạy batch. **Chạy lại cô lập: 6/6 PASS, JEST_EXIT=0.**
2. `enc-meta-sentinel-runtime-refs` case `RED GAP DETECTOR: result_ref must not rest as plaintext` (`:281-296`) — **RED by-design**: file header `:1-21` + comment `:292-293` ghi rõ turning-green cần contracts + migration decision (METADATA_SLOTS entry cho `result_ref`), "not a local edit", FINDING pin tại `:259-279` giữ hành vi hiện tại. Đây là G2 (ngoài scope WTV-05 = G1), detector cố ý đỏ.

**Cô lập G1 + CRX-01:**
```
pnpm exec jest --runInBand tests/enc-meta-sentinel-outbox-source-url.test.ts tests/crx01-creatapp-metadata-seam.test.ts tests/crx01-metadata-wiring.test.ts
Test Suites: 3 passed, 3 total
Tests:       11 passed, 11 total   (JEST_EXIT=0)
```

**Regression replay/submission/ingestion (không vỡ):**
```
pnpm exec jest --runInBand tests/submission-metadata-crypto-e2e.test.ts tests/url-ingestion-offline.functional.test.ts tests/url-ingestion-consumer-offline.functional.test.ts tests/url-ingestion-backend-failclosed-offline.test.ts
Test Suites: 4 passed, 4 total
Tests:       87 passed, 87 total   (JEST_EXIT=0)
```

## 5. Verdict

| Mục | Verdict | Căn cứ |
|---|---|---|
| CRX-01 | **CONFIRMED** | seal-before-INSERT (§1.1) + READY re-seal (§1.2) + cùng-seam open fail-closed (§1.3-1.4) + 11/11 suite + 87/87 regression |
| CRX-02 | **CONFIRMED** | marker guard + required/migration-window wiring (§2) + 6/6 cô lập (batch fail = flake port, đã chứng minh xanh cô lập) |
| ENC-META-FIX-G1 | **CONFIRMED** | write seal + read open cùng binding + cross-check (§3) + sentinel suite xanh |

## 6. Phần cần live S3 (nói rõ, không chứng minh được offline)

- S3 thật + versioned bucket + `publicUploadEncryption` configured: object ghi qua gateway có marker; `migrationWindow` mở → legacy unsealed vẫn đọc; đóng window → unsealed fail closed trên cả runtime GET lẫn public download.
- Manifest version pinning (`manifestVersionId`) trên sidecar thật; `encryptionRequired` fail-closed trên object thiếu marker trong deployment required-mode.
- Offline `artifactDecryptDeps` là `null` khi không có S3 client — các nhánh trên chỉ được suite `crx02` cover bằng scripted reader, không phải S3 thật.

*Ranh giới: read-only + chạy test; không sửa file nào; không tick; không commit; không chạm nocobase-10.*
