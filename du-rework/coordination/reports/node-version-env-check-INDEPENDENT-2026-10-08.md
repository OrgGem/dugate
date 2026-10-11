# VERIFY ĐỘC LẬP F — phiên bản Node × NODE_ENV, tác động lên 2 nhóm test — 2026-10-08

- **Vai trò:** verify độc lập F, **CHỈ ĐỌC**. Không sửa source/test/config/`package.json`, không commit/add/push,
  không tick gate, không hand-edit `docs/21-openapi.json`, **không đọc `.env.live`**.
- **Offline:** KHÔNG khởi động PostgreSQL/Redis, KHÔNG claim DB window. Scope `du-rework` only.
- **CWD mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
- **Mốc:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` (không đổi); `git status --porcelain` = **93** lúc kết
  thúc (cây đang được nhiều lane ghi song song). Lane này **chỉ ghi receipt này**; raw để ở `%TEMP%\verify-f\`
  ngoài repo (có thể bị xoá — mọi literal cần thiết đã chép nguyên văn vào đây).
- **KHÔNG cài Node, KHÔNG đổi PATH vĩnh viễn.** Mọi lần chạy dùng node trên PATH hoặc **đường dẫn tuyệt đối**
  tới `node.exe` có sẵn; `NODE_ENV` chỉ đặt trong tiến trình con của từng lệnh.

---

## BƯỚC 1 — inventory runtime (nguyên văn)

```
node -v : v22.23.3
where.exe node :
C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node
C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe
C:\Users\Gem\.local\share\deepseek-cli\node_modules\.bin\node
C:\Users\Gem\.local\share\deepseek-cli\node_modules\.bin\node.cmd
C:\nvm4w\nodejs\node.exe
C:\Users\Gem\AppData\Local\hermes\node\node.exe
```
`nvm` có trên máy (`C:\Users\Gem\AppData\Local\nvm\nvm.exe`); `nvm list` → **chỉ có `22.16.0`**.

**Mọi `node.exe` tìm được (bounded scan, không quét toàn đĩa) và phiên bản:**

| # | Đường dẫn | Phiên bản | Loại |
|---|---|---|---|
| 1 | `C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe` | **v22.23.3** | **node đầu tiên trên PATH của shell này** |
| 2 | `C:\nvm4w\nodejs\node.exe` | **v22.16.0** | nvm4w symlink (bản coordinator chạy) |
| 3 | `C:\Users\Gem\AppData\Local\nvm\v22.16.0\node.exe` | **v22.16.0** | nvm-windows cài thật |
| 4 | `C:\Users\Gem\AppData\Local\hermes\node\node.exe` | v22.23.2 | app-bundled (hermes) |
| 5 | `C:\Users\Gem\AppData\Local\qwen-code\qwen-code\node\node.exe` | v22.23.2 | app-bundled (qwen-code) |
| 6 | `C:\Users\Gem\AppData\Local\ms-playwright-go\1.50.1\node.exe` | v22.13.1 | app-bundled (playwright-go) |
| 7 | `C:\Program Files (x86)\Ulanzi Studio\nodejs\node.exe` | v20.12.2 | app-bundled (Ulanzi) |
| 8 | `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` | **v24.21.0** | **zip portable trong `%TEMP%` — KHÔNG phải bản cài; đây là bản duy nhất thoả `engines >=24.21.0 <25`** |

**Không có bản Node 24 nào được cài trên máy** (`C:\Program Files\nodejs` không tồn tại; nvm chỉ có 22.16.0).
Bản 24.21.0 duy nhất là zip tạm do các lane verify trước giải nén vào `%TEMP%`.

**Vì sao ba lần đọc `node -v` ra ba số khác nhau — đây là gốc của mâu thuẫn trong bối cảnh:**

| Ai đọc | Thấy | Vì sao |
|---|---|---|
| Coordinator | **v22.16.0** | shell của coordinator resolve qua nvm (`C:\nvm4w\nodejs\node.exe`) |
| verify-D (tôi, phiên trước) | **v24.21.0** | tôi **chủ động prepend** `%TEMP%\du-node24-...\node-v24.21.0-win-x64` vào PATH để khớp `engines` đã khai báo |
| Shell này (mặc định) | **v22.23.3** | `deepseek-cli` bundled node đứng **đầu** PATH |

⇒ **PATH không ổn định giữa các shell**; `node -v` một mình không đủ để mô tả môi trường. Cả ba con số đều thật.

---

## BƯỚC 2 — Node trên PATH (v22.23.3)

| # | Lệnh | NODE_ENV | Exit | Literal |
|---|---|---|---:|---|
| 2a | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | **unset** | **0** | `Tests: 12 passed, 12 total` · `Test Suites: 1 passed, 1 total` |
| 2b | y hệt, `NODE_ENV=production` | production | **0** | `Tests: 12 passed, 12 total` · `Test Suites: 1 passed, 1 total` |
| 2c | `node … --config jest.unit.config.cjs tests/admin-audit-mount.test.ts tests/admin-audit-query.test.ts tests/v1-boot-typed-denial.test.ts tests/admin-error-boundary-offline.test.ts` | **unset** | **0** | `Tests: 84 passed, 84 total` · `Test Suites: 4 passed, 4 total` |
| 2d | y hệt, `NODE_ENV=production` | production | **1** | `Tests: 34 failed, 50 passed, 84 total` · `Test Suites: 4 failed, 4 total` |

## BƯỚC 3 — các bản Node khác, đường dẫn tuyệt đối

| # | Node | NODE_ENV | Exit | Literal |
|---|---|---|---:|---|
| 3a | nvm **v22.16.0** — RSS 1 suite | unset | **0** | `Tests: 12 passed, 12 total` |
| 3b | nvm **v22.16.0** — RSS 1 suite | production | **0** | `Tests: 12 passed, 12 total` |
| 3c | nvm **v22.16.0** — group A 4 suite | unset | **0** | `Tests: 84 passed, 84 total` · `Test Suites: 4 passed, 4 total` |
| 3d | nvm **v22.16.0** — group A 4 suite | production | **1** | `Tests: 34 failed, 50 passed, 84 total` · `Test Suites: 4 failed, 4 total` |
| 3e | temp **v24.21.0** — RSS 1 suite | unset | **1** | `Tests: 1 failed, 11 passed, 12 total` |
| 3f | temp **v24.21.0** — RSS 1 suite | production | **1** | `Tests: 1 failed, 11 passed, 12 total` |
| 3g | temp **v24.21.0** — group A 4 suite | unset | **0** | `Tests: 84 passed, 84 total` · `Test Suites: 4 passed, 4 total` |
| 3h | temp **v24.21.0** — group A 4 suite | production | **1** | `Tests: 34 failed, 50 passed, 84 total` · `Test Suites: 4 failed, 4 total` |

### 3-extra — ma trận rút gọn cho các runtime app-bundled (chỉ RSS suite, NODE_ENV unset)

| Node | Exit | Literal |
|---|---:|---|
| v20.12.2 (Ulanzi) | **0** | `Tests: 12 passed, 12 total` |
| v22.13.1 (playwright-go) | **0** | `Tests: 12 passed, 12 total` |
| v22.23.2 (hermes) | **0** | `Tests: 12 passed, 12 total` |

**Tổng hợp ma trận (RSS = `public-upload-encryption-gateway`, A = 4 suite nhóm A):**

| Runtime | RSS @ unset | RSS @ production | A @ unset | A @ production |
|---|---|---|---|---|
| v20.12.2 | ✅ 12/12 | — | — | — |
| v22.13.1 | ✅ 12/12 | — | — | — |
| **v22.16.0 (nvm)** | ✅ **12/12** | ✅ **12/12** | ✅ **84/84** | ❌ **34 failed / 84** |
| v22.23.2 | ✅ 12/12 | — | — | — |
| **v22.23.3 (PATH)** | ✅ **12/12** | ✅ **12/12** | ✅ **84/84** | ❌ **34 failed / 84** |
| **v24.21.0 (temp)** | ❌ **1 failed / 12** | ❌ **1 failed / 12** | ✅ **84/84** | ❌ **34 failed / 84** |

### Bằng chứng lỗi RSS trên Node 24 (nguyên văn, NODE_ENV unset)

```
  ● public upload encryption gateway › streams chunked encryption with downstream
backpressure and keeps the object size exact

    expect(received).toBeLessThan(expected)

    Expected: < 171966464
    Received:   218652672

      707 |     // The mock object store retains ciphertext; this budget includes
that
      708 |     // copy and bounded stream buffers, while rejecting another
full-file copy.
    > 709 |     expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024);
          |                       ^
```
Ngân sách: `size = CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 20 MiB` (`test:680`) với
`CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES = 5 * 1024 * 1024` (`src/modules/encryption/crypto-storage-facade.ts:19`)
⇒ `size` = 25 MiB ⇒ ngân sách `size*4 + 64 MiB` = **164 MiB = 171966464 byte**. Node 24 tăng **~208.5 MiB**
(218652672) — vượt ~27%. Trên 5 build v20/v22 khác nhau, cùng test này **qua** ở cả hai trạng thái NODE_ENV.

### Bổ sung: RSS nền mỗi runtime (tiến trình mới, không chạy test)

| Runtime | baseline RSS |
|---|---|
| v22.23.3 | 43 MiB |
| v22.16.0 | 26 MiB |
| v24.21.0 | 30 MiB |

RSS nền **không** tương quan với kết quả (v22.23.3 nền cao nhất nhưng vẫn xanh; v24.21.0 nền thấp hơn v22.23.3
nhưng đỏ) ⇒ khác biệt nằm ở **độ tăng RSS khi chạy**, không phải ở nền. Cơ chế cụ thể **chưa được chứng minh**
(xem §Giới hạn).

---

## BƯỚC 4 — kết luận trung thực (tách bạch môi trường)

**1) Nhóm C (`public-upload-encryption-gateway`, test ngân sách RSS): phụ thuộc PHIÊN BẢN NODE, KHÔNG phụ thuộc `NODE_ENV`.**
- Xanh trên **cả 5** build v20/v22 đã thử: 20.12.2, 22.13.1, 22.16.0, 22.23.2, 22.23.3 — **cả khi `NODE_ENV` unset lẫn production**.
- Đỏ trên **đúng một** build: v24.21.0 — **cả khi `NODE_ENV` unset lẫn production**.
- Vì vậy: coordinator chạy Node 22.16.0 thấy **xanh**; verify-D chạy Node 24.21.0 thấy **đỏ**. **Cả hai đúng**,
  khác runtime. Đây là bằng chứng tách bạch: biến quyết định là **major version của Node**, không phải `NODE_ENV`.
- Hệ quả cần owner quyết: repo **pin `engines >=24.21.0 <25`**, nhưng test ngân sách RSS lại **chỉ xanh trên v22**.
  Đây là **MISMATCH engines ↔ test** thật, không phải flake.

**2) Nhóm A (34 test / 4 suite): phụ thuộc `NODE_ENV`, KHÔNG phụ thuộc phiên bản Node.**
- Với `NODE_ENV=production`: **34 failed / 50 passed / 84 total** — **giống hệt nhau trên cả 3 runtime**
  (v22.23.3, v22.16.0, v24.21.0). Con số 34 trùng khít ⇒ tín hiệu rất sạch.
- Với `NODE_ENV` unset: **84 passed / 84 total, exit 0** trên **cả 3 runtime**.
- ⇒ Phiên bản Node **không** chạm tới nhóm A. Biến duy nhất là `NODE_ENV=production`.

**3) `npm test` có set `NODE_ENV` không? — KHÔNG.**
- Grep toàn `du-rework` (trừ `node_modules`) trên **mọi** `package.json` + `jest.config.cjs` + `jest.unit.config.cjs`
  cho `NODE_ENV`: **0 hit**.
- Script test các cấp: root `du-rework` → `test = pnpm -r run test`; `services/orchestrator` → `test = jest --runInBand`,
  `test:unit = jest --runInBand --config jest.unit.config.cjs`; `apps/admin-web` → **không có script `test`**.
- Cả ba `package.json` đều khai `engines.node = ">=24.21.0 <25"`.
- ⇒ `npm test`/`pnpm test` **kế thừa `NODE_ENV` của shell**. Shell này có `NODE_ENV=[production]` (đọc trực tiếp),
  nên **bất kỳ ai chạy `npm test` trong shell như vậy sẽ thấy đúng 34 test nhóm A đỏ** — không phải do code, mà do
  môi trường. Muốn tái lập trạng thái xanh: chạy trong shell **không** có `NODE_ENV`, hoặc pin `NODE_ENV=test`
  trong config/runner (việc này **thuộc owner**, lane này không sửa).

**4) Hai nhóm trực giao nhau** — không được gộp nguyên nhân:

| Nhóm | Biến quyết định | Bằng chứng |
|---|---|---|
| C — RSS budget (1 test) | **phiên bản Node (v24 vs v20/v22)** | đỏ 2/2 trạng thái NODE_ENV trên v24; xanh 2/2 trạng thái trên v22.16.0 và v22.23.3; xanh thêm 3 build v20/v22 |
| A — 34 test | **`NODE_ENV=production`** | 34 failed giống hệt trên 3 runtime khi production; 84 passed trên 3 runtime khi unset |

---

## Giới hạn (những gì tôi CHƯA chứng minh)

1. **Cơ chế của nhóm C chưa được chứng minh.** Tôi chỉ chứng minh **tương quan** "v24 đỏ / v20–v22 xanh" trên 6
   build. Tôi **không** chứng minh *vì sao* Node 24 tăng RSS nhiều hơn (thay đổi V8/GC, kích thước buffer mặc định,
   `process.memoryUsage.rss()` semantics…). Muốn kết luận nhân quả phải đo trong tiến trình, hoặc chạy với
   `--max-old-space-size`/GC flags — nằm ngoài phạm vi read-only này.
2. **Offline, không DB/Redis, không claim DB window.** Không suite live nào được chạy; mọi kết luận chỉ áp dụng cho
   các suite offline đã nêu.
3. **Chỉ một build v24** (zip tạm 24.21.0) ⇒ chưa loại trừ được khả năng "riêng build này" thay vì "cả dòng v24".
   Cần ít nhất một build v24 khác để khẳng định theo dòng phiên bản.
4. **Các runtime app-bundled** (20.12.2, 22.13.1, 22.23.2) chỉ được chạy **ma trận rút gọn** (1 suite, NODE_ENV
   unset) — không chạy nhóm A trên chúng; chúng cũng không phải bản Node "được cài để phát triển".
5. **`node -v` phụ thuộc PATH của từng shell** (đã chứng minh bằng 3 kết quả khác nhau). Receipt này ghi rõ runtime
   của **từng** lần chạy; một receipt khác không ghi runtime thì không so sánh được với receipt này.
6. **Cây đang chuyển động** (porcelain 93, nhiều lane ghi song song) ⇒ số liệu là snapshot tại thời điểm chạy.
7. Không sửa gì, không commit/add/push, không tick gate, không đọc `.env.live`.

**MISMATCH cần owner phân xử (ghi lại, KHÔNG sửa):** repo pin `engines node >=24.21.0 <25`, nhưng test ngân sách
RSS trong `tests/public-upload-encryption-gateway.test.ts:709` **chỉ qua trên v20/v22** và đỏ trên v24.21.0 ⇒ hoặc
ngưỡng ngân sách phải nới theo runtime, hoặc test phải pin/đo theo cách không phụ thuộc phiên bản. Nhóm A cần một
quyết định khác: pin `NODE_ENV` cho runner hay sửa kỳ vọng của 4 suite.
