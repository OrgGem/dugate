## 24 — CYCLE 24: W-ENC-04-DOC-CORE (task_94c2532781b3) — **BLOCKED, có bằng chứng, KHÔNG sửa code sản phẩm**

#### Quyết định (đọc trước, nói thẳng)
Packet yêu cầu 3 việc trong `businesses/document-core/src/actions/`: (a) actions đọc encrypted
input stream, (b) validate checkpoint lease, (c) ghi checkpoint/result qua `CryptoStorageFacade`
không để lại byte thô. Tôi **không làm (a) và (b)**, vì đo ra chúng là **không khả thi ở tầng
document-core** — không phải vì tôi chọn lười. Chi tiết bằng chứng bên dưới. Tôi giữ lại đúng thứ
tôi chứng minh được và nộp receipt này như một **phát hiện chặn**, không phải như một delivery.

#### Vì sao (a) "actions consume encrypted input streams" là bất khả thi ở đây
Đọc `packages/worker-sdk/src/task-context.ts` trước khi đo:

- **Ghi** (`:601-610`): có seam ⇒ `sealArtifactBytes()` seal trước, upload **chỉ** `sealed.body`
  (= `sealed.encrypted.ciphertext`), `finalizeArtifact` báo **ciphertext** size/sha256.
- **Đọc** (`:637-660`): `read` / `readWithMetadata` / `readStream` gọi thẳng
  `openArtifactStream(grant.downloadUrl, ...)` và trả về byte thô. **Không có `decrypt` ở đâu trên
  read path** — grep `decrypt|crypto|ciphertext` trong `artifact-streams.ts` chỉ trúng
  `createHash` của `node:crypto`.
- Metadata cần để mở (`nonce`, `tag`, `aad`, `wrapped DEK`) **bị vứt**: `sealArtifactBytes` trả về
  `{ body, ciphertextSizeBytes, ciphertextSha256 }` — đếm trong `task-context.ts`: `nonce` 0,
  `tag` 0, `aad` 0, `dek` 0, `EncryptedStorageObject` 0 lần xuất hiện. Không chỗ nào lưu nó.

⇒ **Bằng chứng thực nghiệm** — `packages/worker-sdk/tests/enc-read-roundtrip-proof.test.ts`
(mới, 1 test) chạy qua facade THẬT (`DefaultTaskContext` + `RuntimeClient` + fetch giả lập
loopback), seam thật, provider là transform đảo ngược thật (XOR+HMAC, không phải echo):

- `stored.equals(bytes)` = **false** ⇒ byte bền vững KHÔNG phải plaintext (đúng ý đồ bảo mật).
- `stored.includes(SENTINEL)` = **false** ⇒ không rò plaintext ở storage.
- `readBack.equals(bytes)` = **false** ⇒ **đọc lại ra CIPHERTEXT, không phải tài liệu**.

Test **PASS** ⇒ đây là hành vi thật, không phải tranh luận. Đây là **data-loss bug**: bật seam lên
là mọi artifact mà worker ghi ra không đọc lại được. Nó **im lặng** — không throw, chỉ trả về
byte sai — nên sẽ chỉ lộ ra ở tầng parse phía trên.

Vì sao chữa ở document-core không được: envelope (`EncryptedStorageObject`) là **contract wire**,
phải đi cùng object qua storage + `ArtifactAccessGrantSchema` (contracts `runtime.ts:226-237` —
chỉ có `fileName/mimeType/sizeBytes/sha256`, **không có** trường envelope). Muốn sửa đúng phải
sửa `packages/worker-sdk` + `packages/contracts` + orchestrator, tức **ngoài write scope**
tôi được giao (`businesses/document-core/src/actions/`). Tôi không tự mở rộng sang 3 package khác.

#### Vì sao (b) "validate checkpoint leases" là bất khả thi ở đây
- `StepCheckpointManager.assertActive` (đã có từ cycle trước) chỉ kiểm `ctx.signal?.aborted`.
- Grep `leaseEpoch|leaseExpiresAt` trong `businesses/document-core/src/worker.ts`: **0 match** —
  lease identity **không đi qua** adapter vào internal context. `TaskContext`
  (`src/types/context.ts`) không có `leaseEpoch`/`leaseExpiresAt`/`attempt`.
- Nên "validate lease" ở tầng này hiện **không có gì để validate**: chỉ có abort signal, mà signal
  là hệ quả của một lần gọi runtime bị 409 (lease đã mất), không phải bằng chứng lease còn hợp lệ.
- Thêm lease field = thêm một predicate **không có nguồn sự thật** để so sánh. Đó là loại "trông
  như đã kiểm" mà tôi đã phê phán ở Mục 20 (Δ45) và ở chính cycle này.

#### Phần (c) — ĐÃ CÓ TỪ TRƯỚC, tôi chỉ xác minh lại (không tự ghi công)
`StepCheckpointManager.toStoredForm` (cycle 20) đã seal **giá trị persist** qua `ctx.crypto.seal`
với binding `checkpoint:<stepKey>`, `fromStoredForm` mở khi replay, `assertEncryptionAvailable`
fail-closed **trước** khi step body chạy. 9 test ở `tests/doc-core-crypto-seam.test.ts` (đọc lại
từ source: 3 adapter + 6 checkpoint) phủ đúng các mệnh đề này. ⇒ (c) không còn việc.

