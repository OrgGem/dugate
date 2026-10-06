# CC-CRX-01 — Metadata writer seam (P0)

**Lane:** command-code (CRX-01, writer `server.ts` + `submission.ts` + `ingestion-consumer.ts` + `main.ts` + focused tests). **Ngày:** 2026-10-03.
**Trạng thái:** implementation + focused tests + tsc xanh; **KHÔNG tick gate, KHÔNG commit**.
**Nguồn:** `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md` mục CRX-01; source đã được đọc lại trước khi sửa (số dòng dưới là hiện tại).

## 1. Thay đổi theo file (hash `git hash-object`)

| File | Hash | Nội dung |
|---|---|---|
| `src/server.ts` | `42c3e327…` | seam dựng trước submission; truyền vào submission + ingestion consumer (runtime đã có sẵn) |
| `src/modules/operations/submission.ts` | `fae10308…` | sealSubmitMetadata seal **value** (object) thay vì JSON text; gate seal object |
| `src/modules/operations/ingestion-consumer.ts` | `3bdff6e2…` | option `metadataCrypto`; open payload_ref đã seal trước khi chạy mạng; truyền seam vào `processIngestionTask` |
| `src/main.ts` | `93569fb0…` | **KHÔNG đổi** — đã `...encryptionBoot` từ trước (`:108-139`), `config.metadataEncryption` tới createApp |
| `tests/crx01-creatapp-metadata-seam.test.ts` (mới) | `6b85ae8c…` | submit qua createApp + sentinel scan + Vault failure |
| `tests/crx01-metadata-wiring.test.ts` (mới) | `8fe84c5a…` | khoá wiring: 1 instance cho cả 3 writer |
| `tests/url-ingestion-consumer-offline.functional.test.ts` | `9ee2d23d…` | +3 case CRX-01 (sealed gate/replay, mis-bound, Vault outage) |
| `tests/submission-metadata-crypto-e2e.test.ts` | `74d309db…` | 2 assertion cập nhật theo shape mới (nêu ở §4) |

## 2. Wiring (đúng yêu cầu packet)

- `server.ts:560-574` — `metadataCrypto` được tạo TRƯỚC submission (trước đây tạo sau, `server.ts` cũ gọi submission xong mới dựng seam).
- `server.ts:575-584` — `createSubmissionService(..., { maxBlobBytes, storageBackend, metadataCrypto })`.
- `server.ts:585-589` — runtime nhận seam (đã đúng từ Delta 61, giữ nguyên).
- `server.ts:696-699` — ingestion consumer nhận `metadataCrypto` (option mới).
- Tất cả dùng **một** instance `createMetadataCrypto(adaptKeyProviderForMetadata(keyProvider), keyRef)` — cùng key policy, cùng AAD binding.

## 3. Ingestion consumer (dây còn hở trong addendum)

- `ingestion-consumer.ts:95-105` — option `metadataCrypto?: MetadataCrypto`.
- `:531-558` — khi seam bật: `readStored(payloadRef, { tenantId, slot:'tasks.payload_ref', refId: rootTaskId }, allowPlaintext=true)` **trước** mọi network/storage call. Plaintext (backfill window) đi qua như cũ — mirror policy `openMetadata` của runtime. Lỗi phân loại:
  - `KEY_PROVIDER_FAILED` → retryable (retry/escalate theo budget attempt);
  - các lỗi crypto khác (CONTEXT_MISMATCH/AUTHENTICATION_FAILED/…) → permanent `TASK_INVALID` (redelivery không sửa được), gate chưa hề mở.
- `:440-446` — `processIngestionTask(..., commitGuard, metadataCrypto)` → `markIngestionReady` → gate `markIngestionReadyOn` re-seal READY envelope cho từng cột.

## 4. Quyết định kỹ thuật: seal VALUE thay vì JSON text (có bằng chứng)

- `submission.ts:99-130` — `sealSubmitMetadata` giờ seal **giá trị** (`unknown`) thay vì chuỗi JSON đã serialize; nhánh không seam vẫn trả JSON text y hệt lịch sử (`typeof value === 'string' ? value : JSON.stringify(value)` → byte-identical).
- `submission.ts:241-255` — submit bind `seal(submission.input)` / `seal({input,...,sourceUrl})`; `:451-479` — gate bind `seal(withIngestionSource(input, receipt))`.
- **Lý do root-cause:** bản cũ seal chuỗi JSON (`JSON.stringify(input)`), nên envelope mở ra trả về **string**. Điều đó phá `ExecutionSnapshotSchema.payloadRef: z.record(...)` / `resolvedInputRef: z.record(...)` (`packages/contracts/src/runtime.ts:60,69`) mà worker SDK zod-parse khi `claimTask` (`packages/worker-sdk/src/runtime-client.ts:176-178`) — nghĩa là nếu chỉ wire seam như addendum mà giữ shape cũ, mọi task được submit với encryption sẽ **claim fail ở SDK**. Không có dữ liệu production nào mang shape chuỗi (trước packet này server chưa từng truyền seam vào submission — chính là lỗi CRX-01), nên đổi shape là an toàn; 2 assertion cũ trong `submission-metadata-crypto-e2e.test.ts:246-251` và `:514-518` được cập nhật và ghi rõ ở đây (không sửa lặng).

## 5. Inventory writer durable theo ENC-META-01 (đã kiểm)

| Slot | Writer | Trạng thái seam |
|---|---|---|
| `operations.input_ref` | submit INSERT (`submission.ts:254`), gate UPDATE (`submission.ts:472`) | ✅ cả hai được cấp seam |
| `tasks.payload_ref` | submit INSERT (`:255`), gate UPDATE (`:475`), runtime spawnChildren (`runtime.ts:815,821,853,858`), resume/HITL (`:1100,1105`), join (`:1474,1486`), claim read (`:1582`) | ✅ runtime seam đã wire; submit/gate mới wire |
| `human_waits.response_ref` | runtime resume (`runtime.ts:1073-1078`) | ✅ runtime seam |
| `step_checkpoints.output_ref` | runtime saveStep (`runtime.ts:463-469`) | ✅ runtime seam |
| `webhook_deliveries.payload` | `webhooks.ts:96` (live-update deliveryId) | ❌ **vẫn plaintext** — Δ121 đã ghi nhận thuộc ENC-META-01, `webhooks.ts` NGOÀI lease packet này → leftover, nêu ở §8 |
| `outbox.payload` | submission/consumer ghi coordinates + sourceUrl (không chứa document content) | không nằm trong 4 cột inventory; không đổi |

Không còn writer nào khác: `markIngestionReady` chỉ có 1 caller production (`submission.ts:517`); legacy compat đi qua `ctx.submission.submit` (`compat/legacy-host-adapter.ts:65`) nên dùng chung seam.

## 6. Kiểm thử (literal command / cwd / exit)

### 6.1 Focused CRX-01

```
cwd: D:\Git\dugate
> pnpm --dir du-rework/services/orchestrator exec jest tests/crx01-creatapp-metadata-seam.test.ts tests/crx01-metadata-wiring.test.ts tests/url-ingestion-consumer-offline.functional.test.ts tests/submission-metadata-crypto-e2e.test.ts --runInBand

PASS tests/crx01-creatapp-metadata-seam.test.ts (5.271 s)
PASS tests/url-ingestion-consumer-offline.functional.test.ts
PASS tests/crx01-metadata-wiring.test.ts
PASS tests/submission-metadata-crypto-e2e.test.ts
Test Suites: 4 passed, 4 total
Tests:       85 passed, 85 total
Exit code: 0
```

Đối chiếu acceptance:
- **submit inline qua createApp thật** → `operations`/`tasks` INSERT bind envelope (version/algorithm/ciphertext), sentinel không xuất hiện ở bất kỳ depth/base64 nào; mở lại bằng crypto dựng độc lập trên cùng provider → đúng input (chứng minh key policy, không chỉ shape). (`crx01-creatapp-metadata-seam.test.ts` case 1)
- **replay** → cùng Idempotency-Key trả operation cũ, không ghi thêm row operations/outbox (case 2); consumer side replay: sweep 2 claimed=0, 2 envelope REFERENCES không đổi (`url-ingestion-consumer-offline` case 1).
- **failure Vault** → submit reject `MetadataCryptoError/KEY_PROVIDER_FAILED`, **zero write**, không outbox (case 3); consumer gate seal outage → gate vẫn đóng, 2 cột giữ nguyên plaintext đã submit, **không có row dispatch `gate:'ready'`**, escalation `INGESTION_FAILED` (case 3 mới).
- **URL ingestion→READY** → payload_ref sealed mở đúng binding, acquire→pin→materialize→gate, hai cột READY đều sealed + mở ra cùng envelope (có `source.artifactId`), sentinel chỉ tồn tại BÊN TRONG envelope (case 1); payload seal sai row → 0 fetch/0 storage, `TASK_INVALID`, gate đóng (case 2).
- **wiring** → submission/runtime/consumer nhận **cùng một** instance; tắt config → cả ba `undefined` (`crx01-metadata-wiring.test.ts`).

### 6.2 Regression liên quan

```
> pnpm --dir du-rework/services/orchestrator exec jest tests/runtime-encryption-metadata.test.ts tests/rfx10-seed-gate.test.ts tests/rfx11-12-route-hardening.test.ts tests/br12-isolation-offline.test.ts tests/artifact-storage-service.test.ts tests/multipart-routes-offline.test.ts --runInBand
Test Suites: 6 passed, 6 total
Tests:       184 passed, 184 total
Exit code: 0
```

### 6.3 Typecheck

```
> pnpm --dir du-rework/services/orchestrator exec tsc --noEmit -p tsconfig.json && echo TSC_EXITCODE=0 || echo TSC_EXITCODE=NONZERO
TSC_EXITCODE=0
```

### 6.4 Full offline unit suite (phân loại)

```
> pnpm --dir du-rework/services/orchestrator exec jest --runInBand --config jest.unit.config.cjs
Test Suites: 12 failed, 2 skipped, 128 passed, 140 of 142 total
Tests:       69 failed, 29 skipped, 4113 passed, 4211 total
Exit code: 1
```
- 11 suite fail = **pre-existing** (đúng bộ đã chứng minh ở receipt RFX trước: 5 suite verify bằng HEAD-swap `server.ts`, 6 suite có trong baseline cache `.cache/rfx-full.txt`; đều không thuộc packet này).
- 1 suite fail thêm trong lần full = **flake môi trường**: `webhook-error-boundaries.boundary.test.ts` (ETIMEDOUT loopback port ephemeral); chạy lại cô lập: **32/32 PASS**. Không phải regression (không có suite nào mới fail vì thay đổi này).

## 7. Doc-notes (không sửa docs/)

1. Contract ghi chú: envelope của submit/gate khi mở trả về **object** đúng shape plaintext — thay đổi shape chỉ áp dụng cho writer vừa được wire (trước đó không có dữ liệu production nào ở shape chuỗi). Nếu có deployment nào từng tự gọi `createSubmissionService` với seam trong code nhúng riêng, cần đọc lại `submission-metadata-crypto-e2e` (đã cập nhật).
2. `webhook_deliveries.payload` vẫn plaintext (Δ121) — cần packet riêng cho `webhooks.ts`; ghi vào ENC-META-01 remaining.
3. Không đổi env/ops surface: `DU_ENCRYPTION_METADATA_ENABLED` / `DU_VAULT_TRANSIT_OPTIONS` như cũ; `main.ts` không cần chỉnh.

## 8. Unresolved gaps / what was NOT proven

- **Live PG/Vault**: toàn bộ acceptance chạy ở seam offline (scripted `pg` + provider thuận nghịch in-process). Chưa chạy byte-scan trên PostgreSQL thật + Vault Transit thật (cần DB window; ngoài phạm vi packet).
- **Claim path với row sealed**: shape giờ khớp `ExecutionSnapshotSchema` theo cấu trúc (object in → object out), nhưng chưa có test live boot worker SDK claim một task submit-sealed; đề xuất Tester bổ sung trong window (submission → claim snapshot parse).
- **webhook_deliveries.payload** (Δ121) — vẫn hở, ngoài lease.
- **OUTBOX payload** không nằm trong 4-cột inventory; hiện chỉ chứa coordinates + sourceUrl (không document content) — nếu ENC-META-01 muốn phủ thêm thì là quyết định mới.

## 9. Verdict

**PASS tại seam offline/unit-equivalent** cho CRX-01: một `metadataCrypto` instance được dựng trước và truyền vào cả submission/runtime/ingestion consumer; submit inline + URL ingestion→READY + replay + Vault-failure đều có bằng chứng sentinel-scan và "không dispatch nếu seal lỗi"; kèm bản sửa shape (object thay string) để claim path không vỡ khi encryption bật. Focused 4 suite / 85 test + regression 6 suite / 184 test PASS, `tsc` exit 0; full unit suite không phát sinh regression (1 flake re-run xanh). Live PG/Vault chưa chạy — liệt kê §8. Không tick gate, không commit.
