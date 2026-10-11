# SEC-OR-20261011-03 — Đề xuất nối encrypted source writer (proposal, doc-only)

- **Finding nguồn:** `coordination/reports/orchestrator-security-review-2026-10-11.md:104` — *Bootstrap source ingestion bỏ qua writer mã hóa* (High).
- **Packet:** SEC-03 — **chỉ phân tích + đề xuất, không sửa code.** 0 sửa source/test/migration; không `git add`/`commit`/`push`.
- **Ngày:** 2026-10-11. **Owner:** lane SEC-03. **Trạng thái:** PROPOSAL — chờ owner chốt phạm vi, chưa IMPLEMENTED.
- **Đối chiếu trên working tree:** mọi `file:line` bên dưới đã đọc trực tiếp lúc 2026-10-11, không lấy từ receipt của reviewer.

---

## 1. Lỗi được xác nhận lại trên source

| Nơi | Đọc được |
|---|---|
| `src/app/bootstrap/create-app.ts:656` | composition thật dùng `createS3PinnedSourceStorage({ bucket, send, db })` |
| `create-app.ts:655-675` | **không** truyền `requireEncryptedSourceWrites`; cũng **không** truyền `encryption` |
| `src/modules/operations/ingestion-consumer.ts:464-466` | guard ném ở composition nếu `requireEncryptedSourceWrites` bật mà storage thiếu `putEncrypted` |
| `ingestion-consumer.ts:634-650` | khi flag bật, wrapper `createEncryptedSourceStorageWrapper` tự bind `tenantId`/`artifactId`/`objectVersion` và ghi `encryptedWrite` qua `onWritten` |
| `src/modules/operations/ingestion-storage-s3.ts:391-400` | `createS3EncryptedPinnedSourceStorage` — writer đã tồn tại, **không** được nối |
| `ingestion-storage-s3.ts:204-222` | nó **fail-closed khi dựng** nếu thiếu `encryption.facade` (đủ `encrypt` + `encryptStream`) hoặc `keyRef` không có độ dài 1..256 |
| `ingestion-storage-s3.ts:130-134` | `S3EncryptedPinnedSourceStorageOptions extends S3PinnedSourceStorageOptions` và `S3EncryptedPinnedSourceStorage extends PinnedSourceStorage` ⇒ **superset**, không phải thay thế |
| `src/modules/encryption/boot-options.ts:40` | chính sách real-data đòi mã hoá persistence của mọi producer |

⇒ Kết luận: writer mã hoá **có sẵn và đầy đủ**, thiếu đúng hai thứ ở composition: **capability** (storage port phải expose `putEncrypted`) và **flag** (`requireEncryptedSourceWrites`).

---

## 2. Vì sao MỖI option trong packet không đủ một mình

### 2.1 Option 2 (chỉ truyền `requireEncryptedSourceWrites`) — không khả thi

Storage port hiện tại do bootstrap dựng là `createS3PinnedSourceStorage`, **không** có `putEncrypted`. Nên chỉ bật flag ⇒ `ingestion-consumer.ts:464-466` **ném lúc boot**: `ingestion consumer requires encrypted source writes but the storage adapter does not implement putEncrypted`.

Đó là **fail-closed đúng về bảo mật nhưng hỏng boot**. Nó biến một bug im lặng (ghi plaintext) thành một sự cố khả dụng. Có giá trị như một bước chặn, **không** phải là sửa xong.

### 2.2 Option 1 (đổi `createS3PinnedSourceStorage` → `createS3EncryptedPinnedSourceStorage`) — chưa đủ và có thể gây ảnh hưởng ngoài ý muốn

Ba vấn đề nếu làm đơn thuần, không kèm flag và không kèm điều kiện:

1. **Không còn cơ chế `encryptedWrite`.** Consumer chỉ gắn envelope identity và ghi mô tả mã hoá khi `options.requireEncryptedSourceWrites` đúng (`:634`). Writer được thay mà không bật flag ⇒ vẫn chạy đường plaintext, chỉ là qua một factory khác.
2. **Ảnh hưởng chế độ synthetic/legacy.** `assertEncryptionOptions` (`:204-222`) ném khi chưa cấu hình key. Đổi không điều kiện sẽ làm **không boot được** các deployment chưa bật encryption — trong khi `ingestion-consumer.ts:151-162` ghi rõ cấu hình vắng cờ là *giữ nguyên đường plaintext byte-identical cho môi trường synthetic/legacy*. Đây là hợp đồng có chủ đích, không phải lỗ hổng.
3. **Lộn xộn với wrapper.** Nếu bootstrap vừa thay writer **vừa** để consumer wrap, bọc sẽ gọi `putEncrypted` trên một adapter đã tự mã hoá. Không rõ hợp đồng nào thắng và sẽ khó kiểm chứng — tránh; dùng **một** chỗ mã hoá.

---

## 3. Đề xuất: W1 — cấp capability + flag, và flag lấy từ policy đã tồn tại

### 3.1 Sửa đúng hai chỗ ở `create-app.ts`

**A. Dẫn xuất một hằng số duy nhất cho policy mã hoá của source ingestion** (đặt cạnh `artifactEncryptionRequired`, `:521-525`), tái dùng **nguyên** ba biểu thức đang có sẵn, **không** tự nghĩ ra biểu thức mới:

```ts
// SEC-OR-20261011-03: source ingestion inherits the artifact encryption policy.
// Same three predicates as the artifact path: encryption must be configured,
// the storage backend must be S3, and the operator-signed migration window is
// the only exemption that may leave an unsealed object behind.
const sourceEncryptionRequired = Boolean(s3Client
  && storageConfig.backend === 's3'
  && config.publicUploadEncryption
  && !artifactMigrationWindowOpen
  && !syntheticDataExempt);
```

**B. Dựng storage qua factory mã hoá, có điều kiện, rồi truyền flag:**

```ts
const sourceStorage = artifactCryptoFacade && config.publicUploadEncryption
  ? createS3EncryptedPinnedSourceStorage({
      bucket: storageConfig.bucket,
      send: (command) => s3Client.send(command as never)
        as Promise<{ VersionId?: string; ChecksumSHA256?: string }>,
      db,
      encryption: {
        facade: artifactCryptoFacade,
        keyRef: config.publicUploadEncryption.keyRef,
        ...(config.publicUploadEncryption.keyVersion === undefined
          ? {}
          : { keyVersion: config.publicUploadEncryption.keyVersion }),
      },
    })
  : createS3PinnedSourceStorage({
      bucket: storageConfig.bucket,
      send: (command) => s3Client.send(command as never)
        as Promise<{ VersionId?: string; ChecksumSHA256?: string }>,
      db,
    });
```

rồi trong `createIngestionConsumer`, thêm **một dòng** `requireEncryptedSourceWrites: sourceEncryptionRequired` và dùng `storage: sourceStorage`.

### 3.2 Vì sao đây là cách ít rủi ro nhất

- **Fail-closed có sẵn, tái dùng.** Nếu policy đòi mã hoá mà facade/keyRef vắng mặt thì `sourceStorage` rơi về writer plaintext, cờ được bật, và `ingestion-consumer.ts:464-466` ném lúc boot — đúng yêu cầu của review là *từ chối boot khi thiếu capability*, **không** cần viết guard mới.
- **Envelope do đúng seam.** Facade/artifact key ref là seam mà đường artifact đang dùng (`:475-477`, `:482-490`, `:539-549`). Hai nửa ghi/đọc sẽ dùng chung khoá — đây cũng chính lý do CR28-01/CRX-02 (*một facade instance dùng chung*) được ghi trong code.
- **Không đụng hợp đồng synthetic.** Ở synthetic, `sourceEncryptionRequired = false` ⇒ flag tắt ⇒ wrapper không được dựng ⇒ **đường plaintext giữ nguyên byte-identical** đúng như hợp đồng ghi ở `ingestion-consumer.ts:151-162`.
- **Cờ duy nhất, không có fallback âm thầm.** Không có nhánh nào mà policy đòi mã hoá nhưng hệ thống lặng lẽ ghi plaintext.

---

## 4. FINDING kèm theo (phát hiện mới trong lúc phân tích, cần owner chốt)

Repo hiện đang dùng **ba biểu thức `required` khác nhau** cho **cùng một** quyết định, và chúng **không** đồng nhất:

| Đường | Vị trí | Biểu thức |
|---|---|---|
| ghi artifact | `create-app.ts:488` | `!syntheticDataExempt && !artifactMigrationWindowOpen` |
| multipart | `create-app.ts:504` | `Boolean(config.publicUploadEncryption) && !artifactMigrationWindowOpen` — **không** có synthetic exemption |
| đọc artifact | `create-app.ts:534` | `encryptedWritesRequired && !artifactMigrationWindowOpen` — **không** có synthetic exemption |

Hệ quả: một deployment ở chế độ synthetic với `migrationWindow: false` sẽ cho ghi artifact **không** bắt buộc mã hoá, nhưng **đòi** mã hoá ở multipart và ở đọc. Việc này **có trước** packet này, và nó quyết định đề xuất SEC-03 phải chọn một trong hai:

- **(i)** `sourceEncryptionRequired` theo mô hình ghi artifact (`!syntheticDataExempt && ...`, mô hình đề nghị ở §3.1) — nhất quán với đường ghi artifact;
- **(ii)** theo mô hình đọc/multipart (`không` synthetic exemption) — nhất quán với xác định *production S3 + encryption đã cấu hình ⇒ mọi object đều sealed*.

**Tôi không tự chốt.** Đây là quyết định policy của owner, ảnh hưởng tới synthetic-mode và tới thứ tự đọc/ghi. Đề nghị chốt trước khi triển khai, vì chọn sai bên sẽ làm một synthetic mode đang chạy đổi hành vi hoặc làm production lách được policy.

---

## 5. Không khuyến nghị các hướng sau

- **Đặt cờ cứng `true` ở mọi chế độ:** phá synthetic/legacy (xem §2.2.2) và khiến mọi deployment chưa cấu hình khoá không boot được — ngoài phạm vi một fix.
- **Đặt cờ cứng `false` và chờ SEC-ENC-05:** giữ nguyên đúng lỗi đang có. Không đề xuất.
- **Bọc ở bootstrap bằng `createEncryptedSourceStorageWrapper`:** sinh bọc hai lớp khi consumer cũng wrap (`:634`). Không rõ hợp đồng nào thắng; khó kiểm chứng.

---

## 6. Kiểm kê việc cần làm cùng lúc (theo yêu cầu của chính review)

Review ghi rõ *cần kiểm kê source object đã ghi bằng đường này nếu deployment có sử dụng*. Vì vậy việc triển khai phải gồm:

1. Danh sách bucket/prefix đã ghi bởi `createS3PinnedSourceStorage` qua consumer (URL và IAM S3 ingestion) trong khoảng thời gian cấu hình encryption.
2. Với từng object đã ghi: có dấu sealed marker không, có manifest sidecar không, có đúng `upload_token` + `manifest_version_id` trên row `artifacts` không.
3. Quyết định xử lý object plaintext cũ: giữ (cần cửa sổ đọc, tương tự `artifactStorage.migrationWindow`) hay xoá và cho phép ingest lại. **Không** được giả định là có thể coi chúng như sealed — theo chính review, reader strict có thể từ chối.

Phần này cần đọc bucket thật nên **ngoài** phạm vi offline; chưa được thực hiện.

---

## 7. Kế hoạch xác minh sau khi sửa (chưa chạy)

- URL ingestion và IAM S3 ingestion mỗi loại một ca: object tạo ra là sealed với context đúng `tenantId`/`artifactId`/`objectVersion`; marker + manifest sidecar tồn tại; strict reader đọc được và hash khớp.
- Lỗi provider (403/500) **không** để lại object plaintext; nếu có object thì phải bị dọn hoặc đánh dấu là rác có thể nhận diện.
- Synthetic mode: chạy lại một lượt ingest và xác nhận **không** có envelope nào được tạo (đường plaintext byte-identical, đúng hợp đồng §2.2.2).
- Boot với policy mã hoá bật nhưng **không** cấu hình khoá ⇒ phải **từ chối boot** với thông điệp từ `ingestion-consumer.ts:464-466`, không được chạy tiếp.
- Test offline có thể viết được ở tầng composition: dựng consumer với storage thiếu `putEncrypted` + cờ bật ⇒ ném đúng ở construction (guard đã có, test chỉ ghim hành vi).

---

## 8. Ranh giới

- **Doc-only:** không sửa `create-app.ts`, không sửa `ingestion-consumer.ts`, không sửa test. Không chạy DB/Redis/S3/Vault, không mở cửa sổ live.
- **Không** `git add`/`commit`/`push`. **Không** tick gate.
- **Không** tự chốt §4 — cần owner.
- **Trạng thái:** PROPOSAL, chưa được implement; review finding vẫn còn mở.

---

## RESUME POINT

- SEC-03 = proposal cho `SEC-OR-20261011-03`. Đã xác nhận lỗi trên source: `create-app.ts:656` dùng `createS3PinnedSourceStorage`, không flag, không encryption option; consumer đã có guard `:464-466` và wrapper `:634-650` sẵn.
- **Kết luận:** cả hai option trong packet đều không đủ một mình — option 2 khiến boot hỏng, option 1 đơn lẻ vẫn giữ đường plaintext và ảnh hưởng synthetic. Cần **cả capability lẫn flag** (W1, §3).
- **Cần owner chốt:** §4 — chọn mô hình policy (i) hay (ii), vì repo đang dùng **ba** biểu thức `required` khác nhau ở `:488`, `:504`, `:534`.
- **Chưa làm:** §6 kiểm kê object plaintext đã ghi (cần bucket thật); §7 xác minh sau sửa.
- Ledger: `SEC-03 — 2026-10-11 — proposal, 0 sửa code — chờ owner chốt §4`.
