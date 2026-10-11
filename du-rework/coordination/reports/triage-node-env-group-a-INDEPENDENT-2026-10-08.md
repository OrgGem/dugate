# TRIAGE ĐỘC LẬP E — nhóm A: 34 test đỏ chỉ xuất hiện khi `NODE_ENV=production` — 2026-10-08

**KẾT LUẬN MỘT DÒNG:** repo kỳ vọng unit offline chạy dưới **`NODE_ENV=test`** (mặc định của jest khi biến chưa set) — 34 test đỏ nhóm A là **environment leak từ shell**, **không phải defect sản phẩm**; lựa chọn ít rủi ro nhất là **ghim `NODE_ENV=test` ở tầng runner/config** (kèm làm 3 suite độc lập môi trường), và **tránh** chỉ ghim ở npm script vì runner trực tiếp mà mọi verifier dùng sẽ bỏ qua script đó.

**Vai trò/quy tắc:** triage độc lập E, CHỈ ĐỌC. KHÔNG sửa source/test/config/package.json, KHÔNG commit/add/push, KHÔNG tick gate, KHÔNG hand-edit `docs/21-openapi.json`, KHÔNG đọc `.env.live`. OFFLINE — không khởi động PostgreSQL/Redis, **không claim DB window**. `du-rework` only.
**cwd mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · Node `v22.23.3` · HEAD `72e225ae5465e5a648c34bf31fbabbd182763233`.
**Raw:** `coordination/reports/raw/triage-node-env-group-a-INDEPENDENT-2026-10-08/` (`pass1-ambient-*`, `pass2-production-*`, `pass3-unset-*` cho 4 suite + `SHA256SUMS.txt`).

---

## BƯỚC 1 — Inventory cấu hình (nguyên văn + đường dẫn + dòng)

| # | File | Dòng | Nguyên văn | Ghi chú |
|---|---|---|---|---|
| 1 | `du-rework/package.json` | 12 | `"test": "pnpm -r run test",` | chạy test đệ quy; **không** set NODE_ENV, **không** cross-env |
| 2 | `du-rework/orchestrator/package.json` | — | **không tồn tại** (`Test-Path` = False) | packet hỏi file này; trên đĩa không có manifest ở cấp `orchestrator/` |
| 3 | `orchestrator/services/orchestrator/package.json` | 11 | `"test": "jest --runInBand",` | **không** set NODE_ENV |
| 4 | `orchestrator/services/orchestrator/package.json` | 12 | `"test:unit": "jest --runInBand --config jest.unit.config.cjs",` | **không** set NODE_ENV |
| 5 | mọi `package.json` trong `du-rework` (grep `NODE_ENV\|cross-env`) | — | **0 match** | không nơi nào ghim môi trường, không dùng `cross-env` |
| 6 | `orchestrator/services/orchestrator/jest.config.cjs` | 4 | `testEnvironment: 'node',` | chỉ có `preset: 'ts-jest'`, `roots`, `testMatch`, `testTimeout`, `transform`; **không** `globalSetup`, **không** `setupFiles`, **không** NODE_ENV |
| 7 | `orchestrator/services/orchestrator/jest.unit.config.cjs` | 5, 26-29 | `const base = require('./jest.config.cjs');` … `module.exports = { ...base, testPathIgnorePatterns: liveSuites };` | chỉ spread base + danh sách ignore live; **không** set env |
| 8 | `du-rework/.npmrc` | 1-3 | `auto-install-peers=true` / `strict-peer-dependencies=false` / `prefer-workspace-packages=true` | không liên quan env |
| 9 | `du-rework/.node-version` · `du-rework/.nvmrc` | 1 | `24.21.0` · `24.21.0` | chỉ ghim Node; **không** có ở `orchestrator/` hay `services/orchestrator/` (đã kiểm: False) |

**Bảng lệnh BƯỚC 1 + exit code** (đều read-only, exit 0):

| Lệnh | Exit | Kết quả |
|---|---:|---|
| `rg 'NODE_ENV\|cross-env' -g package.json du-rework` (qua grep tool) | 0 | 0 match |
| `Test-Path` cho `.npmrc/.node-version/.nvmrc` ở 3 cấp | 0 | chỉ `du-rework/` có |
| `Select-String` trên 2 jest config (`NODE_ENV\|testEnvironment\|setupFiles\|globalSetup`) | 0 | chỉ `jest.config.cjs:4 testEnvironment: 'node'` |

## BƯỚC 2 — Trong 4 suite: đọc NODE_ENV ở đâu, assertion nào đỏ và vì sao (ngữ nghĩa)

### 2.1 Danh sách `file:line` đọc/so sánh `NODE_ENV` (nguyên văn)

**Trong chính 4 suite** (chỉ 1 suite đọc trực tiếp):
| File:line | Nguyên văn |
|---|---|
| `tests/v1-boot-typed-denial.test.ts:267-268` | `const previousNodeEnv = process.env.NODE_ENV;` / `process.env.NODE_ENV = 'production';` |
| `tests/v1-boot-typed-denial.test.ts:284-285` | `const previousNodeEnv = process.env.NODE_ENV;` / `process.env.NODE_ENV = 'staging';` |
| `tests/v1-boot-typed-denial.test.ts:298-299` | `const previousNodeEnv = process.env.NODE_ENV;` / `process.env.NODE_ENV = 'development';` |
| `tests/v1-boot-typed-denial.test.ts:318-322` | `const previousNodeEnv = process.env.NODE_ENV;` … `// every NODE_ENV outside {development, test}.` … `process.env.NODE_ENV = 'staging';` |
| `tests/v1-boot-typed-denial.test.ts:161-170` | `const BOOT_ENV_NAMES = ['DATABASE_URL', … 'ENCRYPTION_KEY', 'NEXTAUTH_SECRET'] as const;` — **KHÔNG có `NODE_ENV`** |
| `tests/v1-boot-typed-denial.test.ts:172-191` | `withBootEnv(...)` chỉ `delete process.env[name]` cho `BOOT_ENV_NAMES` ⇒ **`NODE_ENV` ambient sống sót vào `main()`** |

**`admin-audit-mount.test.ts`, `admin-audit-query.test.ts`, `admin-error-boundary-offline.test.ts`:** grep `NODE_ENV` trong 3 file này = **0 hit** — chúng đỏ **gián tiếp** qua source bên dưới.

**Trong source mà 4 suite chạy qua (những dòng thật sự quyết định đỏ/xanh):**
| File:line | Nguyên văn | Liên quan |
|---|---|---|
| `src/app/admin/oidc-boot.ts:142` | `const requireSecure = secureRaw === 'enforce' \|\| trimmed(env['NODE_ENV']).toLowerCase() === 'production';` | production ⇒ requireSecure |
| `src/app/admin/oidc-boot.ts:223` | `if (cookiePolicy.requireSecure && !configSecure && !cookiePolicy.trustProxyProtocol) {` | điều kiện chặn |
| `src/app/admin/auth-dispatch.ts:109-110` | `const posture = legacyCookiePosture(request, config);` / `if (posture.denied) {` | mint bị từ chối |
| `src/app/admin/auth-dispatch.ts:193` | `if (!proven && policy.requireSecure === true) return { secure: false, denied: true };` | TLS không chứng minh được ⇒ denied |
| `src/app/admin/auth-dispatch.ts:120-130` | `return { status: 503, … 'Secure connection required' … }` | **503** thay vì 302 |
| `src/main.ts:134-135` | `if (env.NODE_ENV === 'production' && (env.ARTIFACT_STORAGE_BACKEND ?? 'postgres') === 'postgres') {` / `throw new Error('ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime artifact grants');` | boot chết sớm |
| `packages/observability/src/logger.ts:55` | `const configured = value ?? process.env.DU_ENVIRONMENT ?? process.env.APP_ENV ?? process.env.NODE_ENV;` | nhãn `environment` |
| `src/modules/encryption/boot-options.ts:521` | `if (env['NODE_ENV'] === 'development' \|\| env['NODE_ENV'] === 'test') return;` | chính sách cipher key warn-only thuộc dev/test |

### 2.2 Assertion đỏ theo từng suite + giải thích ngữ nghĩa

| Suite | Đỏ khi production | Assertion đỏ (literal) | Vì sao về ngữ nghĩa |
|---|---|---|---|
| `admin-audit-mount.test.ts` | **6 failed / 6 total** | helper `adminCookie()`: `expect(res.status).toBe(302)` → nhận **503** (`tests/admin-audit-mount.test.ts:146`) | Test đăng nhập qua **HTTP loopback không TLS**. Dưới production, posture trở thành `requireSecure=true` (`oidc-boot.ts:142`) ⇒ login-mint **từ chối cấp cookie** và trả 503 "Secure connection required" (`auth-dispatch.ts:193` → `:120-130`). Đây là hành vi **fail-closed có chủ đích của production**, không phải lỗi chuỗi: test giả định posture dev/test (plain HTTP được phép mint) nên mọi test trong file đều chết ở bước lấy cookie. |
| `admin-audit-query.test.ts` | **25 failed / 1 passed / 26** | `expect(u).toBeDefined()` (`:161`), `expect(u?.searchParams.get('severity')).toBe('info')` (`:174`) — `u` undefined vì upstream **không hề được gọi** | Cùng cơ chế: không có cookie phiên ⇒ `open()` không mở được pane ⇒ `auditHit()` undefined ⇒ **toàn bộ** assertion forwarding/clamp/error-clarity đỏ. Ngữ nghĩa: không phải route sai mà **không có request nào được phát** vì cổng mint chặn ở tầng xác thực. |
| `v1-boot-typed-denial.test.ts` | **2 failed / 8 passed / 10** | `ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime artifact grants` (throw từ `src/main.ts:135`, gọi qua `withBootEnv` ở `tests/v1-boot-typed-denial.test.ts:183` → `:247`) | Test muốn khẳng định chính sách **dev/test**: thiếu profile cipher key ⇒ boot **tiếp tục + warn** (đối chiếu `boot-options.ts:521`). Nhưng `withBootEnv` chỉ dọn `BOOT_ENV_NAMES` (`:161-170`) — **thiếu `NODE_ENV`** — nên `production` từ shell lọt vào `main()`, và một guard production **khác** (`main.ts:134-135`, thiếu internal base URL) nổ trước. Ngữ nghĩa: boot fail-closed đúng theo production, nhưng test đang đo một chính sách khác. |
| `admin-error-boundary-offline.test.ts` | **1 failed / 41 passed / 42** | `expect(record).toMatchObject({ …, environment: 'test' })` (`:320-323`) → nhận `"environment": "prod"` | Nhãn `environment` của log record **được suy ra từ ambient env** theo thiết kế (`logger.ts:55`). Dưới production nhãn đúng là `prod`; test hard-code `'test'` ⇒ chỉ khác **nguồn sự thật của nhãn**, không phải lỗi bảo mật hay logic. |

**Tổng khi production: 6 + 25 + 2 + 1 = 34 test đỏ** — khớp đúng con số trong bối cảnh packet.

## BƯỚC 3 — Chạy lại 4 suite (mỗi suite một tiến trình, không retry)

Lệnh nguyên văn (cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`), cho từng file:
```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs <file>
```
- **Lần 1 — để nguyên môi trường shell:** `AMBIENT_NODE_ENV=[production]` (đo tại thời điểm chạy — *lưu ý: shell này vốn đã là production, nên lần 1 trùng lần 2 về giá trị*).
- **Lần 2 — đặt biến môi trường tiến trình con thành production (không sửa file):** `$env:NODE_ENV='production'; node … <file>`.
- **Lần 3 (đối chứng bổ sung, chỉ đổi env — cần thiết vì lần 1 không phải "unset" trong shell này):** `Remove-Item Env:\NODE_ENV; node … <file>`.

| Suite | Lần 1 ambient (`production`) | Lần 2 explicit (`production`) | Lần 3 đối chứng (`unset`) |
|---|---|---|---|
| `admin-audit-mount.test.ts` | exit **1** · `Test Suites: 1 failed, 1 total` · `Tests: 6 failed, 6 total` | exit **1** · `1 failed, 1 total` · `6 failed, 6 total` | exit **0** · `1 passed, 1 total` · `6 passed, 6 total` |
| `admin-audit-query.test.ts` | exit **1** · `1 failed, 1 total` · `25 failed, 1 passed, 26 total` | exit **1** · `1 failed, 1 total` · `25 failed, 1 passed, 26 total` | exit **0** · `1 passed, 1 total` · `26 passed, 26 total` |
| `v1-boot-typed-denial.test.ts` | exit **1** · `1 failed, 1 total` · `2 failed, 8 passed, 10 total` | exit **1** · `1 failed, 1 total` · `2 failed, 8 passed, 10 total` | exit **0** · `1 passed, 1 total` · `10 passed, 10 total` |
| `admin-error-boundary-offline.test.ts` | exit **1** · `1 failed, 1 total` · `1 failed, 41 passed, 42 total` | exit **1** · `1 failed, 1 total` · `1 failed, 41 passed, 42 total` | exit **0** · `1 passed, 1 total` · `42 passed, 42 total` |
| **Tổng** | **34 failed** | **34 failed** | **0 failed, 84 passed** |

⇒ Tái lập đúng quan sát của coordinator: **34 đỏ chỉ vì `NODE_ENV=production`**; với `NODE_ENV` unset (jest tự set `NODE_ENV=test`) cả 4 suite xanh hoàn toàn. Không có FAIL nào bị bỏ qua; không sửa gì để xanh.

## BƯỚC 4 — Suy ra và trình bày (không tự quyết)

### 4.1 Repo kỳ vọng môi trường nào cho unit offline?
**`NODE_ENV=test` (hoặc unset để jest tự set `test`)** — bằng chứng:
1. Không có bất kỳ `package.json`/jest config nào ghim `production` (BƯỚC 1: 0 match).
2. Jest tự đặt `NODE_ENV='test'` khi biến chưa set; lần 3 đối chứng cho thấy 4 suite xanh và log record có `environment: 'test'` ⇒ nhánh `test` là nhánh được thiết kế.
3. Nhiều suite **chủ động kiểm soát** biến này thay vì phụ thuộc ambient: `admin-shell-session-lifecycle.test.ts:553-567` (lưu/set `'test'`/khôi phục), `rfx11-12-route-hardening.test.ts:107-113` (set/khôi phục), và hai suite đã sửa theo hướng **inject posture thay vì mutate NODE_ENV**: `admin-shell-server.test.ts:119-120`, `admin-shell-platform-mount.test.ts:193-194` — nguyên văn: *"SHELL-RED-FIX: inject the posture instead of mutating NODE_ENV — login-mint 503s under an inherited NODE_ENV=production otherwise."*; hỗ trợ bởi `src/app/admin/shell-server.ts:953-954` (*"inject `{ requireSecure: false, trustProxyProtocol: false }` instead of … mutating NODE_ENV/DU_ADMIN_COOKIE_SECURE."*).
4. Production vẫn được test, nhưng như **input tường minh** (`{ NODE_ENV: 'production' }` truyền vào hàm), ví dụ `rfx10-seed-gate.test.ts:138-180`, `encryption-boot-options.test.ts:441-484`, `runtime-grant-origin.test.ts:5-6` — tức production là **đối tượng được kiểm**, không phải môi trường chạy suite.

### 4.2 Nếu test vốn được thiết kế để chạy dưới `test` thì thiếu cấu hình gì?
1. **Thiếu ghim env ở tầng runner/config:** `jest.config.cjs` (không `setupFiles`/`globalSetup`) và `jest.unit.config.cjs` (chỉ spread base) đều không đặt `NODE_ENV`; `services/orchestrator/package.json:11-12` cũng không.
2. **Helper boot-env thiếu `NODE_ENV`:** `tests/v1-boot-typed-denial.test.ts:161-170` (`BOOT_ENV_NAMES`) không liệt kê `NODE_ENV`, nên `withBootEnv` (`:172-191`) không dọn nó.
3. **Suite boot shell thật không inject posture:** `admin-audit-mount.test.ts` / `admin-audit-query.test.ts` dựng shell mà không truyền `cookiePolicy: { trustProxyProtocol: false, requireSecure: false }` — trong khi 2 suite anh em đã làm đúng (`admin-shell-server.test.ts:119`, `admin-shell-platform-mount.test.ts:193`).
4. **Assertion phụ thuộc ambient:** `admin-error-boundary-offline.test.ts:320-323` hard-code `environment: 'test'` mà không ghim nguồn sinh ra nó.

### 4.3 Nếu test vốn được thiết kế để chạy dưới `production` thì 4 suite sai ở đâu?
Nhánh này **không đứng** theo bằng chứng §4.1, nhưng nếu buộc phải đọc theo hướng đó thì 4 suite sai kỳ vọng tại: `admin-audit-mount.test.ts:146` + `admin-audit-query.test.ts:161` (kỳ vọng login plain-HTTP mint được cookie trong khi production **cố ý** từ chối — phải cấp TLS/proxy trust hoặc inject posture), `v1-boot-typed-denial.test.ts:247` (kỳ vọng boot dev/test warn-only trong khi production fail-closed), `admin-error-boundary-offline.test.ts:323` (kỳ vọng nhãn `test` trong khi production phải là `prod`). Nói cách khác: muốn coi production là ambient thì phải viết lại 4 suite theo posture production — đắt và trái quy ước repo.

### 4.4 Tối thiểu 3 lựa chọn sửa (file:line dự kiến chạm · rủi ro · cách kiểm chứng)

**Lựa chọn 1 — Ghim `NODE_ENV=test` ở tầng jest config của unit lane (khuyến nghị chính).**
- Chạm: `orchestrator/services/orchestrator/jest.unit.config.cjs:26-29` (thêm `setupFiles: ['<rootDir>/tests/setup-node-env.cjs']`) + 1 file setup mới ~3 dòng `if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';` (hoặc set cứng `'test'`). Không cần đụng test nào.
- Rủi ro: **thấp–trung bình** — đổi môi trường cho *toàn bộ* lane: suite nào cố tình dựa vào ambient (ngoài 4 suite này) có thể đổi hành vi; giảm nhẹ bằng cách chỉ set khi **chưa có** giá trị. Che leak thay vì sửa gốc từng suite.
- Kiểm chứng: chạy lại 4 suite với `NODE_ENV=production` ⇒ phải xanh; chạy full unit lane 2 lần (ambient production và unset) ⇒ kết quả phải **giống nhau**; kiểm `shouldSeedDevFallback`/`boot-options` không đổi hành vi dev/test.

**Lựa chọn 2 — Làm 4 suite độc lập môi trường (khuyến nghị kèm).**
- Chạm: `tests/admin-audit-mount.test.ts` + `tests/admin-audit-query.test.ts` (truyền `cookiePolicy: { trustProxyProtocol: false, requireSecure: false }` theo mẫu `admin-shell-server.test.ts:119-120`), `tests/v1-boot-typed-denial.test.ts:161-170` (thêm `'NODE_ENV'` vào `BOOT_ENV_NAMES`, và set `NODE_ENV: 'test'` trong overrides `:178-181`), `tests/admin-error-boundary-offline.test.ts:320-323` (ghim env cho test hoặc assert nhãn theo nguồn suy ra).
- Rủi ro: **thấp** (test-only, không đổi product), nhưng phải sửa 4 file và vẫn nhạy với các biến ambient khác.
- Kiểm chứng: mỗi suite chạy 2 lần (ambient production / unset) ⇒ cùng xanh; chạy lại 2 suite anh em đã sửa làm đối chứng.

**Lựa chọn 3 — Ghim ở npm script (ví dụ `cross-env NODE_ENV=test jest …`).**
- Chạm: `orchestrator/services/orchestrator/package.json:11-12` (+ devDependency `cross-env`, hoặc wrapper `scripts/run-tests.cjs`).
- Rủi ro: **trung bình** — thêm phụ thuộc/indirection; và **quan trọng:** runner chuẩn mà verifier dùng là `node node_modules/jest/bin/jest.js …` **trực tiếp**, **không** đi qua npm script ⇒ lựa chọn này **không** sửa được repro thật.
- Kiểm chứng: `pnpm --filter @du/orchestrator test:unit` dưới ambient production ⇒ xanh; **nhưng** chạy lại đúng lệnh trực tiếp của packet ⇒ vẫn đỏ ⇒ chỉ dùng như lớp bổ sung.

**Lựa chọn 4 (bổ sung, không thay thế) — Ghi rõ yêu cầu môi trường vào tài liệu/CI.**
- Chạm: `docs/28-test-inventory.md` (mục unit lane) + nơi chạy CI (ngoài `du-rework`).
- Rủi ro: **không** — nhưng chỉ là tài liệu, không chặn được đỏ.

### 4.5 Lựa chọn NÊN TRÁNH
- **Chỉ ghim ở npm script (Lựa chọn 3 đơn lẻ)** — vì runner trực tiếp `node node_modules/jest/bin/jest.js --config jest.unit.config.cjs …` (đúng lệnh của packet này và của các verifier khác) bỏ qua npm script ⇒ repro vẫn đỏ, tạo cảm giác "đã sửa" sai.
- **Nới/hạ assertion để xanh** — ví dụ đổi `expect(environment).toBe('test')` thành match `/test|prod/`, bỏ assert 302 của login-mint, hay xoá `BOOT_ENV_NAMES` — sẽ **xoá bằng chứng fail-closed của production** (cookie TLS, boot guard) và che mất chính posture bảo mật mà các suite khác đang pin.
- **Sửa product để chiều test** (hạ `requireSecure` khi thấy HTTP loopback, hay bỏ guard `ORCHESTRATOR_INTERNAL_BASE_URL`) — phá fail-closed production, rủi ro bảo mật thật.
- **Set `NODE_ENV=test` bên trong product code** (ngoài test/setup) — đổi hành vi runtime thật.

## GIỚI HẠN

- **Chưa có live window nào được claim**: toàn bộ chạy **offline** trên `jest.unit.config.cjs`; không khởi động PostgreSQL/Redis/S3, không chạy suite live, không kết luận gì về hành vi deployment.
- Chỉ đọc; **không sửa** source/test/config/package.json, không commit/add/push, không tick gate, không hand-edit `docs/21-openapi.json`, không đọc `.env.live`.
- Shell verify có ambient `NODE_ENV=production` ⇒ "lần 1" trùng "lần 2" về giá trị; lần 3 (unset) là đối chứng tôi thêm và ghi rõ, không thay thế 2 lần packet yêu cầu.
- BƯỚC 2 dựa trên 4 suite + source chúng chạy qua; tôi **không** truy hết mọi consumer khác của `NODE_ENV` trong repo (grep cho thấy còn `backfill-cli`, `encryption-boot-options`, `rfx10/rfx11`, `oidc-boot` — các suite đó xanh trong lượt này nên không nằm trong nhóm A).
