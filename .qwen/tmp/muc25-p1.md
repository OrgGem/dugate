## 25 — CYCLE 25: W-ENC-04-GRANT-SCHEMA (Δ57 mục 1) — task_34d73cbfbe44, ctx_9b165ca0357b

#### SAI LẦM TRONG PACKET — đã sửa bằng đo, không sửa bằng phỏng đoán
Packet nói: *"Cập nhật `packages/contracts/src/operations.ts` để mở rộng `ArtifactAccessGrantSchema`"*.
Đo thật:

- `ArtifactAccessGrantSchema` **KHÔNG nằm trong `operations.ts`**. Nó ở
  `packages/contracts/src/runtime.ts:226`. Grep `operations.ts` cho `ArtifactAccessGrant` = **0 match**.
- `operations.ts` có `EncryptedArtifactDownloadSchema` + `EncryptedResultEnvelopeSchema`, nhưng đó là
  **recipient delivery envelope** (khoá công khai, cho bên nhận NGOÀI) — **khác** storage envelope.
  Dùng nhầm hai loại đó là lẫn lộn giữa ENC-03 (at rest) và ENC-05/ENC-07 (delivery).
⇒ Tôi sửa file **đúng** (`runtime.ts`), và **không** đụng `operations.ts`.

#### Quyết định thiết kế quan trọng: KHÔNG tái dùng `WrappedDekEnvelopeSchema`
Có **hai** hình DEK trong repo và chúng **khác nhau**:

| | field | dùng ở đâu |
|---|---|---|
| `WrappedDekEnvelopeSchema` (contracts `encryption.ts:67`) | `keyId`, `wrappedKey`, `nonce`, `tag` | ADR-18 delivery/wrap, mặt bên nhận |
| **`StorageWrappedDekSchema` (mới)** | `keyRef`, `keyVersion`, `ciphertext` | storage path, `EncryptedStorageObject.dek` |

Nguồn sự thật là runtime, không phải doc: `vault-transit-provider.ts:42-46`
```ts
export interface WrappedDek {
  readonly keyRef: string;
  readonly keyVersion: number;
  readonly ciphertext: string;
}
```
Nếu tôi tái dùng schema ADR-18, hợp đồng sẽ mô tả một thứ mà facade **không bao giờ ghi ra**, và mọi
object thật sẽ fail với lý do sai (thiếu field, chứ không phải hỏng envelope). Tôi tách riêng và có
test chống lại việc hai hình bị gộp nhầm về sau.

Một điểm tôi **đo** thay vì giả định: `aad` là **base64** chứ không phải JSON thô —
`crypto-storage-facade.ts:528` là `aad: aad.toString('base64')` (AAD bên trong mới là JSON). Nên
regex base64 của `EnvelopeCiphertextSchema` là đúng, tôi giữ nguyên cách đó.

#### Thay đổi (2 file src + 1 file test)

1. **`packages/contracts/src/encryption.ts`** — thêm 2 schema, mirror **field-for-field**
   `EncryptedStorageObject` (`crypto-storage-facade.ts:58-68`):
   - `StorageWrappedDekSchema` — `.strict()`, `keyVersion` **bắt buộc** (không đoán "latest":
     đoán sai sẽ unwrap dưới key đã rotate rồi fail auth với lý do hiểu sai).
   - `StorageEnvelopeRefSchema` — `version`, `algorithm`, `nonce`, `tag`, `aad`,
     `plaintextSizeBytes`, `plaintextSha256`, `dek`. `.strict()` + 2 `.refine()` ép **đúng**
     12 byte nonce / 16 byte tag: base64 hợp lệ nhưng sai độ dài sẽ fail sâu trong cipher với lỗi
     gây hiểu nhầm, nên chặn ngay tại contract.
   - **Không có** `ciphertext` trong schema: byte đó đi qua `downloadUrl`. Đây là *reference*
     tới ciphertext, không phải bản sao — và đó là lý do `ciphertext: Buffer` của
     `EncryptedStorageObject` không xuất hiện ở đây.
2. **`packages/contracts/src/runtime.ts`** — `ArtifactAccessGrantSchema` thêm
   `encryption: StorageEnvelopeRefSchema.optional()` (+ import). **Optional** nên grant plaintext
   cũ vẫn hợp lệ byte-for-byte; server hiện dựng grant bằng cách gán field tuỳ chọn
   (`artifacts.ts:415-435`) nên không phá call site nào.
3. **`packages/contracts/tests/grant-encryption-envelope.test.ts`** (mới, 13 test).

#### Một lỗi của chính tôi, đã bắt và sửa
Test đầu tiên **đỏ 1/13**: tôi khẳng định `WrappedDekEnvelopeSchema` parse được shape delivery của nó,
nhưng fixture của tôi thiếu `version: 1` ⇒ schema **đúng**, **test tôi sai**. Đã sửa fixture (thêm
`version: 1 as const`), không sửa schema để chiều theo test. Đây là bài học quen: khi test mới đỏ,
phải hỏi "ai sai" trước khi sửa.

