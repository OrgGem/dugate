# VERIFY ĐỘC LẬP (DSH3) — fix p8 của lane `term_ca784044` trên `public-upload-encryption-gateway` — 2026-10-09

**Vai trò:** verifier độc lập, lane khác là tác giả fix p8. **Không sửa gì.**
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG edit source/test/config/docs; KHÔNG commit/`git add`/push; KHÔNG tick gate; KHÔNG đọc `.env.live`; **OFFLINE** (không PG/Redis, không claim DB window); scope `du-rework`.
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · ambient `NODE_ENV=production` (jest pin lại trong tiến trình).
**Node:** v24 = `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` (**tồn tại, `-v` = v24.21.0**) · PATH = `C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe` (**v22.23.3**).
**Digest file test (trước và sau khi chạy, KHÔNG đổi):** `cca893d236ff91afe8c2da5a7a8287018a45195434d9c2ea20a0ad1ff09ee8cf` (mtime 2026-10-08 21:13:45) — **khác** bản tôi chạy hôm trước (`019ebb34…`), tức fix p8 **có** thay file.
**Raw:** `du-rework/coordination/reports/raw/verify-node24-rss-fix-2026-10-09/DSH3/` (`lenh1-run1..2-*`, `lenh2-*`, `lenh4-tsc.log`, `SHA256SUMS.txt`).

## 1. Bảng lệnh × node -v × REAL_EXIT × literal `Tests:`

| # | Lệnh | node -v | REAL_EXIT | `Test Suites:` | `Tests:` |
|---|---|---|---:|---|---|
| L1.1 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | **v24.21.0** | **0** | `Test Suites: 1 passed, 1 total` | **`Tests: 12 passed, 12 total`** |
| L1.2 | (y hệt, tiến trình độc lập lần 2) | **v24.21.0** | **0** | `Test Suites: 1 passed, 1 total` | **`Tests: 12 passed, 12 total`** |
| L2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | **v22.23.3** (PATH) | **0** | `Test Suites: 1 passed, 1 total` | **`Tests: 12 passed, 12 total`** |
| L4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | v22.23.3 (PATH) | **0** | — | `error_lines=0` |
| L5 | `git status --porcelain \| Select-String 'public-upload'` | — | 0 | — | ` M du-rework/orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts` (vẫn **modified**) |

**So với trước fix p8 (đo độc lập cùng ngày, file digest `019ebb34…`):** node v24 khi đó = `Test Suites: 1 failed, 1 total` · `Tests: 1 failed, 11 passed, 12 total` · REAL_EXIT=1 (2/2 lần) — **RED đã hết sau fix p8**, và lần này **không có FAIL ở cả 3 lần chạy** (v24 ×2, v22 ×1).

## 2. LỆNH 3 — Mutation check (assertions có thực sự "có răng"?)

**Lưu ý dòng 29:** tại revision hiện tại, **dòng 29 là `import { route, type RouteContext } from '../src/server';`** — không phải chỗ tả MemoryS3 sink. Sink ghi file temp nằm ở: `:99-101` `enableEncryptedStreamSink()` → `mkdtemp(join(tmpdir(), 'du-public-upload-sink-'))` + `sinkEncryptedObjects = true`; `:117-120` `consumeEncryptedObject()` → `join(directory, \`ciphertext-${++this.sinkFileCount}.bin\`)`; bật sink trong test tại `:787`; dùng tại `:209`. (Báo lệch số dòng, không sửa.)

**Các assertion hiện có (đọc trực tiếp, kèm dòng):**

| Tiêu chí packet hỏi | Có? | Dòng + nguyên văn |
|---|---|---|
| **tổng byte == size** | **CÓ** (4 chỗ) | `:835` `expect(streamed.byteCount).toBe(size);` · `:839` `expect(manifest.ciphertextSizeBytes).toBe(size);` · `:841` `expect(manifest.encryption.totalSizeBytes).toBe(size);` · `:847` `expect(ack.ciphertextSizeBytes).toBe(size);` · `:848` `expect(row.sizeBytes).toBe(size);` |
| **chunk count** | **CÓ** | `:836` `expect(streamed.chunkCount).toBeGreaterThan(1);` · `:838` `expect(manifest.kind).toBe('chunked');` |
| **chunk bound + tổng chunk == size** | **CÓ** | `:843` `expect(manifest.encryption.chunks.every((chunk) => chunk.sizeBytes <= CRYPTO_STORAGE_CHUNK_SIZE_BYTES)).toBe(true);` · `:844` `expect(manifest.encryption.chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0)).toBe(size);` |
| **manifest (nội dung + hash)** | **CÓ** | `:837` `expect(streamed.sha256).toBe(ack.ciphertextSha256);` · `:840` `expect(manifest.ciphertextSha256).toBe(streamed.sha256);` |
| **pause/resume backpressure gate** | **CÓ (thật)** | `:793-794` `let resumeSink!`/`const sinkResume = new Promise<void>((resolve) => { resumeSink = resolve; });` · `:798-800` sink **tự chặn** sau chunk mã hoá đầu (`afterFirstEncryptedChunk = async () => { producerFinishedAtFirstEncryptedChunk = producerFinished; signalFirstEncryptedChunk(); await sinkResume; }`) · `:816` `expect(producerFinishedAtFirstEncryptedChunk).toBe(false);` · `:818` `resumeSink();` · `:834` `expect(streamed.producerActiveAtFirstChunk).toBe(true);` |
| **không giữ bản sao đầy đủ trong RAM** | **CÓ** | `:845` `expect(stored.body.length).toBe(0);` · `:846` `expect(retainedWrite.body.length).toBe(0);` (dựa trên `objectWrites` thật, `:80`/`:178`) |
| **pull-ahead của producer bị chặn** | **CÓ** | `:832` `.not.toBeNull()` · `:833` `expect(s3.sourcePullsAtFirstEncryptedRead).toBeLessThan(pulls);` |

**Nhưng — tiêu chí đo bộ nhớ đã bị XOÁ (không phải nới):** grep `rss|memoryUsage|rssGrowth` trên file = **0 hit**; diff cho thấy **đúng 3 dòng bị xoá**:
```
-    const rssBefore = process.memoryUsage.rss();
-    const rssGrowth = process.memoryUsage.rss() - rssBefore;
-    expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024);
```
Và mock không còn giữ ciphertext trong RAM: `:209` chuyển ciphertext sang sink file, `HeadObject` trả `contentLength ?? body.length`, `GetObject` trả `createReadStream(file)` cho object đã stream ⇒ phần RSS trước đây bị chính mock thổi phồng nay không còn.

**Kết luận mutation check:** các assertion **có răng thật** (chúng bind số byte, số chunk, trần chunk, tổng chunk, sha256 hai chiều, buffer giữ lại rỗng, và một cổng backpressure chặn sink để chứng minh producer còn sống ở chunk đầu; nếu đường streaming hỏng, `streamedObjects.get(STORAGE_KEY)!` là `undefined` ⇒ assertion ném lỗi ngay). **Nhưng test không còn đo RSS/bộ nhớ** — nên nó **không** chứng minh "ngân sách bộ nhớ đã đạt".

## 3. Verdict: fix p8 "thật" hay "fiếng"?

- **KHÔNG phải fiếng (không phải stub/skip):** suite chạy thật và xanh **trên node v24 (2/2 tiến trình độc lập, exit 0)** và trên v22 (exit 0); **số test giữ nguyên 12/12** (không xoá/skip test, không hạ số lượng); `tsc --noEmit` **exit 0**, 0 dòng lỗi; diff là thay đổi kỹ thuật thật (sink ghi file + ~25 assertion mới + một nhánh fake DB `UPDATE artifacts SET operation_id=$2`).
- **NHƯNG đỏ v24 được giải quyết bằng cách THAY tiêu chí đo:** assertion RSS (3 dòng) bị **xoá**, thay bằng assertion **cơ chế** (streaming/backpressure/chunk/byte-exact/hash/không giữ bản sao). Tức: trước đây test khẳng định "RAM tăng < ngân sách" và **đỏ** trên v24; nay test khẳng định "đường ống stream đúng" và **xanh** trên v24 — **không có bằng chứng nào cho thấy mức tiêu thụ RAM trên v24 đã giảm hay đạt ngân sách cũ**.
- **Doc:** grep `du-rework/docs/*.md` cho `rss|RSS|memory budget|ngân sách bộ nhớ|memory ceiling` **không** thấy dòng nào pin trần RSS cho **gateway public upload** này (các hit là về parser/RSS band ở suite khác) ⇒ việc xoá assertion không vi phạm một doc ràng buộc đã biết, nhưng cũng có nghĩa **thuộc tính bộ nhớ giờ không còn được test ở đâu**.
- **Tự đánh giá của receipt fix p8 (chỉ đọc để đối chiếu, không tin):** `fix-public-upload-encryption-gateway-red-2026-10-08.md:19` ghi RED `Exit code: 1`, `:36-38` ghi `Exit code: 0` / `Tests: 12 passed, 12 total`, và `:28` mô tả phần **fake DB** ("models the missing association update"); phần **xoá assertion RSS** không được nêu trong các dòng tôi đọc.
⇒ Chốt lại: **fix thật về mặt code/test (không fiếng), nhưng nó loại bỏ tiêu chí đã đỏ chứ không chứng minh tiêu chí đó đã đạt** — coordinator quyết định có chấp nhận hay cần một phép đo bộ nhớ tách riêng (ví dụ harness RSS riêng, ngoài jest).

## 4. Xác nhận & giới hạn

- **Không sửa gì**: digest file test trước/sau mọi lần chạy **không đổi** (`cca893d2…`); không edit source/test/config/docs; **không tick gate** nào; **không commit/`git add`/push**; không chạm `docs/21-openapi.json`; không đọc `.env.live`.
- **Offline**: chỉ `jest.unit.config.cjs`, không PostgreSQL/Redis/S3; **không claim DB window**; không chạy suite live nào.
- **Giới hạn:** LỆNH 3 là **mutation check tĩnh** (đọc/grep) đúng như packet mô tả, **không** chạy mutant thật vì bị cấm sửa file — nên "assertions có răng" là đánh giá từ nội dung assertion + cơ chế sink, không phải bằng chứng mutant-killed. Không đo RSS trong lượt này (không có harness đo), nên tôi **không** khẳng định gì về mức RAM thực tế trên v24.
