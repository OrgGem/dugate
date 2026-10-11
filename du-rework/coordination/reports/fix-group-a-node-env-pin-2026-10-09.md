# FIX — GROUP A: hermetic `NODE_ENV` pin cho services/orchestrator — 2026-10-09

- **Vai trò:** implementation lane sở hữu fix này. **Tôi KHÔNG verify fix của mình** — cần verify độc lập riêng.
- **Scope:** `du-rework/orchestrator/services/orchestrator` (đúng khoảng được giao).
- **Runtime ghi cho MỌI lần chạy:** node **v24.21.0** (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64`,
  bản duy nhất thoả `engines >=24.21.0 <25` trên máy — xem `node-version-env-check-INDEPENDENT-2026-10-08.md`),
  `NODE_ENV=production` đặt trong tiến trình con của từng lệnh. **Không mở PostgreSQL/Redis**, offline hoàn toàn.
- **Mốc:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` (không đổi); `git status --porcelain` = 110 lúc kết thúc
  (cây đang được nhiều lane ghi song song).
- **Raw logs:** `du-rework/coordination/reports/raw/fix-group-a-2026-10-09/`
  (`01-RED.txt`, `01-RED-full.txt`, `02-GREEN.txt`, `02-green1/2/3.txt`, `03-full-sweep.txt`, `03-full-sweep-raw.txt`).

---

## 1. FAIL-FIRST — RED trước khi sửa (nguyên văn)

```
cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
NODE_ENV=production node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/v1-boot-typed-denial.test.ts
```
(PowerShell tương đương: `$env:NODE_ENV='production'; node …` — biến chỉ đặt trong tiến trình con.)

| | Literal |
|---|---|
| **exit code** | **1** |
| `Test Suites:` | `Test Suites: 1 failed, 1 total` |
| `Tests:` | `Tests: 2 failed, 8 passed, 10 total` |

Block lỗi đầu tiên, nguyên văn:
```
  ● V1 boot missing profile cipher key policy › continues boot without either key
and emits one warning naming the denied operation

    ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime
artifact grants

      133 |   if (!raw) {
      134 |     if (env.NODE_ENV === 'production' && (env.ARTIFACT_STORAGE_BACKEND
?? 'postgres') === 'postgres') {
    > 135 |       throw new Error('ORCHESTRATOR_INTERNAL_BASE_URL is required for
production PostgreSQL Runtime artifact grants');
          |             ^
      136 |     }
      137 |     return undefined;
      138 |   }
```

Bối cảnh rộng hơn (đã đo ở lane verify F, cùng runtime): 4 suite nhóm A đỏ **34 test** khi `NODE_ENV=production`
(`Tests: 34 failed, 50 passed, 84 total`) và **84 passed, exit 0** khi `NODE_ENV` unset — nguyên nhân là môi trường,
không phải code.

## 2. Mẫu chuẩn đã có — copy, không phát minh lại

Đọc `du-rework/orchestrator/packages/observability/tests/setup-node-env.cjs` (11 dòng) — 3 câu lệnh tác dụng:
```js
process.env.NODE_ENV = 'test';
delete process.env.DU_ENVIRONMENT;
delete process.env.APP_ENV;
```
Đọc `du-rework/orchestrator/packages/observability/jest.config.cjs:7`:
`setupFiles: ['<rootDir>/tests/setup-node-env.cjs'],`

## 3. File đã đổi (đúng 2 file — không file nào khác)

| File | Loại | Nội dung |
|---|---|---|
| `services/orchestrator/tests/setup-node-env.cjs` | **THÊM MỚI** | Mirror **đúng 3 câu lệnh** của mẫu observability + ghi chú nêu rõ đây là **pin test** và nêu 3 hệ quả cụ thể trong service này (`src/main.ts:135`; cookie-mint 503 `auth-dispatch.ts:120-130`; logger ghi `environment:"prod"`), kèm ghi chú rằng suite nào cần production thì **tự set tường minh** (ví dụ `tests/v1-boot-typed-denial.test.ts:268`) và override đó vẫn hoạt động. |
| `services/orchestrator/jest.config.cjs` | **SỬA (+4 dòng)** | Thêm `setupFiles: ['<rootDir>/tests/setup-node-env.cjs'],` ngay sau `testMatch`, kèm comment nói rõ `jest.unit.config.cjs` kế thừa qua spread nên không cần sửa. |

`services/orchestrator/jest.unit.config.cjs` — **KHÔNG SỬA**: nó `module.exports = { ...base, testPathIgnorePatterns }`
nên **kế thừa `setupFiles`**; điều này được chứng minh **bằng thực nghiệm** (mọi lần GREEN dưới đây đều chạy với
`--config jest.unit.config.cjs` và đã xanh). `git status` cho file này: **rỗng**.

`docs/21-openapi.json`: mtime **03:06:23**, `git status` **rỗng** — **không bị chạm**.

**Pre-flight trước khi wire (để không phá suite khác):** grep `tests/` cho `NODE_ENV.*production` → 27 hit, và
**mọi** hit là suite **truyền literal `NODE_ENV: 'production'` vào hàm đang test** (ví dụ
`runtimeGrantBaseUrlFromEnv({ NODE_ENV: 'production' })`, `assertProfileCipherBootPolicy({ NODE_ENV: 'production' }, …)`)
⇒ chúng **không** phụ thuộc `process.env.NODE_ENV` nên pin không phá chúng. Không có suite nào assert
`environment: 'prod'` lấy từ môi trường.

## 4. GREEN sau khi sửa (vẫn `NODE_ENV=production`, cùng node v24.21.0)

| # | Lệnh (cwd `…\services\orchestrator`) | Exit | Literal |
|---|---|---:|---|
| G1 | đúng lệnh RED ở §1 | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 10 passed, 10 total` |
| G2 | `node … jest.js --runInBand --config jest.unit.config.cjs tests/admin-audit-mount.test.ts tests/admin-audit-query.test.ts tests/v1-boot-typed-denial.test.ts tests/admin-error-boundary-offline.test.ts` | **0** | `Test Suites: 4 passed, 4 total` · `Tests: 84 passed, 84 total` |
| G3 | `node … jest.js --runInBand --config jest.unit.config.cjs --silent tests/runtime-grant-origin.test.ts tests/encryption-boot-options.test.ts tests/oidc-boot.test.ts tests/rfx10-seed-gate.test.ts tests/rfx11-12-route-hardening.test.ts tests/backfill-cli-825.test.ts` | **0** | `Test Suites: 6 passed, 6 total` · `Tests: 108 passed, 108 total` |
| G4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | `output_bytes=0` — không dòng `error TS` |

G3 là nhóm **collateral**: 6 suite dùng `NODE_ENV='production'` **literal** — xanh ⇒ pin không phá hành vi
production-tường-minh.

## 5. Toàn bộ offline suite — trước vs sau (cùng runtime, cùng `NODE_ENV=production`)

| | Exit | `Test Suites:` | `Tests:` | Suite đỏ |
|---|---:|---|---|---|
| **Trước** (verify-D, cùng node v24.21.0 + production) | 1 | `6 failed, 14 skipped, 229 passed, 235 of 249 total` | `40 failed, 118 skipped, 5098 passed, 5256 total` | 6 suite |
| **Sau** | 1 | `2 failed, 14 skipped, 233 passed, 235 of 249 total` | **`6 failed, 118 skipped, 5132 passed, 5256 total`** | 2 suite |

Delta: **−4 suite đỏ, −34 test đỏ, +34 test xanh** — đúng bằng nhóm A. Không suite nào khác đổi trạng thái.

## 6. KẾT LUẬN TRUNG THỰC — suite nào còn đỏ, và vì sao (không bỏ qua, không đổi kỳ vọng)

Sau fix vẫn còn **2 suite đỏ / 6 test đỏ** — **cả hai đều ngoài phạm vi lease này** và **không phải do pin**:

| Suite còn đỏ | Test đỏ | Lý do (đã có receipt riêng) | Thuộc lease này? |
|---|---:|---|---|
| `tests/artifact-read-authorization.test.ts` | 5 | **MISMATCH docs ↔ code** (docs `28:1399` nói 403, code `artifacts.ts:707` trả 409 `LEASE_LOST`; 2 test còn lại là `STATE_CONFLICT` vs `PERMISSION_DENIED`). Đã triage độc lập: `coordination/reports/triage-artifact-read-mismatch-INDEPENDENT-2026-10-08.md`. Cần owner phân xử. | **Không** |
| `tests/public-upload-encryption-gateway.test.ts` | 1 | **Ngân sách RSS phụ thuộc PHIÊN BẢN NODE**: đỏ trên v24.21.0 (cả khi `NODE_ENV` unset lẫn production), xanh trên 5 build v20/v22 đã thử. Bằng chứng: `coordination/reports/node-version-env-check-INDEPENDENT-2026-10-08.md`. | **Không** |

**`tests/migrations.test.ts` — KHÔNG chạy, KHÔNG tính là passed.** Nó nằm trong `testPathIgnorePatterns` của
`jest.unit.config.cjs:18` (`'migrations\\.test\\.ts$'`, live-gate). Sweep sau fix **không** in dòng nào về file này
⇒ nó không được thực thi trong cả hai lần đo, và **không** được cộng vào 5132 test xanh.

**Không có suite nào bị tôi sửa kỳ vọng hay bỏ qua.** Không test nào bị skip thêm: số `118 skipped` **không đổi**
trước/sau.

## 7. Cam kết đã giữ

- **KHÔNG** commit, **KHÔNG** `git add`, **KHÔNG** push.
- **KHÔNG** tick gate nào (`VERIFIED` / `ACCEPTED` / `IMPLEMENTED`) — coordinator tick.
- **KHÔNG** hand-edit `docs/21-openapi.json`.
- **KHÔNG** đọc `.env.live`.
- **KHÔNG** sửa source application, **KHÔNG** sửa test hiện hữu để làm xanh (chỉ **thêm** 1 file setup mới + 4 dòng
  config).
- **KHÔNG** mở PostgreSQL/Redis; offline.
- **KHÔNG** chạm WFA-01..06, **KHÔNG** chạm `packages/observability`.

**Cần tiếp theo (không thuộc lane này):** verify độc lập trên bản code hiện tại (chạy lại §4 và §5 với runtime ghi rõ),
rồi coordinator quyết hai MISMATCH còn lại ở §6.
