# Verify độc lập (DSH2) — SEC-OR-03 encrypted source storage wiring — 2026-10-11

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/services/orchestrator/**` (chỉ đọc) và hai suite SEC-ENC.
**Tuân thủ COORDINATOR-CONTRACT:** chỉ **đọc** + chạy test/probe offline; **KHÔNG** sửa mã/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** mạng ngoài; receipt **0 ký tự nháy kép** (tự đếm, §7).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (khớp `engines`).
**Raw:** `coordination/reports/raw/verify-sec-03-encrypted-source-2026-10-11/DSH2/` — `01-two-suites.log`, `02-typecheck.log`, `03-dsh2-probe.log`, `04-probe.cjs`, `SHA256SUMS.txt`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| `npm run test:unit -- --runTestsByPath tests/sec-enc-05-boot-wiring.test.ts tests/sec-enc-03-source-s3-encryption.test.ts` | **PASS, exit 0** — `Test Suites: 2 passed, 2 total` · `Tests: 16 passed, 16 total` (7 + 9), `Time: 6.932 s` |
| Typecheck | **exit 0**, 0 diagnostics |
| `create-app.ts:656` đã nối `createS3EncryptedPinnedSourceStorage` chưa? | **RỒI** — `:660-673` chọn writer mã hoá khi `config.publicUploadEncryption && artifactCryptoFacade`, truyền `facade` + `keyRef` (+ `keyVersion`); import ở `:82` |
| Đã bật `requireEncryptedSourceWrites` khi `dataMode = real` chưa? | **RỒI** — `:655` `const requireEncryptedSourceWrites = config.encryptionPolicy?.dataMode === 'real';` và `:681` truyền flag vào consumer |
| Nhánh fallback | **CÒN** — `:674-679` `: createS3PinnedSourceStorage({…})` (writer plaintext cho chế độ không-real) |
| Writer mã hoá có **thật sự seal** không? | **CÓ** — probe P5 với **facade thật**: body lưu **không** chứa sentinel plaintext, có **object sidecar** thứ hai, `manifestVersionId` có trong description, `sizeBytes` = kích thước plaintext; đối chứng writer plaintext **có** chứa sentinel |
| Fail-closed khi thiếu capability | **CÓ** — `createEncryptedSourceStorageWrapper` ném `encrypted source writes are required but the storage adapter does not implement putEncrypted` (probe P4) |
| Probe độc lập của tôi | **5/5 PASS**, exit 0 |

**Một dòng cho coordinator:** SEC-OR-03 **đã được nối đúng** — 16/16 test exit 0, typecheck sạch, `create-app.ts` chọn writer mã hoá + bật `requireEncryptedSourceWrites` khi `dataMode === 'real'`, và probe độc lập xác nhận object nguồn được **seal thật** (không còn plaintext); còn **một điểm vận hành** cần biết: trường hợp `real` **nhưng chưa cấu hình `publicUploadEncryption`** thì app **vẫn boot** và mọi source acquisition **fail-closed ở lúc ghi** (không từ chối boot như khuyến nghị của review) — xem §4.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd `services/orchestrator`) | Exit | Literal |
|---|---|---:|---|
| 1 | `npm run test:unit -- --runTestsByPath tests/sec-enc-05-boot-wiring.test.ts tests/sec-enc-03-source-s3-encryption.test.ts` | **0** | `PASS` ×2 · `Test Suites: 2 passed, 2 total` · `Tests: 16 passed, 16 total` · `Time: 6.932 s` |
| 2 | `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) | **0** | 0 dòng output |
| 3 | probe độc lập DSH2 (`04-probe.cjs`) | **0** | `PROBE_RESULT 5/5 checks passed` |

Artifact:

| File | sha256 (24 ký tự đầu) | mtime | lines | git |
|---|---|---|---|---|
| `src/app/bootstrap/create-app.ts` | `a8a919bcbd9fcb39965f51a5` | 00:33:09 | 1241 | ` M` |
| `src/modules/operations/ingestion-consumer.ts` | `12915987a90f84b7a6c70d40` | 10-10 22:33:55 | 918 | ` M` |
| `src/modules/operations/ingestion-storage-s3.ts` | `4c4f25e75aa9c0923c8dc60f` | 10-07 04:30:18 | 767 | **sạch** |
| `tests/sec-enc-05-boot-wiring.test.ts` | `110fba35e30ed37e8190b447` | 00:33:43 | 302 | ` M` |
| `tests/sec-enc-03-source-s3-encryption.test.ts` | `c50485b88dcb17399d8d9d2c` | 10-07 04:30:18 | 480 | **sạch** |

**Phân rã 16 test:** `sec-enc-05-boot-wiring` 7 test (real ⇒ `requireEncryptedSourceWrites === true` ở `:151/:165`; synthetic ⇒ `false` ở `:168/:182`; synthetic không có cấu hình mã hoá ⇒ adapter tương thích + `false` ở `:185/:202`; cộng wiring artifact/multipart/secret-resolver/health) + `sec-enc-03-source-s3-encryption` 9 test (ciphertext single-shot + chunked, roundtrip reader, tamper/missing envelope fail-closed, abort version khi ghi lỗi, adapter plaintext không chạy được khi thiếu envelope) = **16** ✓.

---

## 2. Audit wiring trong `create-app.ts`

| Dòng | Nội dung | Đánh giá |
|---|---|---|
| `:82-83` | import **cả** `createS3EncryptedPinnedSourceStorage` và `createS3PinnedSourceStorage` | đủ hai nhánh |
| `:655` | `const requireEncryptedSourceWrites = config.encryptionPolicy?.dataMode === 'real';` | **đúng yêu cầu**: chỉ `real` mới bật |
| `:660-673` | `storage: config.publicUploadEncryption && artifactCryptoFacade ? createS3EncryptedPinnedSourceStorage({ bucket, send, db, encryption: { facade, keyRef, keyVersion? } })` | **đã nối** writer mã hoá với facade + keyRef thật |
| `:674-679` | `: createS3PinnedSourceStorage({ bucket, send, db })` | nhánh tương thích cho chế độ không-real |
| `:681` | `requireEncryptedSourceWrites,` | flag tới consumer |
| `ingestion-consumer.ts:634-650` | chỉ bọc `createEncryptedSourceStorageWrapper` khi flag truthy | khớp |
| `ingestion-storage-s3.ts:244-253` | wrapper **ném** khi base thiếu `putEncrypted` | fail-closed |

---

## 3. Probe độc lập — 5/5 (input riêng, facade thật)

| # | Kiểm | Kết quả |
|---|---|---|
| P1 | `resolveDataMode({})` → `real`; `encryptionIsRequired({})` → `true`; `synthetic` thiếu ack → ném; ack đầy đủ (`mode: synthetic-data-exempt`) → `synthetic` | ok |
| P2 | `assertProfileCipherBootPolicy`: real + có bề mặt mã hoá + không key + production → **ném**; có `ENCRYPTION_KEY` → qua; `NODE_ENV=test` → qua; `synthetic` → qua; real **không** bề mặt mã hoá → qua (5 case) | ok |
| P3 | Tĩnh: `requireEncryptedSourceWrites = … === 'real'`; có nhánh encrypted; có nhánh plaintext; flag được truyền; cả hai factory được import; thứ tự nhánh đúng | ok |
| P4 | `hasEncryptedSourceWriteCapability(plaintextWriter) === false`; `createEncryptedSourceStorageWrapper(plaintextWriter, …)` **ném** đúng câu tài liệu | ok |
| P5 | **Facade thật** + S3 giả: writer mã hoá ghi body **không** chứa sentinel, sinh **2 object** (chính + sidecar), description có `manifestVersionId`, `sizeBytes` = kích thước plaintext; writer plaintext (đối chứng) **có** chứa sentinel | ok |

---

## 4. Fail-closed và điểm vận hành cần biết (kết luận từ đọc code, không chạy end-to-end)

Điều kiện chọn writer mã hoá là `config.publicUploadEncryption && artifactCryptoFacade`, **không** phải trực tiếp `dataMode`. Ba tổ hợp:

| Tổ hợp | Boot | Writer được compose | `requireEncryptedSourceWrites` | Hệ quả khi có source acquisition |
|---|---|---|---|---|
| `real` + có `publicUploadEncryption` (+ facade) | boot bình thường | **mã hoá** | `true` | object nguồn được **seal** (P5) |
| `real` + **không** có `publicUploadEncryption` | **vẫn boot** — `assertProfileCipherBootPolicy` (`boot-options.ts:520`) return sớm khi **không** bề mặt mã hoá nào được bật | plaintext | `true` | **fail-closed ở lúc ghi**: wrapper ném `encrypted source writes are required…`; lỗi là `Error` thường nên bị **retry tới `maxAttempts` rồi escalate** ⇒ operation FAILED, **không** có object plaintext nào được ghi |
| `synthetic` (ack đầy đủ) | boot bình thường | plaintext | `false` | ghi plaintext — đúng ngoại lệ đã tuyên bố |

⇒ **Không còn đường nào ghi plaintext khi `dataMode = real`** (an toàn), nhưng khuyến nghị *từ chối boot khi thiếu capability* của review **chưa** được thực hiện: deployment `real` + S3 mà chưa cấu hình `publicUploadEncryption` sẽ **boot được** rồi **hỏng ingestion** (fail-closed) thay vì từ chối ngay lúc khởi động. Đây là **thay đổi hành vi vận hành** cần đưa vào checklist deploy (cấu hình `publicUploadEncryption` trước, hoặc tuyên bố `synthetic`).

---

## 5. GAP / open items

1. **Chưa chạy `createApp` end-to-end** (cần PostgreSQL/Redis) ⇒ ba dòng trong bảng §4 là kết luận **đọc code + probe đơn vị**, không phải boot thật. Đề nghị một lượt live/boot window nếu muốn chốt acceptance.
2. **Boot-time refusal khi thiếu capability** (khuyến nghị gốc của SEC-OR-03) **chưa có**: hiện fail-closed ở lúc ghi. Cân nhắc thêm assert lúc composition để lỗi xuất hiện sớm và rõ hơn.
3. **`create-app.ts` và `ingestion-consumer.ts` đang ` M`** (chưa commit) ⇒ kết luận gắn sha256 tại §1; lane khác sửa tiếp thì phải chạy lại.
4. **Không có bằng chứng live S3/Vault**: probe dùng S3 giả + facade thật với key provider tất định; chưa chạy Vault Transit thật hay bucket thật.
5. **Chưa kiểm kê object plaintext đã ghi trước fix** — review đã nêu việc này; vẫn là việc của owner nếu deployment từng dùng đường plaintext.

---

## 6. Ghi chú trung thực về probe của tôi

Lượt chạy đầu có **1 FAIL (P1) do fixture của tôi**: tôi dựng `DU_SYNTHETIC_DATA_ACK` với `mode: synthetic`, nhưng schema thật (`packages/contracts/src/encryption-persistence.ts:126-135`) yêu cầu literal **`synthetic-data-exempt`** — code từ chối đúng như thiết kế. Đã sửa **probe** (không đụng sản phẩm) rồi chạy lại: **5/5**.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy `npm run test:unit`/`npm run typecheck`/probe offline; **không** sửa mã sản phẩm/test/config/docs; **không** `git add`/commit/push; **không** tick gate; không DB/Redis/S3/Vault; không mạng ngoài.
- File tôi tạo: receipt này + 4 file raw trong `coordination/reports/raw/verify-sec-03-encrypted-source-2026-10-11/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`.
- Tự kiểm theo COORDINATOR-CONTRACT: **0 ký tự nháy kép** (đếm bằng mã hoá ký tự), **0 dòng trailing whitespace**; không hành động ghi nào ngoài `coordination/reports/**`.
