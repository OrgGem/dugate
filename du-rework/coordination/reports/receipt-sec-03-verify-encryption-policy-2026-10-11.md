# Receipt — SEC-03 verify encryption policy source path + consolidate 4 requirements (2026-10-11)

> **RESUME POINT — IMPLEMENTED + offline [PASS], CHƯA ACCEPTED.** Phần A: 4/4 claim §0 được xác nhận bằng đọc source + 2 suite bắt buộc xanh 63/63. Phần B: 4 biểu thức `required` đã gộp về một hàm duy nhất `resolveEncryptionRequirement` (`create-app.ts:304-308`), 4 site gọi hàm, `syntheticDataExempt` đã gỡ. Phần C: **chưa chạy** (không mở cửa sổ S3).

- **Lease:** `services/orchestrator/src/app/bootstrap/create-app.ts` + `services/orchestrator/tests/sec-enc-05-boot-wiring.test.ts`
- **Ràng buộc:** KHÔNG git add/commit/push; không tick gate; không tự nhận ACCEPTED; không mở DB/S3 thật.

## 1. Phần A — verify độc lập

| # | Claim spec §0 | Đối chiếu (đọc trực tiếp, trước khi sửa) | Verdict |
|---|---|---|---|
| 1 | `:655` `requireEncryptedSourceWrites = dataMode === real` | Khớp nguyên văn | **ĐÚNG** |
| 2 | `:660-661` chọn `createS3EncryptedPinnedSourceStorage` khi có `publicUploadEncryption` + `artifactCryptoFacade` | Khớp (ternary nhánh có/không crypto) | **ĐÚNG** |
| 3 | `:674` fallback `createS3PinnedSourceStorage` | Khớp | **ĐÚNG** |
| 4 | `:681` `requireEncryptedSourceWrites` đưa vào consumer options | Khớp | **ĐÚNG** |
| 5 | `boot-options.ts:198-201` mặc định `real` khi env rỗng | `resolveDataMode` trả `{ mode: real }` khi `raw === undefined || raw === real`; env lỗi giá trị khác thì throw | **ĐÚNG** |
| 6 | `:209-211` throw khi synthetic thiếu ack | `ackRaw === undefined` → throw *encryption cannot be disabled by an omitted flag* (`:209-212`); value lạ cũng throw | **ĐÚNG** (số dòng lệch 1) |
| 7 | `:219-225` synthetic bắt buộc `approvedBy` + `acknowledgedAt` + `isolatedFromRealData` | `SyntheticDataExemptionSchema.safeParse` fail → throw liệt kê đủ 5 field (mode, reason, approvedBy, acknowledgedAt, isolatedFromRealData) | **ĐÚNG** (số dòng lệch vài) |

### Bằng chứng bằng test (không bằng đọc code)

```
cwd orchestrator/services/orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs \
  --runTestsByPath tests/sec-enc-05-boot-wiring.test.ts tests/sec-enc-03-source-s3-encryption.test.ts \
  tests/encryption-boot-options.test.ts
Test Suites: 3 passed, 3 total
Tests:       63 passed, 63 total
REAL_EXIT: 0
```

- `sec-enc-05` case 1 (`wires encrypted source storage and requires it in real-data mode`) chứng minh **bằng test**: ở real mode `requireEncryptedSourceWrites === true` **và** `typeof consumerOptions.storage.putEncrypted === function` (nhánh `createS3EncryptedPinnedSourceStorage` được chọn). Đây đúng yêu cầu bước 3 của Phần A.
- `sec-enc-03:454` (refuses required encryption when the storage adapter cannot seal) khoá chiều fail-closed.
- `encryption-boot-options.test.ts` khoá bước 4-5 (mặc định real, thiếu ack thì throw).

## 2. Phần B — một hàm, 4 site

- **Hàm duy nhất:** `resolveEncryptionRequirement(dataMode, migrationWindowOpen)` tại `create-app.ts:304-308`, trả `(dataMode ?? real) === real && !migrationWindowOpen`. Comment giải thích tại sao source-write truyền `migrationWindowOpen=false` (migration window chỉ miễn cho object **đã ghi trước**, áp cho dữ liệu mới là mở lỗ hổng cho chính object mới).
- **4 site gọi hàm** (grep = 5 hit, 1 định nghĩa + 4 call, không còn biểu thức boolean rải rác):
  - `:514` artifact write `required`
  - `:530` multipart `encryptionRequired`
  - `:551` doc-artifact `artifactEncryptionRequired`
  - `:679` source write `requireEncryptedSourceWrites` (truyền window `false` — B3)
- **Dọn:** biến `syntheticDataExempt` (`:484` cũ) đã gỡ vì không còn ai đọc (`noUnusedLocals`).
- **B1–B4 đều có test khoá:**
  - **B1** (real ⇒ bắt buộc cả 4): case 1 (source `true`) + case 4 (artifact `required true`, multipart `true`).
  - **B2/B4** (synthetic ⇒ cả 4 plaintext, kể cả multipart): case cũ tên `while still blocking plaintext multipart` đã đổi tên thành `keeps every write path plaintext in synthetic mode, multipart included` và expectation multipart đổi `true → false`; source `false` có case 2 + case 3 khoá.
  - **B3** (window KHÔNG miễn cho source): case mới `never exempts the source-write path, even while the artifact migration window is open` — window mở ⇒ artifact `required false` + multipart `false`, nhưng source vẫn `true`.

## 3. Verification của riêng thay đổi này

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
REAL_EXIT: 0            (output rỗng)

3 suite bắt buộc (xem §1)
REAL_EXIT: 0   Tests: 63 passed, 63 total
```

### Fail-first đã xảy ra (ghi thẳng, không che)

- Vòng full-suite đầu, `sec-enc-05` **đỏ 1 test do lỗi của chính tôi**: case B3 mới thiếu `publicUploadEncryption: PUBLIC_UPLOAD` nên `workerArtifactEncryption` = undefined, khiến `encryption?.required` là `undefined` chứ không phải `false`. Đã thêm field, xanh lại. Đây là bug test tôi viết, **không** phải lỗi source.
- Sau fix: 3 suite bắt buộc 63/63.

### Full offline suite — attribution

```
node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --runInBand
Test Suites: 8 failed, 14 skipped, 254 passed, 262 of 276 total
Tests:       19 failed, 118 skipped, 5333 passed, 5470 total
```

8 suite đỏ, **không suite nào trong lease của SEC-03 đỏ**:

| Suite | Attribution |
|---|---|
| webhook-error-boundaries.boundary / runtime-encryption-metadata / oidc03-role-action-tenant-offline / admin-audit-route / legacy-workflow-schema-backfill-adapter / admin-action-dispatcher | test file **sạch vs HEAD** ⇒ đỏ có sẵn trên HEAD, lane khác đang sửa |
| aweb06-bff-operations (M) / aweb-16a-overview-tenant-operations (??) | **thay đổi chưa commit của lane khác** (git status: `M`/`??`) |

Không suite nào đỏ thuộc `create-app.ts` hay `sec-enc-05`; không có bằng chứng nào cho thấy thay đổi của tôi làm hồi quy suite ngoài lease.

## 4. Phần C — object thật

- **CHƯA CHẠY** trên object thật. Không mở cửa sổ S3 (theo ranh giới). **Ghi rõ: 0 object thật đã được kiểm kê; không con số 0 nào khác được khẳng định.**
- Khi chạy thật cần: với từng object qua đường ghi nguồn, ghi nhận có sealed marker không và có manifest sidecar không, **không** suy đoán chung là sealed.

## §5 Hoàn thành theo spec (7 điều kiện)

| # | Điều kiện | Trạng thái |
|---|---|---|
| 1 | Phần A có bằng chứng chạy thật | **MET** — §1 + 63/63 |
| 2 | Một hàm resolve, 4 site đọc nó, grep hết biểu thức rải rác | **MET** — §2 (5 hit = 1 định nghĩa + 4 call) |
| 3 | B1–B4 bất biến, mỗi cái có test khoá | **MET** — case B1/B4 đổi tên + expectation; case B3 mới |
| 4 | Suite `sec-enc-05` + `sec-enc-03` + `encryption-boot-options` xanh | **MET** — 63/63 exit 0 |
| 5 | Phần C ghi rõ chưa chạy, không ghi 0 cho mục chưa chạy | **MET** — §4 |
| 6 | Receipt 0 nháy kép ASCII, kèm command + exit code | **MET** — đã đo |
| 7 | Không tự nhận ACCEPTED | **MET** |

## 5. Ranh giới đã giữ

- **KHÔNG** git add / commit / push.
- **KHÔNG** tick gate; **không** ghi VERIFIED/ACCEPTED cho WFA/T26/T27 hay bất kỳ gate nào.
- **KHÔNG** sửa `ingestion-consumer.ts`, compose, migration, `.env.*`, docs/, WFA plan.
- **KHÔNG** thêm biểu thức thứ 5 vào bất kỳ file nào; **không** mở cửa sổ DB/S3.
- Sửa đúng 2 file trong lease; file tạo duy nhất: receipt này.
- Zero nháy kép ASCII (COORDINATOR-CONTRACT).
- Cần re-verify nếu đọc sau: cây đang đổi giữa chừng (7 dòng §0 đã lệch số vài dòng sau khi tôi chèn hàm).