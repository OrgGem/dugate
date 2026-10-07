# Result envelope — hợp đồng trả kết quả (RESULT-WIRE-01)

> **Nguồn:** contract đọc trực tiếp từ `orchestrator/packages/contracts/src/operations.ts` và `encryption.ts`; bằng chứng đóng băng tại [RESULT-WIRE-01](../coordination/reports/tester.md#L8245).
>
> **Mức bằng chứng: OFFLINE.** Receipt tự ghi: `@du/contracts` build 0, **19 suites / 427 tests** 0; orchestrator `tests/delivery-encryption.test.ts` **22/22** 0; `tsc --noEmit` sạch 0 ở cả hai package. **Chưa có** external consumer thật, live Vault, hay hạ tầng nào. `G-ENC`, `G6` NO-GO; `RESULT-WIRE-01` vẫn `[~]`.
>
> **Tài liệu này mới tạo trong cycle D-DOCS-06-RESULT.** File `docs/06-result-envelope.md` do packet chỉ định **không tồn tại**; catalog public API hiện nằm ở [06-public-api.md](06-public-api.md). File này tách riêng hợp đồng trả kết quả vì nó có hai biến thể theo chính sách tenant, và vì ADR-18/ENC-00 vẫn `[~]`.

## Nguyên tắc chọn biến thể

**Server quyết định, client không chọn được.** Biến thể plain hay encrypted do **chính sách phía server theo tenant** quyết định (Admin toggle `deliveryEncryptionEnabled`). Không có query parameter hay header nào cho phép client bắt server trả plaintext, và cũng không có cách nào bắt nó trả encrypted khi policy đang tắt.

## 1. `GET /operations/{id}/result`

Luôn trả **HTTP 200 JSON**. Chỉ khác nhau ở **shape**.

### 1.1 Plain — `ResultEnvelope` (schemaVersion v1)

Strict, đúng 5 field:

| Field | Kiểu | Ghi chú |
|---|---|---|
| `schemaVersion` | `"1"` literal | Bắt buộc; không có field thừa (`.strict()`) |
| `data` | `unknown` | Theo `outputSchema` của business |
| `artifacts` | `ArtifactRef[]`, mặc định `[]` | Mỗi ref có `artifactId`, `mimeType`, `size`, `sha256`, và tùy chọn `hashSha256`, `download` (URL tương đối) |
| `usage` | `UsageSchema` | Bắt buộc, không có default |
| `warnings` | `string[]`, mặc định `[]` | — |

### 1.2 Encrypted — `EncryptedResultEnvelope` (schemaVersion v1)

Strict, **đúng 3 field** — không lặp lại `data`/`usage`/`warnings`:

| Field | Kiểu | Ghi chú |
|---|---|---|
| `schemaVersion` | `"1"` literal | — |
| `encrypted` | `true` literal | Dấu hiệu nhận biết biến thể |
| `delivery` | `RecipientDeliveryEnvelope` | Giải mã nó cho ra **đúng** `ResultEnvelope` ở 1.1 |

**Client đọc `encrypted === true` để chọn nhánh**, không đoán theo shape. Union contract: `ResultResponseSchema = ResultEnvelopeSchema | EncryptedResultEnvelopeSchema`.

## 2. `GET /artifacts/{id}/download`

Hai biến thể **khác cả content type**, không chỉ khác body.

### 2.1 Plain — raw bytes

Body là **byte thô**, `Content-Type` = **MIME của artifact**. Body chấp nhận `Uint8Array` **hoặc** async byte stream — tức server có thể stream thay vì gom toàn bộ vào RAM. **Không** phải JSON, không base64.

### 2.2 Encrypted — JSON wrapper

| Field | Kiểu | Ghi chú |
|---|---|---|
| `schemaVersion` | `"1"` literal | — |
| `encrypted` | `true` literal | — |
| `delivery` | `RecipientDeliveryEnvelope` | Dùng **chung schema** với biến thể encrypted của `/result`, và cùng strict |
| `artifactId` | **UUID** | Ràng buộc thật, không phải string tự do |
| `mimeType` | string 1..255 ký tự | MIME **phía trong** payload, không chỉ ở header |

Content type của biến thể này là `application/json` (hằng `ENCRYPTED_DELIVERY_CONTENT_TYPE` trong contracts). Union: `ArtifactDownloadResponseSchema = PlainArtifactDownloadBodySchema | EncryptedArtifactDownloadSchema`.

## 3. Điểm dễ đọc sai

- **`/download` không còn 302.** Contract đã đóng băng **200 raw-or-JSON**; trước đây tài liệu mô tả *302 short-lived signed URL*. [06-public-api.md](06-public-api.md) đã được đồng bộ theo cùng cycle đóng băng đó.
- **Hai biến thể encrypted dùng chung một schema `delivery`** — cùng `RecipientDeliveryEnvelopeSchema`, cùng strict. Không có biến thể "encrypted nhưng không có delivery".
- **`mimeType` nằm trong cả hai nơi ở biến thể encrypted**: body field và `Content-Type`. Ở biến thể plain chỉ có `Content-Type`.
- **Không có `Content-Type` riêng cho biến thể result** — cả hai đều là JSON 200.
- **Strict nghĩa là field lạ bị từ chối**, không phải bị bỏ qua.

## 4. Phần chưa có bằng chứng

| Mục | Còn thiếu |
|---|---|
| External consumer | Chưa có client thật giải mã `delivery` trên wire thật |
| Vault | Chưa chạy với Vault thật; `delivery` chỉ được pin bằng test với registry giả lập |
| OpenAPI | **Đã đóng bằng chứng bằng generator, cycle D-OPENAPI-ENC-RESULT.** `docs/21-openapi.json` nay mang `components.schemas` với 8 schema: `ResultEnvelope` v1, `EncryptedResultEnvelope` v1, `RecipientDeliveryEnvelope`, `EncryptedArtifactDownload`, cộng `ArtifactRef`/`Usage` và hai union `ResultResponse`/`ArtifactDownloadResponse`. Path `GET /api/v1/artifacts/{id}/download` đã được publish, và `x-absent` không còn ghi route download là vắng mặt. Đo trên artifact sinh ra: grep `encrypted` = **14** hit, `delivery` = **15**, `schemaVersion` = **9** (trước cycle này cả ba đều **0**). Generator exit 0 hai lần, byte-identical `sha16=c9aae1963f0b0d61`, `info.version` 1.0.0 → 1.1.0. **Mức bằng chứng:** đây là tài liệu sinh tự động kiểm offline, **không** phải consumer thật giải mã `delivery` trên wire thật — xem [Δ-A42-1](../coordination/reports/qwen-docs.md#L3209) |

## 5. Liên kết

- Contract schema: `orchestrator/packages/contracts/src/operations.ts` (`ResultEnvelopeSchema`, `EncryptedResultEnvelopeSchema`, `ResultResponseSchema`, `EncryptedArtifactDownloadSchema`, `ArtifactDownloadResponseSchema`, `ENCRYPTED_DELIVERY_CONTENT_TYPE`)
- Schema mã hóa: `orchestrator/packages/contracts/src/encryption.ts` (`RecipientDeliveryEnvelopeSchema`)
- Catalog public: [06-public-api.md](06-public-api.md)
- Bằng chứng: [RESULT-WIRE-01](../coordination/reports/tester.md#L8245)
- Quyết định kiến trúc: [ADR-18](15-decisions.md)
