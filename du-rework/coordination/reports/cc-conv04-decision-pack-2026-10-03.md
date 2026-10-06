# CONV-04-DEC — Decision pack: dedupe crypto (CONV-D01) — cc_2

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Spec:** `coordination/dispatch-specs/2026-10-02-…` → this packet (READ-ONLY).
- **Mode:** READ-ONLY. **Zero files changed by this lane** except this receipt. **No gate tick. No commit.** `nocobase-10` not contacted.
- **Subject:** `packages/worker-sdk/src/crypto-storage.ts` (909 lines, HEAD) ↔ `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` (860 lines at HEAD / 935 in working tree).

**TL;DR (VI):** Hai bản crypto **trùng toàn thân tại HEAD** — cả vùng triển khai sau marker giống byte-for-byte (31.306 ký tự chuẩn hoá), **31/31 thân hàm outermost giống hệt** (sau khi chuẩn hoá tên alias provider). Đây là "faithful port" do thiết kế, không phải hai thiết kế khác nhau. Bằng chứng quyết định không nằm ở AST: **RFX-08 (đang dở dang, +77/−2 trên facade) đã làm guard byte-identity ĐỎ ngay lần thay đổi thật đầu tiên** (jest exit 1) và để lại **bất đối xứng bảo mật** — worker-sdk không có bound 64 MiB khi decrypt. Đề xuất: **Option A — package crypto trung lập dùng chung** (adapter key provider giữ tại từng owner), với bộ điều kiện chứng minh ở §4; Option B chỉ là stopgap hợp lệ nếu A không xếp được lịch, nhưng dù chọn A hay B thì **reconcile RFX-08 phải làm ngay** (guard đang đỏ, worker đang thiếu hardening).

## 1. So sánh hai bản (evidence)

### 1.1 Provenance & trạng thái git

- `crypto-storage.ts:5` tự khai: *"FAITHFUL PORT of the orchestrator crypto-storage-facade (ENC-03), not a rewrite… byte-identical on purpose"*; phần không import được là key provider (orchestrator package, worker-sdk bị cấm phụ thuộc).
- `git log` cả hai file: commit `17e96b9` (wave trước). HEAD hiện tại `b088eec`.
- **Working tree hôm nay:** `M services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` — **+77/−2 chưa commit** = RFX-08 + RFX-16 (lane `RFX-CRYPTO`, spec `2026-10-02-2330-RFX-CRYPTO.md`, lease CHỈ orchestrator facade + focused tests). HEAD chưa có RFX-08 (`git show HEAD:… | findstr MAX_DECRYPT` → rỗng).
- Worker-sdk sạch: chưa nhận RFX-08 (lease của RFX-CRYPTO cấm sửa).

### 1.2 Thân hàm trùng (≥20 như plan nói) — số đo chính xác

Công cụ: script scratchpad dùng TypeScript compiler API, trích các function-like node outermost, strip comment + collapse whitespace + chuẩn hoá alias provider (`KeyProvider`/`CryptoKeyProvider`/`CryptoStorageKeyProvider` → `PROVIDER`), so khớp multiset. Cộng thêm đối chiếu vùng byte như chính guard của repo làm.

| Đối tượng | Kết quả |
|---|---|
| **HEAD facade vs HEAD worker** | **31/31 thân hàm giống hệt**; toàn vùng từ marker `export const CRYPTO_STORAGE_CHUNK_SIZE_BYTES` → EOF **giống byte-for-byte** (31.306 ký tự sau chuẩn hoá tên alias) |
| **WORK facade (RFX-08) vs HEAD worker** | **28/31** giống; khác đúng 3 thân: `constructor`, `decryptStream`, `decryptChunkGenerator` (toàn bộ là delta RFX-08) |
| Danh sách thân (worker, HEAD) | `invalidInput, invalidManifest, isRecord, validateText, validateContext, validateEncryptContext, contextAad, singleAad, chunkAad, sha256, decodeBase64, validateWrappedDek, validateWrappedResult, unsignedManifest, manifestMacKey, validateManifest, splitIntoChunks, CiphertextReader.{readExactly,assertEnd,close}, CryptoStorageFacade.{constructor, encrypt, decrypt, encryptStream, decryptStream, wrapDek, unwrapDek, encryptChunkGenerator, decryptChunkGenerator}` |

Kết luận: yêu cầu "≥20 thân trùng" **được xác nhận** — thực tế là trùng toàn bộ implementation.

### 1.3 Exported types

| Nhóm | worker-sdk `crypto-storage.ts` | orchestrator `crypto-storage-facade.ts` |
|---|---|---|
| Provider port | **tự khai + export**: `WrappedDek`, `WrapDekInput`, `CryptoKeyProvider` (2 method) | **import từ `vault-transit-provider`** (`WrappedDek`), không re-export; `KeyProvider` (3 method, có `rewrap`), `WrapDekInput` nằm ở module provider |
| Error | `CryptoStorageErrorCode`, `CryptoStorageError` | giống hệt tên/shape |
| Context/IO | `CryptoStorageContext`, `CryptoStorageEncryptContext`, `EncryptedStorageObject`, `EncryptedStorageChunk`, `EncryptedStorageManifest`, `EncryptedStorageStream` | giống hệt |
| Options | `{ maxChunks? }` | `{ maxChunks?; maxPlaintextBytes? }` — **`maxPlaintextBytes` chỉ có ở working tree (RFX-08), không có ở worker** |
| Consts | `CRYPTO_STORAGE_CHUNK_SIZE_BYTES`, `CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES` | + `CRYPTO_STORAGE_MAX_DECRYPT_BYTES = 64 MiB` (RFX-08, working tree) |
| Facade | `CryptoStorageFacade` | `CryptoStorageFacade` |

Package surface: `packages/worker-sdk/src/index.ts:102-131` re-export tường minh 4 value + 11 type của module crypto + `crypto-seam` API — surface này là public API mà document-core dùng.

### 1.4 Error taxonomy

Hai bản khai **cùng 6 code**: `INVALID_INPUT | SIZE_LIMIT | INVALID_MANIFEST | AUTHENTICATION_FAILED | KEY_PROVIDER_FAILED | STREAM_ABORTED`; cùng `class CryptoStorageError extends Error` (name = `'CryptoStorageError'`, `code` readonly). Khác biệt duy nhất: **là hai class riêng biệt** — `instanceof` không xuyên package (không nơi nào cần điều này hiện tại, nhưng là hệ quả của duplication).

### 1.5 Wrapped-DEK provider shapes

- Field-level **trùng khớp 1:1** giữa `worker-sdk.WrappedDek { keyRef; keyVersion; ciphertext }` và `vault-transit-provider.WrappedDek`; `WrapDekInput` cũng vậy (`keyRef`, `dek: Uint8Array`, `keyVersion?`).
- Khác biệt thật: orchestrator `KeyProvider` có **3 method** (`wrapDek`, `unwrapDek`, `rewrap`) — facade chỉ tiêu thụ `Pick<KeyProvider,'wrapDek'|'unwrapDek'>`; worker khai **2 method**. Về cấu trúc, `VaultTransitProvider` (orchestrator) thoả mãn port 2-method của worker **as-is**.
- Tiền lệ adapter đã có trong repo: `metadata-key-adapter.ts` (Delta 61) chuyển `KeyProvider` → `MetadataKeyProvider` với rationale rõ — mô hình "adapters giữ key provider tại từng owner" không phải đề xuất mới, nó đã tồn tại.

### 1.6 Wire fixtures & độ phủ interop (điểm yếu lớn nhất)

| Loại bằng chứng | Hiện trạng |
|---|---|
| Schema contract | `packages/contracts/src/encryption.ts:252-299`: `StorageWrappedDekSchema` + `StorageEnvelopeRefSchema` (zod, strict, refine byte-length nonce/tag) là **nguồn contract wire**; fixture trong `grant-encryption-envelope.test.ts` chép tay từ output facade (comment nói "If the runtime changes, this file should fail") |
| Golden ciphertext byte-vector | **Không tồn tại** — nonce sinh bằng `randomBytes`, không có seam inject nonce/DEK để tạo vector tất định |
| Cross-read hai chiều (A ghi - B đọc / B ghi - A đọc) | **Không tồn tại dưới dạng test hành vi.** Thứ duy nhất là guard **text byte-identity** (`crypto-seam.test.ts:91-110`) — proxy mức source, không phải hành vi — và nó **đang ĐỎ** (§1.8) |
| Live interop | `rv0104-live-encryption.test.ts` ROW 4-6 (MinIO+Vault, skip nếu thiếu hạ tầng): ROW 6 unwrap DEK bằng raw Vault HTTP + `createDecipheriv` thủ công, nhưng **dùng AAD/nonce/tag lấy từ wire**, single-shot — chứng minh GCM consistency, **không** chứng minh side kia tự dựng lại AAD từ context |
| Tamper/size/abort (same-impl) | Phủ tốt cả hai phía: orchestrator `crypto-storage-facade.test.ts` (~50 test: swap/truncation/reorder/AAD/MAC/maxChunks/context), `crypto-storage-plaintext-bound.test.ts` (RFX-08, untracked), worker `crypto-seam.test.ts` (14), `rv01-03-fail-closed.test.ts`, document-core checkpoint suite |

### 1.7 Import graph / packaging

- **orchestrator → worker-sdk đã tồn tại** (dependency `@du/worker-sdk: workspace:*`) và orchestrator **đã import worker-sdk trong src** (`modules/operations/ingestion-storage-s3.ts:4`, `ingestion-consumer.ts:11`). worker-sdk **không** phụ thuộc orchestrator (chỉ test của nó đọc file orchestrator bằng đường dẫn tương đối `../../services/orchestrator/...` — coupling chỉ dành cho dev).
- Consumer của facade (orchestrator): `server.ts:40` (dùng :607, :620), `modules/public-api/upload-encryption-gateway.ts:30`, `modules/encryption/artifact-read-decrypt.ts:27,33` + 6 test files (facade, plaintext-bound, artifact-read-decrypt-offline, artifact-read-download-route, public-upload-encryption-gateway, rv0104-live).
- Consumer worker-sdk: `index.ts` re-export, `crypto-seam.ts`, `task-context.ts:20` (seal path single-shot; stream path có API nhưng **không có consumer production trong repo**), document-core `worker.ts:77` (types) + :159-167 (`cryptoSeam()`); seam thật do deployment inject qua `config.crypto` (`worker-sdk/src/worker.ts:349`).
- Cả hai package `extends ../../tsconfig.base.json` (target ES2022, module commonjs, strict, `noUncheckedIndexedAccess`). Package trung lập mới sẽ không thêm cạnh phụ thuộc mới cho ai (cả hai đã cùng nằm trong workspace).

### 1.8 Trạng thái sống: guard đã đỏ — phát hiện quan trọng nhất

Guard port-fidelity chạy trong working tree hiện tại:

```
cwd: du-rework/packages/worker-sdk
$ npx jest tests/crypto-seam.test.ts -t "byte-identical"
  × the implementation body is byte-identical to the orchestrator source
    expect(mine).toBe(theirs)  → crypto-seam.test.ts:109
Test Suites: 1 failed, 1 total
Tests:       1 failed, 13 skipped, 14 total
EXIT=1
```

- Nguyên nhân: RFX-08 (+77/−2) trên facade chưa được port sang worker; lease RFX-CRYPTO **cấm** chạm worker-sdk; focused run của RFX-CRYPTO chạy trong orchestrator nên **không thấy** guard này.
- Hệ quả kép: (a) guard thuộc worker-sdk nhưng đọc file orchestrator qua repo layout — chỉ chạy được trong monorepo; (b) worker-sdk hiện **thiếu hard bound 64 MiB** cho `decryptStream`/`openStream` — đúng lỗ hổng RFX-08 vừa bịt ở orchestrator.
- Guard còn **mù có cấu trúc**: nó chỉ so từ marker (`export const CRYPTO_STORAGE_CHUNK_SIZE_BYTES`) trở xuống — phần header, import, và 3 khai báo provider interface (`WrappedDek`/`WrapDekInput`/`CryptoKeyProvider`) **không nằm trong vùng so sánh**.
- Với RFX-08 được merge, ai đó **phải** port hoặc chuyển sang shared — nếu không, hoặc guard đỏ vĩnh viễn, hoặc hai bản lệch hành vi âm thầm.

## 2. Option A — package crypto trung lập dùng chung

**Mô tả:** 1 module impl duy nhất trong package mới `packages/crypto-storage/` (zero dependency vào Orchestrator/Worker; chỉ `node:crypto`, `node:stream`; port `CryptoKeyProvider` 2-method khai tại package). Orchestrator facade và worker-sdk `crypto-storage.ts` trở thành **re-export shim giữ nguyên module path + export name** (consumer không đổi import); `vault-transit-provider` giữ `KeyProvider` 3-method + `rewrap` (adapter/owner tại chỗ); worker giữ `CryptoKeyProvider` như alias re-export.

**Blast radius:**

| Vùng | Việc | Rủi ro |
|---|---|---|
| Package mới | `package.json`, `tsconfig.json`, `src/crypto-storage.ts` (= bản orchestrator đã hardened), `src/index.ts`, test riêng | Thấp (chỉ relocate, không đổi thuật toán) |
| Orchestrator | shim hoá `crypto-storage-facade.ts` (giữ export names, gồm `CRYPTO_STORAGE_MAX_DECRYPT_BYTES`); KHÔNG đổi `server.ts`/gateway/read-decrypt | Thấp–TB; build order mới |
| worker-sdk | shim hoá `src/crypto-storage.ts`, giữ nguyên `index.ts` exports (11 type + 4 value) | TB: nếu tên/alias lệch → document-core compile đỏ (bắt được ngay bằng typecheck) |
| RFX-08 | Bản shared **nhận luôn bản hardened** → worker nhận bound 64 MiB mặc định | **Đây là behavior change phía worker** — phải là acceptance item riêng, không trôi ngầm |
| Test | guard text bị thay bằng conformance/cross-read suite; test hiện có giữ nguyên vị trí hoặc chuyển package | TB: dời test dễ mất coverage nếu không kiểm số |

**Rollout risk:** upfront cost cao hơn B (package mới + 2 shim + build order + consumer matrix), runtime risk thấp nhất (thuật toán không đổi một byte). Rủi ro chính là **export-surface fidelity** của shim và **quyết định semantics bound phía worker**.

**Work items + file lease dự kiến:**
1. Lane "CONV-04-A" (Crypto/Contracts integration owner chốt public API): tạo `packages/crypto-storage/**` + test chuyển đến; chờ RFX-CRYPTO **land trước** để lấy bản hardened làm nguồn.
2. Orchestrator Encryption owner: shim `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` (write lease hẹp, sau khi A1 xong).
3. Worker SDK owner: shim `packages/worker-sdk/src/crypto-storage.ts` + xác nhận `index.ts` không đổi tên.
4. QA: cross-read conformance test (có thể đặt trong orchestrator tests vì được phép import `@du/worker-sdk`) + tamper/size/abort chạy trên bản shared + typecheck cả 3 package.
5. Điều kiện **trước khi bắt đầu**: RFX-CRYPTO đóng (hoặc bản working được chốt làm nguồn chuyển), để không move code đang bị lane khác sửa.

**Điều kiện đóng (closing conditions):**
- Không import ngược: package crypto không import Orchestrator/Worker; worker-sdk vẫn không import Orchestrator; orchestrator không còn định nghĩa crypto thuật toán trùng.
- **Cross-read hai chiều đạt** (single-shot + chunked, cả manifest/MAC/AAD), tamper/size/abort matrix đạt trên bản shared.
- Byte của thuật toán **không đổi trước/sau khi di chuyển** (chứng minh bằng so khớp source vùng impl với HEAD hiện tại sau khi trừ delta RFX-08 đã biết, cộng golden so sánh hành vi bằng fake provider cố định).
- Consumer matrix compile xanh: orchestrator (9 import sites + tests) + worker-sdk (index re-export + doc-core) + live RV01-04 rows 4-6 chạy lại sau cutover.
- `VFY-CRYPTO-CONV` độc lập (theo plan CONV-04) trước khi gọi verified.

## 3. Option B — giữ port có chủ ý + guard tự động

**Mô tả:** giữ 2 bản; (1) thay guard text bằng/bổ sung guard mạnh hơn: phủ **toàn file** (kể cả provider interface + header), (2) thêm **cross-read test hành vi** (orchestrator test import `@du/worker-sdk`: seal bằng bản worker → open bằng bản orchestrator và ngược lại, single + stream), (3) quy trình "mọi thay đổi crypto phải land đồng thời cả hai bản" + escalation khi lease tách (đúng tình huống RFX-CRYPTO hiện nay).

**Blast radius:** worker-sdk `crypto-storage.ts` (port RFX-08 vào — cần lease Worker SDK owner) + `crypto-seam.test.ts` (mở rộng) + 1 test mới phía orchestrator. Nhỏ hơn A về wiring.

**Rollout risk (đo được, không giả định):** maintenance tax định kỳ + đã thất bại một lần ngay thay đổi thật đầu tiên (RFX-08: guard đỏ, worker thiếu hardening). Thêm nữa guard gốc là proxy **yếu hơn** wire-compat (không bao giờ kiểm tra hành vi provider/wiring) nhưng lại **mạnh hơn** mức cần thiết (cấm mọi refactor dù tương đương) — mỗi lần hardening phải là 2 thay đổi + 1 gate thủ công. Guard chỉ chạy được trong monorepo (đọc xuyên package bằng path).

**Work items + lease dự kiến:**
1. **Ngay:** lane phối hợp RFX owner + Worker SDK owner port RFX-08 sang `packages/worker-sdk/src/crypto-storage.ts` (bound + option + SIZE_LIMIT rethrow) + test tương ứng. Quyết định bound phía worker tường minh (mặc định 64 MiB? cấu hình?).
2. QA: mở rộng guard phủ toàn file + thêm cross-read test hành vi; ghi rõ rule lockstep vào tài liệu vận hành (coordination/AGENTS — owner khác).
3. Reconcile guard về xanh trước mọi thay đổi crypto kế tiếp.

**Điều kiện đóng:** guard mở rộng xanh (gồm vùng header/provider); cross-read 2 chiều chứng minh bằng hành vi; worker nhận RFX-08 (hoặc quyết định có rationale rằng worker không cần bound); tamper/size/abort hiện có chạy xanh cả hai phía; rule lockstep + escalation được ghi nhận; `VFY-CRYPTO-CONV`.

## 4. Khuyến nghị + phần phải chứng minh

**Khuyến nghị: Option A** — không phải vì AST giống, mà vì:

1. **Bản sao thứ hai không có giá trị độc lập:** header tự khai "faithful port, byte-identical on purpose" — không tồn tại semantics khác để bảo tồn. Khác biệt duy nhất ngoài thuật toán là **key provider**, mà cái đó *đã* structural-compatible (2-method port) và theo đúng A thì ở lại từng owner như adapter (`metadata-key-adapter.ts` là tiền lệ).
2. **Bằng chứng vận hành, không phải suy đoán:** thay đổi thật đầu tiên ở một phía (RFX-08) đã (a) làm guard đỏ, (b) để lại worker-sdk thiếu hardening — mất an toàn ngay lập tức mà mọi test hiện có vẫn xanh ở phía orchestrator. B không loại bỏ được lớp lỗi này, chỉ gắn thêm người và quy trình canh nó.
3. **Chi phí A chủ yếu là cơ học** (relocate + shim giữ nguyên path/tên), trong khi B tạo nghĩa vụ **vĩnh viễn**: mỗi thay đổi crypto tương lai = 2 lần sửa + 1 cổng lockstep + nguy cơ lệch hành vi âm thầm. Guard của B cũng dị dạng: yếu ở chỗ cần (hành vi/wiring) và mạnh quá ở chỗ không cần (byte refactor).
4. **Ràng buộc kỹ thuật đã sẵn sàng:** cả hai package chung workspace, chung tsconfig base; orchestrator đã depends `@du/worker-sdk`; không có cạnh phụ thuộc mới nào phát sinh cho bất kỳ ai. (Phương án A2 — host trong worker-sdk — khả thi và rẻ hơn về wiring nhưng đặt "shared crypto" dưới tên package Worker; chỉ chọn nếu HQ ưu tiên không mở package mới.)

**Option B chỉ nên chọn khi:** không thể xếp lịch A trong lúc sóng hiện tại — khi đó B vẫn hợp lệ **với điều kiện** port RFX-08 + mở rộng guard + cross-read test như §3; và phải chấp nhận maintenance tax định kỳ.

**Phải chứng minh trước khi chốt (bất kể A hay B — đây cũng là đề xuất nội dung VFY-CRYPTO-CONV):**

| # | Cần chứng minh | Cách |
|---|---|---|
| 1 | Cross-read **hai chiều** single-shot + chunked (manifest/MAC/AAD/DEK) | Test hành vi với 1 fake provider reversible dùng chung: A.encrypt → B.decrypt và ngược lại; stream: encryptStream → JSON-hoá manifest + replay ciphertext → decryptStream |
| 2 | "Golden" ciphertext | Với nonce random, golden byte-vector bất khả thi nếu không có seam inject nonce/DEK. Chốt thay thế: (a) fixtures schema contracts (đã có), (b) source-byte identity trước/sau relocate, (c) cross-read; nếu HQ đòi byte-golden thật → phải thiết kế test-seam inject nonce (quyết định riêng) |
| 3 | Tamper/size/abort matrix trên bản đích | wrong tenant/artifactId/objectVersion; chunk swap/reorder/truncation/appended bytes; nonce trùng; foreign AAD; MAC sai; provider fail; abort giữa stream; >5 MiB single-shot; ≤5 MiB chunked; maxChunks; maxPlaintextBytes (mới) |
| 4 | Provider adapter parity | `VaultTransitProvider` (3-method) thoả port 2-method; worker deployment-provided provider thoả cùng port; live RV01-04 rows 4-6 chạy lại |
| 5 | Consumer/export matrix | 3 import sites src + 6 test orchestrator; `index.ts` worker-sdk 4 value + 11 type; document-core type imports — compile xanh cả 3 package |
| 6 | RFX-08 phía worker | Quyết định bound 64 MiB/cấu hình trước khi worker nhận bản shared; kiểm tra consumer `openStream` production (hiện **không có** consumer trong repo — chỉ tests) |

## 5. Lệnh/kiểm tra đã dùng (literal, cwd, kết quả)

| # | Lệnh | cwd | Kết quả |
|---|---|---|---|
| 1 | `node <scratchpad>\conv04-guard-check.js` (repro normalization của guard repo) | `D:\Git\dugate` | HEAD↔HEAD: `IDENTICAL (31306 chars)`; WORK↔HEAD: `DIVERGED at char 135` (worker=31306, facade=35560) |
| 2 | `node <scratchpad>\conv04-bodies.js` (TS compiler API, outermost bodies) | `D:\Git\dugate` | HEAD: 31/31 identical; WORK: 28/31 (khác: constructor, decryptStream, decryptChunkGenerator) |
| 3 | `npx jest tests/crypto-seam.test.ts -t "byte-identical"` | `du-rework/packages/worker-sdk` | **EXIT=1**; 1 failed, 13 skipped, 14 total; fail tại `crypto-seam.test.ts:109` |
| 4 | `git show HEAD:<facade> \| findstr MAX_DECRYPT maxPlaintextBytes` | `D:\Git\dugate` | rỗng → HEAD chưa có RFX-08 |
| 5 | `git status --short -- <encryption dir> <worker-sdk> <contracts>` | `D:\Git\dugate` | chỉ `M …crypto-storage-facade.ts` (+77/−2, chưa commit) |

(Không chạy suite crypto của orchestrator/worker-sdk đầy đủ — ngoài phạm vi lệnh của packet READ-ONLY; các số liệu trên là đối chứng tĩnh + 1 guard test.)

## 6. Gaps / không làm

- Không sửa file nào (kể cả hai file crypto); chỉ tạo receipt này. Không tick gate, không commit.
- Chưa chạy live RV01-04 (thiếu MinIO/Vault); chưa chạy full suite hai phía (chỉ guard test độc lập + phân tích tĩnh).
- Chưa quyết định thay HQ: đây là decision pack; đề xuất A + danh sách chứng minh §4.
- Việc **cấp bách bất kể lựa chọn**: reconcile RFX-08 với worker-sdk / guard (guard đang đỏ, worker thiếu bound) — cần điều phối với lane RFX-CRYPTO đang giữ working copy.
