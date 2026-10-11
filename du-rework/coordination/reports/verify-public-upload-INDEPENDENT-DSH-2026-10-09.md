# VERIFY ĐỘC LẬP (dsh) — fix RED của `tests/public-upload-encryption-gateway.test.ts` — 2026-10-09

- **Vai trò:** verifier độc lập. **Tôi KHÔNG viết fix này** (tác giả: lane Codex khác,
  `coordination/reports/fix-public-upload-encryption-gateway-red-2026-10-08.md`).
- **Chỉ đọc + chạy test.** KHÔNG sửa source/test/config/docs, KHÔNG commit/`git add`/push, **KHÔNG tick gate nào**,
  KHÔNG hand-edit `docs/21-openapi.json`, KHÔNG đọc `.env.live`. **Offline**: không PostgreSQL, không Redis, không
  claim DB window. Chỉ `du-rework`.
- **CWD mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
- **Mốc:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233`; `git status --porcelain` = 122.
- **Raw logs:** `du-rework/coordination/reports/raw/verify-public-upload-2026-10-09/DSH/`
  (`00-runtime.txt`, `L1-run1..3.txt`, `L1-summary.txt`, `L1-L2-detail.txt`, `L2-unset.txt`, `L3-neighbors.txt`,
  `L4-tsc.txt`, `L3-L4-L5.txt`, `L6-node22.txt`, `L6-and-skipped.txt`).

## 0. Runtime dùng để chạy (đúng runtime đã đỏ trước đó)

```
node -v = v24.21.0
path   = C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe
```
Đây **vẫn còn** và là **bản v24 duy nhất trên máy** (quét `%TEMP%`, `%LOCALAPPDATA%`, `Program Files*` → chỉ 1 hit
v24.21.0; không có 24.21.x nào khác). Node trên PATH của shell này là v22.23.3 (không dùng cho các lệnh chính).
`NODE_ENV` ambient của shell = **production**.

---

## 1. Bảng mọi lệnh × exit code × literal

| # | Lệnh | Node | NODE_ENV | **REAL_EXIT** | Literal |
|---|---|---|---:|---:|---|
| L1.1 | `<n24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | v24.21.0 | production | **1** | `Test Suites: 1 failed, 1 total` · `Tests: 1 failed, 11 passed, 12 total` |
| L1.2 | (y hệt, lần 2) | v24.21.0 | production | **1** | `Test Suites: 1 failed, 1 total` · `Tests: 1 failed, 11 passed, 12 total` |
| L1.3 | (y hệt, lần 3) | v24.21.0 | production | **1** | `Test Suites: 1 failed, 1 total` · `Tests: 1 failed, 11 passed, 12 total` |
| L2 | (y hệt, lần 4) — **NODE_ENV unset** | v24.21.0 | **unset** | **1** | `Test Suites: 1 failed, 1 total` · `Tests: 1 failed, 11 passed, 12 total` |
| L3 | `<n24> … jest.js … tests/rv01-loopback-http-offline.test.ts tests/admin-shell-session-lifecycle.test.ts` | v24.21.0 | production | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 99 passed, 99 total` |
| L4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | PATH | production | **0** | `output_bytes=0` (không dòng `error TS`) |
| L6 *(bổ sung)* | `<n22> … jest.js … tests/public-upload-encryption-gateway.test.ts` | **v22.16.0** | production | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 12 passed, 12 total` |

**3 lần lặp (L1): đỏ cả 3, cùng một con số — không flaky, deterministic trên v24.21.0.**
**production vs unset (L1 vs L2): KHÔNG khác biệt** — cùng `1 failed, 11 passed, 12 total`, cùng exit 1
⇒ test đỏ này **không phụ thuộc `NODE_ENV`**.

## 2. RED — nguyên văn (KHÔNG bỏ qua)

Tên test đỏ (duy nhất, giống nhau ở cả 4 lần chạy trên v24.21.0):
```
● public upload encryption gateway › streams chunked encryption with downstream
backpressure and keeps the object size exact
```
Block lỗi nguyên văn:
```
    expect(received).toBeLessThan(expected)

    Expected: < 171966464
    Received:   218525696

      707 |     // The mock object store retains ciphertext; this budget includes
that
      708 |     // copy and bounded stream buffers, while rejecting another
full-file copy.
    > 709 |     expect(rssGrowth).toBeLessThan(size * 4 + 64 * 1024 * 1024);
          |                       ^
      710 |   });

      at Object.<anonymous> (tests/public-upload-encryption-gateway.test.ts:709:23)
```

## 3. Fix là test-double hay source sản phẩm? (LỆNH 5)

```
git status --porcelain -- …/tests/public-upload-encryption-gateway.test.ts
 M du-rework/orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts

git diff --stat -- …/tests/public-upload-encryption-gateway.test.ts
 .../tests/public-upload-encryption-gateway.test.ts      | 17 +++++++++++++++++
 1 file changed, 17 insertions(+)
```
Diff **+17 dòng, toàn bộ nằm trong `createDb()` — test double của chính file test**:
- `:251-252` thêm `let linkedOperationId: string | null = null;` + `const linkedTaskId: string | null = null;`
- `:388-402` thêm nhánh `if (query.startsWith('UPDATE artifacts SET operation_id=$2')) { … }` để fake DB **không
  còn ném** `unexpected test DB query: UPDATE artifacts SET operation_id=$2 …` (query thật ở
  `src/modules/operations/submission.ts:660`), kèm CAS-ish guard (`state !== 'READY'`, `linkedOperationId !== null`).

⇒ **Fix là TEST-DOUBLE/FIXTURE, KHÔNG phải source sản phẩm.** Chỉ **1 file** bị đổi và đó là file test.
**Không file sản phẩm nào bị chạm** bởi fix này (diff chỉ có file test; không có `src/**` trong diff).

## 4. Đối chiếu với claim của tác giả — **claim "xanh 12/12 trên node v24.21.0" KHÔNG tái lập được**

| Claim trong `fix-public-upload-encryption-gateway-red-2026-10-08.md` | Đo được trên **đúng runtime v24.21.0** | Kết luận |
|---|---|---|
| trước fix: `1 failed, 11 passed, 12 total` | — (không đo lại bản trước fix) | không kiểm chứng |
| **sau fix: xanh 12/12 trên node v24.21.0** | **`1 failed, 11 passed, 12 total`, exit 1, 4/4 lần** | **REFUTED** |
| (lane oc_4: 12/12 trên node v22.16.0) | **`12 passed, 12 total`, exit 0 trên v22.16.0** | **CONFIRMED** |

**Bằng chứng phụ thuộc phiên bản Node (do tôi tự đo, không mượn receipt khác):**

| Node | Exit | Literal |
|---|---:|---|
| **v24.21.0** | **1** | `1 failed, 11 passed, 12 total` (4 lần: 3 production + 1 unset) |
| **v22.16.0** | **0** | `12 passed, 12 total` |

⇒ Suite này **xanh trên v22.16.0 và đỏ trên v24.21.0**, và điều đó **không liên quan `NODE_ENV`** (đã đo cả hai
trạng thái trên v24). Fix của tác giả **có thật và đúng loại** (nó gỡ lỗi test-double `unexpected test DB query`),
nhưng **nó không đóng được test RSS còn lại** — test đó là **assertion ngân sách RSS phụ thuộc phiên bản Node**,
trùng với kết luận độc lập ở `coordination/reports/node-version-env-check-INDEPENDENT-2026-10-08.md`
(xanh trên 5 build v20/v22, đỏ trên v24.21.0).

## 5. SKIPPED

- **`tests/migrations.test.ts` KHÔNG chạy** — live-gate trong `jest.unit.config.cjs:18`
  (`'migrations\\.test\\.ts$'` nằm trong `liveSuites`, áp qua `testPathIgnorePatterns` ở `:28`).
  **Không tính là pass.** Nó không xuất hiện trong bất kỳ lệnh nào ở trên.
- **Trong 6 lần chạy của tôi: 0 skipped.** Mọi dòng `Tests:` đều không có `skipped`
  (`1 failed, 11 passed, 12 total` ×4; `99 passed, 99 total`; `12 passed, 12 total`).
- Các suite live khác của service vẫn bị `jest.unit.config.cjs` loại khỏi lượt offline (14 suite) — không nằm
  trong phạm vi task này và không được tôi chạy.

## 6. Kết luận trung thực

1. **Trên đúng runtime đã đỏ (node v24.21.0), fix KHÔNG làm suite xanh.** 4/4 lần: `1 failed, 11 passed, 12 total`,
   exit 1, deterministic, và **độc lập `NODE_ENV`**. Đây là **phát hiện quan trọng** của lượt verify này: receipt
   của tác giả khai "xanh 12/12 trên v24.21.0" — **số đó không tái lập được**; con số 12/12 chỉ đúng trên v22.
2. **Bản thân fix là hợp lệ về loại và phạm vi:** test-double/fixture, +17 dòng trong chính file test,
   **không chạm source sản phẩm**. Nó gỡ đúng lớp lỗi `unexpected test DB query: UPDATE artifacts SET
   operation_id=$2 …`. Nhưng suite còn **một test đỏ khác** (RSS budget) mà fix này không nhắm tới.
3. **Regression lân cận sạch:** `rv01-loopback-http-offline` + `admin-shell-session-lifecycle` = **99 passed, exit 0**
   trên cùng runtime. **Typecheck backend exit 0** (`output_bytes=0`).
4. **MISMATCH còn mở (không thuộc lượt này, cần owner quyết):** repo pin `engines >=24.21.0 <25` nhưng
   assertion `tests/public-upload-encryption-gateway.test.ts:709` **chỉ qua trên v20/v22** và đỏ trên v24.21.0
   ⇒ hoặc nới/đo lại ngân sách theo runtime, hoặc pin runtime cho suite. **Tôi không sửa gì.**

**Tôi KHÔNG tick gate nào** (không `VERIFIED`/`ACCEPTED`/`IMPLEMENTED`), **không commit, không `git add`, không push**,
không sửa file nào, không hand-edit `docs/21-openapi.json`, không đọc `.env.live`, không mở PostgreSQL/Redis.
