# VERIFY ĐỘC LẬP (DSH) — LDBA-06 R4: legacy-workflow-schema-backfill-adapter — 2026-10-09

**Vai trò:** verifier độc lập (DeepSeek-1 / term_8bfe6adc), không phải implementer.
**Ràng buộc đã tuân thủ:** `du-rework` only; KHÔNG sửa code/test/docs; KHÔNG commit / `git add` / push; **KHÔNG tick gate**; **OFFLINE** — không PostgreSQL/Redis/Vault thật, không claim DB window; không đọc `.env.live`; receipt này **không chứa ký tự double quote** (đã tự quét, xem §6).
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233`.
**Node:** v22.23.3 (PATH) cho lượt chính; v24.21.0 (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`) cho lượt khớp môi trường owner.
**Raw:** `du-rework/coordination/reports/raw/verify-ldba-06-2026-10-09/DSH/` (`test-stdout.log`, `test-stderr.log`, `test-node24.log`, `tsc-stdout.log`, `tsc-stderr.log`, `SHA256SUMS.txt`).

## 1. Đối tượng kiểm

| Path | Trạng thái git | Digest sha256 |
|---|---|---|
| `src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts` (465 dòng) | `??` untracked | `4d5b753a3fe9998ff44be076e9e0010d66f85a3c6faa521e3a37c94bd5d0dbed` |
| `tests/legacy-workflow-schema-backfill-adapter.test.ts` (440 dòng) | `??` untracked | `8c65feb0b3bc6f49448f9e74d116905b7a6190f68f444392e549827b6fe074e6` |
| `coordination/reports/ldba-06-workflow-schema-adapter.md` (71 dòng) | `??` untracked | `f16e6a913a626b86beeda16f706a90d22be5e943e3b1cbb2e4ff2b2b6ef82184` |

## 2. Bước 1 — chạy unit test độc lập (stdout / stderr / REAL_EXIT)

Lệnh chính (node PATH v22.23.3), stdout và stderr ghi **riêng**:
```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-workflow-schema-backfill-adapter.test.ts 1> test-stdout.log 2> test-stderr.log
```
- **REAL_EXIT = 0** (đo bằng `$LASTEXITCODE` ngay sau lệnh, không pipe)
- **stdout = 0 byte** (rỗng) · **stderr = 2526 byte** (jest ghi summary ra stderr như thường lệ)
- Summary literal (từ stderr, đã bỏ ANSI/CRLF):
```
Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
Snapshots:   0 total
Time:        2.494 s, estimated 3 s
```
- **Không có block lỗi** (0 hit ký hiệu chấm tròn đỏ) và không có dòng FAIL.

Lượt lặp khớp môi trường owner (v24.21.0):
- **REAL_EXIT = 0** · `Test Suites: 1 passed, 1 total` · `Tests: 7 passed, 7 total` · `Time: 2.187 s`
⇒ xanh trên **cả hai** runtime, khớp claim của owner (Node v24.21.0, 7 test, exit 0).

7 test trong suite (nguyên văn tên):
1. `round-trips a connector schema through the production writer and reader`
2. `derives and round-trips static HTTPS origins inside parallel branches`
3. `skips dynamic, non-HTTPS and userinfo egress with a reason and writes no row`
4. `rejects an unsealed catalog row through the production reader`
5. `is idempotent on a second run and reports a writer compare-and-swap race as a skip`
6. `matches tenant-name preflight, seed, and duplicate-name semantics`
7. `chooses the greatest byte-order key for an updatedAt tie and lists every loser`

## 3. Bước 2 — typecheck / syntax

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
- **TSC_REAL_EXIT = 0** · **`tsc_error_lines = 0`** · `tsc_errors_touching_ldba06 = 0`
- Syntax của file test cũng đã được xác nhận gián tiếp: ts-jest biên dịch và chạy được toàn bộ 7 test (nếu sai cú pháp/kiểu, suite không thể PASS).
- Nguồn adapter import **thuần**: `:1-4` (module nội bộ cùng service), `:5` `import type { Db } from '../../db/db'` (type-only), `:6` `import type { MetadataCrypto } from '../runtime/metadata-crypto'` (type-only), `:7` (module nội bộ). Không import driver DB, không import HTTP client.

## 4. Bước 3a — tính toàn vẹn (double quote + trailing whitespace)

Quét trực tiếp 3 file R4 (dùng `[char]34` để biểu diễn ký tự double quote, không gõ ký tự đó vào lệnh):

| File | Số dòng | Dòng chứa double quote | Dòng có trailing whitespace |
|---|---:|---:|---:|
| `legacy-workflow-schema-backfill-adapter.ts` | 465 | **0** | **0** |
| `legacy-workflow-schema-backfill-adapter.test.ts` | 440 | **0** | **0** |
| `ldba-06-workflow-schema-adapter.md` (receipt owner) | 71 | **0** | **0** |

**Đối chiếu claim của owner** (receipt họ, dòng 64): họ khai `git diff --check` exit **2** và 2 dòng trailing whitespace nằm ở file **ngoài phạm vi**. Tôi chạy lại độc lập:
- `GIT_DIFF_CHECK_EXIT = 2` ✅ khớp
- Đúng **2** dòng bị báo, cả hai ở `du-rework/orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx:445` và `:599` (file ` M` của lane khác) ✅ khớp; bản thân file đó có đúng 2 dòng trailing whitespace
⇒ Owner khai **trung thực**; 3 file R4 sạch cả double quote lẫn trailing whitespace.

## 5. Bước 3b — ranh giới an toàn (không live DB, không Vault thật)

| Chỉ báo | src adapter | test | Kết luận |
|---|---:|---:|---|
| `new Pool` · `new Client` · `createConnection` · `DATABASE_URL` · `process.env` · `psql` | 0 | 0 | **không tự mở kết nối DB** |
| `fetch(` · `http.request` · `https.request` · `axios` · `listen(` · `connect(` | 0 | 0 | **không gọi mạng** |
| `import type ... from 'pg'` | 0 | 1 (`import type`) | chỉ là **type-only import** trong test, không tạo driver/connection |
| `new VaultTransitProvider` | 0 | 1 | provider được dựng với `fetchImpl` **tiêm vào** (`test:78`), `vaultAddress` chỉ là trường cấu hình (`test:74`) |
| `global.fetch` / `globalThis.fetch` | 0 | 0 | không rơi về fetch toàn cục |

`fetchImpl` trong test là hàm cục bộ (`test:41`) trả về các `Response` tổng hợp: nhánh mã hoá trả ciphertext giả, nhánh giải mã dùng `createDecipheriv` với khoá cục bộ (`test:60-71`) — tức **emulator Transit trong bộ nhớ**, không có socket nào được mở. Adapter nhận **source reader** và **Db** qua tham số/interface (dependency injection), không tự kết nối.
⇒ **Ranh giới offline được giữ**: không live DB, không endpoint Vault thật. (Tôi không claim DB window; đây là kết luận **tĩnh** trên mã + việc suite chạy với fake `Db`.)

## 6. Tự kiểm ràng buộc của chính receipt này

- Receipt này được quét lại sau khi ghi: **0 dòng chứa ký tự double quote**, **0 dòng có trailing whitespace** (cùng phương pháp §4).
- Chỉ ghi đúng 2 artifact: receipt này + thư mục raw log của lượt này; **không** sửa code/test/docs/plan, **không** commit / `git add` / push, **không** tick gate nào.

## 7. GAP

1. **Ngữ nghĩa nghiệp vụ chỉ được chứng minh qua 7 test offline** với fixture tổng hợp; **chưa có** inventory legacy thật, chưa chạy backfill thật — đúng như owner tự ghi ở mục Open items #2. Tôi **không** xác minh được số liệu slug/loser/skip/origin thực tế.
2. **Cả 3 file R4 chưa commit** (`??`) ⇒ kết quả gắn với working tree; nếu file đổi tiếp, verification này hết hiệu lực (digest ghi ở §1).
3. **Không chứng minh được tuyệt đối** rằng không có tiến trình nào khác từng chạm live DB/Vault trong lúc test chạy — tôi chỉ chứng minh **mã R4 không chứa đường gọi** như vậy và suite chạy với fake `Db` + `fetchImpl` tiêm vào.
4. **`tests/migrations.test.ts` và các suite live-gate khác không được chạy** ⇒ không tính là pass trong lượt này (offline).
5. Receipt owner ghi **overwrite R3**; tôi chỉ đọc bản R4 hiện có, không đối chiếu lại nội dung R3 cũ.
