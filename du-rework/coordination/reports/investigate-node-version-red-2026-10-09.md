# Điều tra RED phụ thuộc phiên bản Node — 2026-10-09

**Vai trò/phạm vi:** investigator chỉ đọc, chỉ `du-rework`. Không sửa source/test/config; không chạy test, PostgreSQL hoặc Redis; không đọc `.env.live`; không commit, stage, push hoặc tick gate. Kết quả Node bên dưới lấy từ raw receipt đã có và bối cảnh người dùng cung cấp, không phải lượt chạy mới.

## Câu 1 — Assertion thất bại

Test duy nhất đỏ là `streams chunked encryption with downstream backpressure and keeps the object size exact` (`orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts:679`). Các assertion trước đó kiểm tra downstream đọc trước khi producer hết dữ liệu, manifest dạng chunked và kích thước ciphertext (`:700-706`). Assertion RSS ở `:709` là assertion đỏ duy nhất theo raw receipt:

```ts
expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024);
```

Log Node v24.21.0 ghi nguyên văn:

```text
expect(received).toBeLessThan(expected)

Expected: < 171966464
Received:   218525696
```

Đây là `L1-run1.txt:39-40`; assertion tương ứng nằm tại `L1-run1.txt:46` và summary ở `L1-run1.txt:56`. Ba lần lặp có cùng kết quả `1 failed, 11 passed, 12 total`; các giá trị `Received` quan sát được lần lượt là `218525696`, `212004864`, `218222592` (`raw/verify-public-upload-2026-10-09/DSH/L1-run1.txt:39-40`, `L1-run2.txt:39-40`, `L1-run3.txt:39-40`).

## Câu 2 — Đại lượng làm test phụ thuộc Node

`rssBefore` và `rssGrowth` lấy chênh lệch `process.memoryUsage().rss` (`tests/public-upload-encryption-gateway.test.ts:691-693`). Đây là resident set size của **toàn process**, không phải bộ đếm byte nguồn, số chunk hay số byte còn trong stream. Ngưỡng dùng `size * 4 + 64 * 1024 * 1024` ở `:680,709`; `size` là single-shot limit 5 MiB cộng 20 MiB, theo hằng số ở `orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade.ts:18-19`.

Các receipt cho thấy cùng ngưỡng đỏ trên Node v24.21.0 và xanh trên v22.16.0 (`coordination/reports/verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:30-36`). Điều đó xác lập tương quan theo runtime, nhưng **không tự xác định** phần RSS tăng thêm đến từ allocator/runtime Node hay từ đường code nào. Nhận định RSS bị nhiễu mạnh bởi fixture bên dưới là suy luận từ cách fixture giữ buffer, không phải phép đo production.

## Câu 3 — Product logic và test double

`gatewayFor()` trong test tạo **implementation sản phẩm thật** `createPublicUploadGateway()` và `new CryptoStorageFacade(...)`, nhưng truyền vào DB giả và `MemoryS3` giả (`tests/public-upload-encryption-gateway.test.ts:204,413,439-469`). Với object lớn hơn ngưỡng 5 MiB, gateway gọi `encryptStream`, bọc stream và gửi `PutObject` (`orchestrator/services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:461-479`). `CryptoStorageFacade` dùng async generator, chunk 4 MiB và stream high-water mark 8 MiB (`orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade.ts:18,408-430,650-690,757-804`). Vì vậy encryption/backpressure path là product code; nguồn và sink của test là fixture.

Fixture làm phép đo RSS không đại diện trực tiếp cho S3 production: `bytesOf()` giữ toàn bộ chunk rồi `Buffer.concat()` (`tests/public-upload-encryption-gateway.test.ts:46-56`); `MemoryS3.storeObject()` còn giữ body và thêm một bản `Buffer.from(object.body)` vào `objectWrites` (`:77-82`); `send()` đọc toàn stream qua helper này (`:102-119`). Do đó test chủ động tích lũy và sao chép ciphertext trong process đo RSS.

`src/modules/runtime/metadata-crypto.ts` là **product logic thật** cho JSON metadata nhỏ ở control plane, không phải fixture (`:2-13,286-335`). Chính comment nói payload là inline JSON, không phải document body, nên không dùng streaming facade (`:11-13`). Test upload này nhập `CryptoStorageFacade`, không `metadata-crypto` (`tests/public-upload-encryption-gateway.test.ts:14-24`). `metadata-crypto.ts` không phải đường code gây assertion đỏ này.

## Câu 4 — Engine pin và kết quả runtime đã ghi nhận

| Nơi pin | Dòng `engines` nguyên văn | File:line |
|---|---|---|
| Workspace `du-rework` | `"node": ">=24.21.0 <25"` | `du-rework/package.json:17-20` |
| Service `@du/orchestrator` | `"node": ">=24.21.0 <25"` | `du-rework/orchestrator/services/orchestrator/package.json:45-47` |

| Node | Kết quả suite đã ghi nhận | Bằng chứng |
|---|---|---|
| v24.21.0 | 3 lần lặp, mỗi lần exit 1; `1 failed, 11 passed, 12 total` | `coordination/reports/verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:30-33`; raw lần 1–3 nêu trên |
| v22.16.0 | exit 0; `12 passed, 12 total` | `coordination/reports/verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:36`; `coordination/reports/raw/verify-public-upload-2026-10-09/DSH/L6-and-skipped.txt:1-4` |

Node v22.16.0 nằm ngoài engines pin của cả workspace và service; kết quả xanh ở đó là so sánh runtime, không chứng minh tương thích với runtime được hỗ trợ. Raw receipt còn có lần Node 24 với `NODE_ENV` unset vẫn đỏ (`verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:33,39-40`).

## Câu 5 — CI hoặc script cố định Node

Trong `du-rework`, không tìm thấy `.github/workflows` hoặc CI pipeline có bước chạy suite này; các package scripts gọi Jest chung, không chọn phiên bản Node (`du-rework/package.json:12`, `du-rework/orchestrator/services/orchestrator/package.json:11-12`).

Có script offline smoke kiểm tra Node 24.21+ (`du-rework/scripts/test-orchestrator-local.cjs:6-9`), nhưng danh sách suite của script ở `:14-24` không gồm `tests/public-upload-encryption-gateway.test.ts`. Vì vậy script có version guard nhưng không phải runner của test đỏ này. Kết quả tìm file trong phạm vi `du-rework` được lưu trong raw log của điều tra.

## Câu 6 — Phương án sửa tối thiểu được đề xuất

**Phương án tốt nhất — chỉ đổi test fixture/test, không đổi product:** điều chỉnh chính test `streams chunked encryption with downstream backpressure and keeps the object size exact` tại `tests/public-upload-encryption-gateway.test.ts:679-709`, không tạo test trùng. Cho `MemoryS3` một chế độ sink không giữ body lớn: tiêu thụ stream chậm, đếm tổng ciphertext bytes, hash và kích thước chunk rồi bỏ từng buffer; vẫn giữ manifest nhỏ cần cho assertions (`:46-56,77-82`). Thay phép đo RSS bằng assertion xác định được: downstream đọc trước khi producer hoàn tất (`:700-701`), tổng byte đếm bằng `size`, manifest báo đúng tổng và nhiều chunk (`:702-706`), và chunk phát ra không vượt `CRYPTO_STORAGE_CHUNK_SIZE_BYTES` (`crypto-storage-facade.ts:18`). Có thể đặt pause/release gate trong sink để chứng minh producer bị backpressure, thay vì dùng thời gian RSS của process.

Thiết kế này giữ nguyên `createPublicUploadGateway` và `CryptoStorageFacade` thật, nhưng loại bỏ việc fixture lưu/nhân bản toàn bộ ciphertext. Phạm vi thay đổi đề xuất chỉ ở test file trên; chưa có thay đổi nào được áp dụng.

**Hai phương án bị loại:**

1. **Chạy/pin suite về Node v22.16.0:** bị loại vì vi phạm cả hai engines pin `>=24.21.0 <25`; nó che đỏ trên runtime được hỗ trợ (`du-rework/package.json:18`, service `package.json:46`).
2. **Nới ngưỡng RSS cho đến khi Node 24 xanh:** bị loại vì biến một ngưỡng process-wide vốn phụ thuộc runtime/fixture thành ngưỡng tùy tiện và có thể che regression bộ nhớ thật; fixture hiện giữ body lẫn bản sao (`tests/public-upload-encryption-gateway.test.ts:46-56,77-82`).

## Câu 7 — Residual còn mở

- Test vẫn đỏ trên runtime được pin; phương án trên chưa được implementation owner áp dụng hoặc xác minh. Tôi không sửa test/product và không tick gate.
- Assertion hiện tại không phải benchmark memory của production S3; nếu cần cam kết RSS thực, cần packet benchmark riêng với sink và process cô lập.
- `tests/migrations.test.ts` vẫn là live-gated tại `orchestrator/services/orchestrator/jest.unit.config.cjs:18,28`; không chạy và không tính pass, theo thông tin đã cung cấp.
- Trạng thái đọc-only cuối cho `tests/public-upload-encryption-gateway.test.ts` là `M`; receipt verifier trước đó ghi nhận thay đổi +17 dòng trong test-double `createDb()` (`coordination/reports/verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:70-84`). Tôi không chạm file test đó.
- **Vượt scope đọc-only cần ghi nhận:** một lệnh tìm pipeline ban đầu dùng đường dẫn repo root thay vì giới hạn `du-rework` và đã đọc `.github/workflows/docs.yml:1-38`. Không có file nào ngoài hai artifact receipt/raw bị ghi; tôi đã dừng mọi kiểm tra ngoài scope. Kết luận Câu 5 ở trên chỉ dựa trên `du-rework`.

**Xác nhận:** lane này chỉ đọc source/log, không chạy test, không dùng PostgreSQL/Redis, không đọc `.env.live`, không sửa source/test/config/docs ngoài việc tạo receipt và raw log theo deliverable, không commit/stage/push, không sửa `docs/21-openapi.json`, và không tick `VERIFIED`/`ACCEPTED`/`IMPLEMENTED`.

Raw log: [commands-and-excerpts.txt](raw/investigate-node-version-red-2026-10-09/commands-and-excerpts.txt).
