# VERIFY ĐỘC LẬP số 2 (DSH2) — claim node v24 RED — 2026-10-09

**Vai trò:** verifier độc lập #2, chạy lại một claim chưa được xác minh. **Không** viết fix, **không** tick gate.
**Quy tắc đã tuân thủ:** chỉ đọc + chạy test; KHÔNG sửa source/test/config/docs; KHÔNG commit/`git add`/push; KHÔNG tick gate (VERIFIED/ACCEPTED/IMPLEMENTED đều của coordinator); KHÔNG hand-edit `docs/21-openapi.json`; KHÔNG đọc `.env.live`; **OFFLINE** — không PostgreSQL/Redis, **không claim DB window**; chỉ `du-rework`. Không dùng `git checkout`, không làm gì thay đổi cây.
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` (`git log -1 --format=%H`) · `git status --porcelain` = **134 entry** (cây dirty do nhiều lane; tôi không tạo entry nào).
**Raw:** `du-rework/coordination/reports/raw/verify-node24-red-2026-10-09/DSH2/` (`lenh1-run1..2-*`, `lenh2-*`, `lenh3-*`, `lenh4-*`, `lenh5-*`, `sup-*`, `f3-*`, `SHA256SUMS.txt`).

## 0. Xác minh path node v24 (bằng chứng của chính tôi)

| Hạng mục | Giá trị đo được |
|---|---|
| Path packet chỉ định | `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` |
| `Test-Path` | **True** |
| `& <path> -v` | **v24.21.0** |
| Node trên PATH của shell | `C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe` :: **v22.23.3** |
| `NODE_ENV` ambient của shell | `production` (jest pin lại bên trong — xem §5) |

⇒ **Path node v24 TỒN TẠI và chạy được.** Kết luận "máy không có node v24" của lane trước (`coordination/reports/verify-node-version-INDEPENDENT-OC-2026-10-09.md:16`, `:31`) **bị bác bằng chứng cứ trực tiếp** ở trên.

## 1. Bảng lệnh × REAL_EXIT × dòng literal

Mọi REAL_EXIT lấy bằng `$LASTEXITCODE` **ngay sau** lệnh (không `$?`, không pipe qua `tail`, không dùng `Select-Object -Last`); output ghi ra file bằng `*>`.

| # | Lệnh (nguyên văn, cwd service) | Node (path/version) | REAL_EXIT | `Test Suites:` literal | `Tests:` literal |
|---|---|---|---:|---|---|
| L1.1 | `& <n24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | n24 · **v24.21.0** | **1** | `Test Suites: 1 failed, 1 total` | `Tests: 1 failed, 11 passed, 12 total` |
| L1.2 | (y hệt, tiến trình riêng, lần 2) | n24 · **v24.21.0** | **1** | `Test Suites: 1 failed, 1 total` | `Tests: 1 failed, 11 passed, 12 total` |
| L2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | PATH · **v22.23.3** | **0** | `Test Suites: 1 passed, 1 total` | `Tests: 12 passed, 12 total` |
| L3 | `& <n24> … tests/tenant-list-bff-offline.test.ts tests/tenant-list-cursor-codec-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/usage-contracts-integration-offline.test.ts tests/usage-summary.test.ts tests/usage-aggregation.test.ts` | n24 · **v24.21.0** | **0** | `Test Suites: 5 passed, 5 total` | `Tests: 32 passed, 32 total` |
| L4 | `& <n24> … tests/bff-connectors-actions.test.ts tests/admin-connector-view-model.test.ts tests/admin-connector-render.test.ts` | n24 · **v24.21.0** | **0** | `Test Suites: 3 passed, 3 total` | `Tests: 124 passed, 124 total` |
| L5 | `& <n24> node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | n24 · **v24.21.0** | **0** | — | `ERROR_LINES_COUNT=0` (không output) |

**L3 — tách theo từng file (chạy bổ sung trên cùng node v24, để có literal từng suite):**

| File | REAL_EXIT | `Tests:` literal |
|---|---:|---|
| `tests/tenant-list-bff-offline.test.ts` | 0 | `Tests: 3 passed, 3 total` |
| `tests/tenant-list-cursor-codec-offline.test.ts` | 0 | `Tests: 6 passed, 6 total` |
| `tests/f5-bff-tenant-cursor-offline.test.ts` | 0 | `Tests: 2 passed, 2 total` |
| `tests/usage-contracts-integration-offline.test.ts` | 0 | `Tests: 19 passed, 19 total` |
| `tests/usage-aggregation.test.ts` | 0 | `Tests: 2 passed, 2 total` |
| `tests/usage-summary.test.ts` | **1** | **(không có dòng `Tests:`)** — `No tests found, exiting with code 1` ⇒ **SKIPPED do live-gate**, xem §4 |

(3+6+2+19+2 = 32 ✓ khớp `Tests: 32 passed` của lệnh gộp.)

## 2. Hai lần lặp có giống nhau không?

**Giống hệt.** L1.1 và L1.2 là **hai tiến trình riêng**, cùng node v24.21.0, cùng cho `Test Suites: 1 failed, 1 total` · `Tests: 1 failed, 11 passed, 12 total` · `REAL_EXIT=1` ⇒ đỏ **tất định**, không phải flake.

## 3. RED — danh sách nguyên văn

**RED = đúng 1 test, chỉ trên node v24.21.0** (trên node v22.23.3: **KHÔNG CÓ RED**, 12/12 xanh). Nguyên văn block lỗi (từ `lenh1-run1-node24-public-upload.log`):

```
● public upload encryption gateway › streams chunked encryption with downstream
backpressure and keeps the object size exact

    expect(received).toBeLessThan(expected)

    Expected: < 171966464
    Received:   218746880

      707 |     // The mock object store retains ciphertext; this budget includes that
      708 |     // copy and bounded stream buffers, while rejecting another full-file copy.
    > 709 |     expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024);
          |                       ^
      710 |     });
      711 |
      712 |   test('uses S3 multipart only for ciphertext and commits the completed immutable generation', async () => {

      at Object.<anonymous> (tests/public-upload-encryption-gateway.test.ts:709:23)
```

- Assertion: `tests/public-upload-encryption-gateway.test.ts:709` — ngân sách `size * 4 + 64 MiB` = **171 966 464 B** (164 MiB), đo được **218 746 880 B** (≈208.6 MiB) ⇒ **vượt 46 780 416 B (~44.6 MiB)**.
- Đây là **assertion ngân sách RSS (RAM tăng thêm)**, tức đặc trưng theo runtime/allocator — không phải assertion chức năng (số byte ghi ra vẫn đúng: 11 test còn lại của suite đều xanh, gồm cả các test checksum/size).

## 4. SKIPPED — kèm lý do (KHÔNG tính là pass)

| Suite | Trạng thái literal | Lý do |
|---|---|---|
| `tests/usage-summary.test.ts` | `REAL_EXIT=1` · **`No tests found, exiting with code 1`** (không có dòng `Tests:`) | **live-gate**: `jest.unit.config.cjs:21` `'usage-summary\\.test\\.ts$'` trong `liveSuites` |
| `tests/migrations.test.ts` | **không chạy trong lượt này** | **live-gate**: `jest.unit.config.cjs:18` `'migrations\\.test\\.ts$'` ⇒ **KHÔNG tính là pass** |
| `tests/f3-tenant-list-live-db.test.ts` | `REAL_EXIT=0` · `Test Suites: 1 skipped, 0 of 1 total` · `Tests: 2 skipped, 2 total` + warn `f3-tenant-list-live-db.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window.` | **self-gate** `DU_LIVE_INFRA === '1'` (`:41-45`); cần DB → **không có quyền claim DB window**, không tính pass |
| `tests/f3-tenants-route-live.test.ts` | `REAL_EXIT=0` · `Test Suites: 1 skipped, 0 of 1 total` · `Tests: 11 skipped, 11 total` + warn `... SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.` (`:95`) | như trên |

⇒ Lượt này **không có test nào bị bỏ qua ngầm**: mọi skip đều có lý do gate đọc được từ config/log. Tổng **13 test SKIPPED** (2+11) cộng 2 suite live-gated không chạy.

## 5. Kết luận trung thực xanh/đỏ theo từng node version

| Node | Suite | Kết quả |
|---|---|---|
| **v24.21.0** (`%TEMP%\du-node24-security-c025dd92\…`) | `public-upload-encryption-gateway` (12 test) | **ĐỎ** — `1 failed, 11 passed, 12 total`, exit 1, lặp 2/2 lần giống nhau |
| **v22.23.3** (PATH) | cùng suite | **XANH** — `12 passed, 12 total`, exit 0 |
| **v24.21.0** | tenant roster + usage (5 suite chạy được, 32 test) | **XANH** — exit 0 |
| **v24.21.0** | connector (3 suite, 124 test) | **XANH** — exit 0 |
| **v24.21.0** | `tsc --noEmit -p tsconfig.json` | **XANH** — exit 0, 0 dòng lỗi |

**Kiểm chứng bổ sung cho thấy đỏ này KHÔNG do `NODE_ENV`:** cây hiện có pin chưa commit `setupFiles: ['<rootDir>/tests/setup-node-env.cjs']` (`jest.config.cjs`, diff dirty của lane khác; file `tests/setup-node-env.cjs` đặt `process.env.NODE_ENV = 'test'`, xoá `DU_ENVIRONMENT`/`APP_ENV`). Chạy bổ sung `tests/admin-error-boundary-offline.test.ts` trên **v24** với ambient `NODE_ENV=production` → `REAL_EXIT=0`, `Test Suites: 1 passed, 1 total`, `Tests: 42 passed, 42 total` (suite này trước đây đỏ 1 test dưới production) ⇒ **pin đang có hiệu lực**, và RED của public-upload vẫn xuất hiện ⇒ **đặc trưng theo node runtime, không theo env**.

## 6. Đối chiếu với claim của lane trước (ghi cả hai số, KHÔNG hòa giải)

| Claim của lane trước | Nguồn (chỉ đọc) | Số của họ | Số của tôi | Khớp? |
|---|---|---|---|---|
| "Không tìm thấy Node v24.21.0 nào trên máy" ⇒ các lệnh v24 **NOT RUN** | `verify-node-version-INDEPENDENT-OC-2026-10-09.md:16`, `:31`, `:60` | v24: NOT RUN (N/A) | **v24 path tồn tại, `node -v` = v24.21.0, chạy được** | **KHÁC** — tôi bác kết luận "không có node v24" |
| v24 → public-upload RED | `verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:30-32` (3 lần) ; `investigate-node-version-red-2026-10-09.md:47` | `1 failed, 11 passed, 12 total`, exit 1 (×3) | `1 failed, 11 passed, 12 total`, exit 1 (×2) | **KHỚP tuyệt đối** |
| v22 → public-upload xanh | `verify-node-version-INDEPENDENT-OC-2026-10-09.md:46-47` | `12 passed, 12 total`, exit 0 | `12 passed, 12 total`, exit 0 | **KHỚP** |
| Node trên PATH là v22.23.3 | `verify-public-upload-INDEPENDENT-DSH-2026-10-09.md:21` | v22.23.3 | v22.23.3 (`C:\Users\Gem\.local\share\deepseek-cli\…`) | **KHỚP** |

**Khác biệt duy nhất giữa các bên là claim "máy không có node v24" (OC) — claim này sai**; còn lại hai lane kia và tôi trùng số. Tôi **không hòa giải** thêm: chỉ ghi cả hai phía và bằng chứng path/version ở §0. (Lưu ý phương pháp: các lần chạy v24 của tôi thừa hưởng pin `setupFiles` chưa commit, lần của họ chạy dưới ambient `production`; dù khác env, **cùng ra một con số RED** ⇒ càng củng cố kết luận theo runtime.)

## 7. Revision + trạng thái cây (không thay đổi bởi tôi)

- `git log -1 --format=%H` = `72e225ae5465e5a648c34bf31fbabbd182763233`; `git status --porcelain` = **134 entry** (dirty do nhiều lane, liệt kê một phần trong raw/§0).
- Digest sau khi chạy (không đổi ⇒ read-only): `tests/public-upload-encryption-gateway.test.ts` = `019ebb3433da6f5feed0ef44ffe759adcf46658254270fe3f35eef1704226a2e` (**đang ` M`** — thay đổi của lane khác, không phải tôi) · `jest.config.cjs` = `18682c0bd59b7b5bfd50df9b962f1d6909f846d7f133b790f974e4cc68c41574` (**` M`**) · `tests/setup-node-env.cjs` = `1e49d546c898fe2cd51280cf6dab508ae8d22058fbf4f62ab407efd59251879d` (**`??` untracked**).
- Không dùng `git checkout`; không tạo/xoá file sản phẩm; chỉ ghi receipt + raw log của lượt này.

## 8. Xác nhận & giới hạn

- **KHÔNG tick gate nào** (VERIFIED/ACCEPTED/IMPLEMENTED thuộc coordinator). **Không sửa gì** (source/test/config/docs), **không commit/`git add`/push**, không chạm `docs/21-openapi.json`, không đọc `.env.live`.
- **Offline**: không PostgreSQL/Redis/S3; **không claim DB window**; hai suite cần DB đều tự skip và được ghi SKIPPED, không tính pass; `migrations.test.ts` + `usage-summary.test.ts` live-gated, không tính pass.
- **Giới hạn:** chỉ một máy, một bản node v24 duy nhất tại `%TEMP%` (đã kiểm bằng chính lệnh chạy); kết quả RED là **đặc trưng ngân sách RSS theo runtime**, tôi **không** phân tích nguyên nhân sâu (allocator/heap/GC của v24) và **không** đề xuất sửa — đó là việc của owner; không có bằng chứng browser/deployment nào trong lượt này.
