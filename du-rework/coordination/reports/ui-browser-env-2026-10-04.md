# Runbook & Specification: UI-BROWSER-ENV (Real Browser Evidence Execution)

- **Date:** 2026-10-04 23:55 +07
- **Author:** Antigravity UI Lead (`term_ae2d7e42`)
- **Packet Reference:** `UI-BROWSER-ENV` (Prep & Runbook)
- **Authority:** Coordinator Directive 23:49 (`run_069ecd6957cd`)
- **Governing Contracts:**
  - `docs/admin-ui-development-contract.md` (§1, §3, §4, §5)
  - `tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` (AWEB-01b, AWEB-03b, AWEB-04..08)
- **Mode:** READ-ONLY on source/plans; write receipt only; no source edits; no gate ticks; no commit/push.

---

## 1. Mục Đích & Bối Cảnh (Context & Purpose)

Sau khi gói `P745-UI-KEYS` đã chính thức nhận phán quyết `UI_APPROVED` và lỗi transpile CJS của `p730-curl-import.spec.ts` được giải quyết triệt để (`CURL-SPEC-FIX`), toàn bộ bộ kiểm thử của Admin Web tại `tests/browser/admin-web/` đã đạt trạng thái collection sạch (**72 tests in 9 files, exit 0**).

Tuy nhiên, ngoại trừ 2 file offline static/unit guards (`p730-curl-import.spec.ts` 16 tests và `p745-ui-keys.spec.ts` 8 tests), **46 tests kiểm thử giao diện trình duyệt thật (Playwright)** đang dừng ở các chốt chặn `beforeAll` hoặc `test.skip` do thiếu cấu hình biến môi trường (`env vars`) và dữ liệu mồi (`seed data`).

Tài liệu này cung cấp **Runbook chuẩn mực**, bảng ánh xạ biến môi trường, yêu cầu seed dữ liệu, các bước chạy mẫu (CLI reproduction), cơ chế thu thập bằng chứng (evidence artifacts) và ma trận unskip toàn diện cho cả 2 tầng thực thi:
1. **Plane A (Harness Seam):** Môi trường giả lập source seam nội bộ (không cần Live DB/Docker).
2. **Plane B (Live Deployment):** Môi trường kiểm thử E2E trên hạ tầng dịch vụ thực tế.

---

## 2. Kiến Trúc Hai Tầng Kiểm Thử (Dual-Plane Testing Architecture)

Hệ thống kiểm thử trình duyệt của Admin Web được phân tách rành mạch thành 2 tầng độc lập:

```mermaid
flowchart TD
    subgraph PlaneA["Plane A: Harness Seam (Offline E2E)"]
        H1["harness.ts"] -->|Boots Port 0| S1["createAdminShellServer (Source)"]
        H1 -->|Boots Port 0| ST1["Scripted Upstream Stub (/__stub/mode)"]
        H1 -->|In-memory| SS1["MapSessionStore (Operator & Viewer)"]
        H1 -->|Exports| J1["harness.json"]
        J1 -->|Supplies Env| PW1["Playwright Test Runner (admin-web/playwright.config.ts)"]
        PW1 -->|46 Tests| SC1["Specs: admin-web, overview, profiles, api-keys, ops, security"]
    end

    subgraph PlaneB["Plane B: Live Deployment (Live E2E - Gated)"]
        ENV1[".env.live"] -->|DU_ADMIN_WEB=1| LS1["Live Admin Shell Server (Port 3001)"]
        PG1["PostgreSQL (Migrations 0001..0030)"] --> LS1
        RED1["Redis & Orchestrator (Port 3000)"] --> LS1
        PW2["Playwright Test Runner (admin-web/playwright.config.ts)"] -->|5 Tests (AWEB-08 live)| LS1
    end
```

- **Plane A (Harness Seam):** Tái tạo trọn vẹn hành vi của Admin Web SPA kết hợp với Admin Shell server được boot trực tiếp từ mã nguồn TypeScript qua `createAdminShellServer`. Thích hợp chạy trên mọi máy developer/CI mà không phụ thuộc vào Docker, Postgres, hay Redis.
- **Plane B (Live Deployment):** Đánh giá mức độ tích hợp cuối cùng trên hạ tầng production/staging thực tế với cơ sở dữ liệu thật, kiểm tra xuyên suốt từ UI qua BFF đến PostgreSQL.

---

## 3. Danh Mục Biến Môi Trường Chi Tiết (Environment Variables Matrix)

### 3.1. Plane A: Harness Seam Environment Variables

Các biến này bắt buộc phải được thiết lập trước khi thực thi các test suite thuộc Plane A (được trích xuất từ file kết quả do `harness.ts` xuất ra):

| Tên biến môi trường | Bắt buộc | Kiểu giá trị | Nguồn cấp / Giá trị mẫu | Mục đích & Phạm vi sử dụng |
|---|:---:|---|---|---|
| `AWEB01B_URL` | **Có** | `string` (URL) | `http://127.0.0.1:<port>` (từ `harness.json`) | Base URL của Admin Shell server do harness khởi tạo động trên port ngẫu nhiên. |
| `AWEB01B_TOKEN` | **Có** | `string` | `'aweb01b-browser-token'` | Token quản trị viên dùng để submit form đăng nhập ban đầu (`/admin/login`). |
| `AWEB01B_EVIDENCE` | **Có** | `string` (Path) | `D:\Git\dugate\du-rework\coordination\evidence\aweb-browser` | Thư mục đích để lưu trữ các ảnh chụp màn hình (screenshots) bằng chứng. |
| `AWEB03B_STUB` | **Có** | `string` (URL) | `http://127.0.0.1:<stubPort>` (từ `harness.json`) | Base URL của mock backend stub; dùng để reset kịch bản (`/__stub/mode?reset=1`) và kiểm tra request capture. |
| `AWEB03B_OPERATOR` | **Có** | `string` | `'O'.repeat(43)` | Session ID giả lập người dùng có quyền **Operator** (toàn quyền CRUD trên tenant). |
| `AWEB03B_VIEWER` | **Có** | `string` | `'W'.repeat(43)` | Session ID giả lập người dùng có quyền **Viewer** (chỉ đọc, kiểm thử chặn quyền và trạng thái denied). |
| `AWEB03B_TENANT` | **Có** | `string` (UUID) | `'11111111-1111-4111-8111-111111111111'` | UUID của tenant mẫu, dùng để xác thực tenant-fencing trong các query và audit ledger. |

### 3.2. Plane B: Live Deployment Environment Variables

Áp dụng riêng cho `live-admin-web.spec.ts` (gated E2E):

| Tên biến môi trường | Bắt buộc | Kiểu giá trị | Nguồn cấp / Giá trị mẫu | Mục đích & Phạm vi sử dụng |
|---|:---:|---|---|---|
| `DU_LIVE_INFRA` | **Có** | `'1' \| '0'` | `'1'` | Cờ cổng bảo vệ (Gate switch). Nếu không bằng `'1'`, spec sẽ tự động SKIP an toàn. |
| `AWEB_LIVE_URL` | **Có** | `string` (URL) | `http://127.0.0.1:3001` | Địa chỉ lắng nghe của Admin Shell trên cụm live deployment. |
| `AWEB_LIVE_TOKEN` | **Có** | `string` | Lấy từ file cấu hình `.env.live` (`ADMIN_TOKEN`) | Token xác thực qua màn hình đăng nhập shell legacy. |
| `AWEB_LIVE_COOKIE` | Tùy chọn | `string` | `du_session=<session_uuid>` | Cookie phiên nếu muốn bypass form login và đóng vai một session OIDC cụ thể. |
| `AWEB_LIVE_TENANT` | Tùy chọn | `string` (UUID) | `11111111-1111-4111-8111-111111111111` | Bật chế độ assert nghiêm ngặt đối với sự kiện sinh ra trong Audit Ledger (`apikey.issue`). |
| `AWEB_LIVE_EVIDENCE` | Tùy chọn | `string` (Path) | `coordination/evidence/aweb08-live` | Thư mục lưu ảnh chụp bằng chứng thực tế trên live stack. |

---

## 4. Yêu Cầu Dữ Liệu Mồi (Seed Data Requirements)

### 4.1. Đối với Plane A (Harness Stub Mode)
Harness `harness.ts` tự động quản lý dữ liệu mồi trong bộ nhớ thông qua `StubState`:
1. **API Keys:**
   - 1 khóa mẫu đang hoạt động (`ACTIVE`): ID `aaaaaaaa-1111-4111-8111-111111111111`, tiền tố `du_live_ab12`, gắn với `OPERATOR_TENANT`.
2. **Audit Ledger:**
   - 2 sự kiện mồi: `admin.profile.publish` (mức `info`) và `admin.connector.rotate_credential` (mức `warning`).
3. **Profiles:**
   - Chế độ `placeholder`: Profile chưa cấu hình (revision 0), các tham số rỗng.
   - Chế độ `fixture`: Profile đầy đủ (revision 7), model `gpt-4o`, API key đã khóa (`isLocked: true`), manifest hỗ trợ `extract` và `compare`.
4. **Cơ chế tự dọn dẹp (Self-reset):**
   - Trước mỗi test case (`test.beforeEach`), Playwright gửi lệnh gọi `fetch(`${STUB}/__stub/mode?reset=1`)` để hoàn nguyên toàn bộ trạng thái mồi, ngăn chặn test rò rỉ dữ liệu chéo nhau.

### 4.2. Đối với Plane B (Live Database Mode)
Để vượt qua 5 test case thực tế trong `live-admin-web.spec.ts`:
1. **Migrations Database:**
   - PostgreSQL phải được chạy đầy đủ migrations từ `0001` đến `0030_prompt_revisions_pin.sql`.
2. **Tenant Thực Tế:**
   - Ít nhất 1 tenant hợp lệ trong bảng `tenants` (khớp với giá trị truyền vào `AWEB_LIVE_TENANT`).
3. **Profile Đang Hoạt Động (Active Profile):**
   - Phải có ít nhất 1 bản ghi profile trong bảng `profiles` / `profile_names` (ví dụ: `doc-core` hoặc `default`) với con trỏ revision hiện hành (`profile_bindings.revision >= 1`).
4. **Quyền Quản Trị (Admin Shell Auth):**
   - Biến môi trường `ADMIN_TOKEN` trong `.env.live` phải trùng khớp với `AWEB_LIVE_TOKEN`.

---

## 5. Quy Trình Chạy Chuẩn (Standard Execution Runbook)

### 5.1. Bước Chuẩn Bị Bắt Buộc: Build Bundle Admin Web
Trước khi khởi động bất kỳ tiến trình browser nào, bundle giao diện người dùng phải được biên dịch sẵn:
```bash
# Thực hiện tại thư mục gốc repository (du-rework)
pnpm --filter @du/admin-web build
```
*Điều kiện tiên quyết:* Thư mục `apps/admin-web/dist` phải tồn tại và chứa file `index.html` cùng các assets javascript/css.

---

### 5.2. Chạy Plane A (Harness Seam — Offline Browser Evidence)

#### Phương án 1: Thực thi thủ công 2 Terminal (Dành cho Debug)

* **Terminal 1: Khởi động Harness Server**
  ```powershell
  cd D:\Git\dugate\du-rework
  $env:NODE_ENV = 'test'
  pnpm dlx tsx tests/browser/admin-web/harness.ts coordination/evidence/harness.json
  # Chờ cho đến khi terminal in ra: HARNESS_READY http://127.0.0.1:<port> ...
  ```

* **Terminal 2: Thực thi Playwright Suite**
  ```powershell
  cd D:\Git\dugate\du-rework\tests\browser
  # Đọc thông tin từ file harness.json vừa sinh ra
  $h = Get-Content D:\Git\dugate\du-rework\coordination\evidence\harness.json | ConvertFrom-Json

  $env:AWEB01B_URL      = $h.url
  $env:AWEB01B_TOKEN    = $h.token
  $env:AWEB01B_EVIDENCE = "D:\Git\dugate\du-rework\coordination\evidence\aweb-run"
  $env:AWEB03B_STUB     = $h.stubUrl
  $env:AWEB03B_OPERATOR = $h.sessions.operator
  $env:AWEB03B_VIEWER   = $h.sessions.viewer
  $env:AWEB03B_TENANT   = $h.tenant

  # Chạy toàn bộ các spec harness
  npx playwright test --config admin-web/playwright.config.ts
  ```

#### Phương án 2: Script Tự Động Hóa 1 Lệnh (Automated One-Shot Runner)
Coordinator hoặc Tester có thể sử dụng script mẫu sau để tự động hóa toàn bộ vòng đời: boot harness $\rightarrow$ lấy port $\rightarrow$ inject env $\rightarrow$ run playwright $\rightarrow$ kill harness:

```powershell
# Script: coordination/scripts/run-browser-harness.ps1
$ErrorActionPreference = 'Stop'
$repo = "D:\Git\dugate\du-rework"
$evidenceDir = "$repo\coordination\evidence\aweb-run"
$harnessJson = "$evidenceDir\harness.json"

if (!(Test-Path $evidenceDir)) { New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null }
if (Test-Path $harnessJson) { Remove-Item $harnessJson -Force }

Write-Host ">>> 1. Building admin-web bundle..." -ForegroundColor Cyan
pnpm --filter @du/admin-web build

Write-Host ">>> 2. Booting harness server..." -ForegroundColor Cyan
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "pnpm"
$pinfo.Arguments = "dlx tsx tests/browser/admin-web/harness.ts $harnessJson"
$pinfo.WorkingDirectory = $repo
$pinfo.EnvironmentVariables["NODE_ENV"] = "test"
$pinfo.UseShellExecute = $false
$harnessProc = [System.Diagnostics.Process]::Start($pinfo)

try {
    # Chờ file harness.json xuất hiện (tối đa 15s)
    $timeout = 15; $waited = 0
    while (!(Test-Path $harnessJson) -and $waited -lt $timeout) {
        Start-Sleep -Milliseconds 500
        $waited += 0.5
    }
    if (!(Test-Path $harnessJson)) { throw "Harness boot timed out!" }

    $h = Get-Content $harnessJson | ConvertFrom-Json
    Write-Host ">>> Harness Ready at $($h.url)" -ForegroundColor Green

    $env:AWEB01B_URL      = $h.url
    $env:AWEB01B_TOKEN    = $h.token
    $env:AWEB01B_EVIDENCE = $evidenceDir
    $env:AWEB03B_STUB     = $h.stubUrl
    $env:AWEB03B_OPERATOR = $h.sessions.operator
    $env:AWEB03B_VIEWER   = $h.sessions.viewer
    $env:AWEB03B_TENANT   = $h.tenant

    Write-Host ">>> 3. Running Playwright browser test suite..." -ForegroundColor Cyan
    Push-Location "$repo\tests\browser"
    try {
        npx playwright test --config admin-web/playwright.config.ts
    } finally {
        Pop-Location
    }
} finally {
    Write-Host ">>> 4. Shutting down harness server..." -ForegroundColor Cyan
    if ($harnessProc -and !$harnessProc.HasExited) {
        $harnessProc.Kill()
    }
}
```

---

### 5.3. Chạy Plane B (Live Deployment — E2E Gated Evidence)

1. **Kích hoạt cờ route trong `.env.live`:**
   ```ini
   DU_ADMIN_WEB=1
   DU_ADMIN_WEB_ROUTES=overview,profiles,connectors,settings
   ```
2. **Khởi động lại Rework Dev Runner:**
   ```powershell
   # Không khởi động lại Docker! Chỉ khởi động lại service dev
   node scripts/dev.cjs --env-file=.env.live
   ```
3. **Thực thi lệnh Playwright Live:**
   ```powershell
   cd D:\Git\dugate\du-rework\tests\browser
   $env:DU_LIVE_INFRA       = '1'
   $env:AWEB_LIVE_URL       = 'http://127.0.0.1:3001'
   $env:AWEB_LIVE_TOKEN     = '<token_lay_tu_env_live>'
   $env:AWEB_LIVE_TENANT    = '11111111-1111-4111-8111-111111111111'
   $env:AWEB_LIVE_EVIDENCE  = 'D:\Git\dugate\du-rework\coordination\evidence\aweb08-live'

   npx playwright test --config admin-web/playwright.config.ts --grep "AWEB-08 live"
   ```

---

## 6. Kết Quả Dự Kiến & Bằng Chứng Thu Thập Được (Expected Outputs)

Khi toàn bộ biến môi trường được truyền đúng cách:

1. **Mã thoát (Exit Code):** `0`.
2. **Output màn hình Playwright:**
   - Plane A: `46 passed` (thời gian chạy dự kiến ~15s - 25s).
   - Offline Leafs: `24 passed` (thời gian chạy ~1s).
   - Tổng cộng: **70 passed**, 0 failed, 1 skipped (`live-admin-web` nếu chạy offline).
3. **Tệp bằng chứng ảnh (Evidence Artifacts):**
   Được tạo tự động trong thư mục `$env:AWEB01B_EVIDENCE`:
   - `01-unauth-login.png`: Chụp màn hình form đăng nhập token.
   - `02-login-rendered.png`: Giao diện Dashboard sau đăng nhập thành công.
   - `03-profiles-fixture.png`: Màn hình cấu hình Profile với dữ liệu mẫu.
   - `04-connectors-view.png`: Màn hình quản lý Connector & modal cURL.
   - `05-operations-grid.png`: Bảng điều khiển Operations & Business tasks.
   - `06-security-crypto.png`: Trạng thái mã hóa cấu hình at-rest.
4. **Không có lỗi Console (Console Error Invariant):**
   - Cơ chế `trackConsole(page)` sẽ fail test ngay lập tức nếu xuất hiện bất kỳ console error hoặc unhandled exception nào từ React app (loại trừ `favicon.ico` 404).

---

## 7. Rào Cản Hiện Tại & Điều Kiện Tiên Quyết (Current Blockers & Matrix)

| # | Rào cản / Yêu cầu | Trạng thái hiện tại | Giải pháp khắc phục |
|---|---|:---:|---|
| **B1** | **Bundle Frontend Dist** | Cần cập nhật sau sửa code | Bắt buộc chạy `pnpm --filter @du/admin-web build` trước khi boot harness. |
| **B2** | **CJS / ESM Spec Loader** | **ĐÃ GIẢI QUYẾT** | `cc_2` đã chuyển sang `__dirname` + `path.join()`, loại bỏ triệt để lỗi `import.meta.url`. |
| **B3** | **Quản lý Process Harness trên Windows** | Cần script bọc an toàn | Sử dụng mẫu PowerShell script ở Mục 5.2 để đảm bảo process node luôn được kill sạch khi test kết thúc hoặc gặp lỗi. |
| **B4** | **Live DB Seed Data** | Chưa có seed profile thật | Đối với Plane B, cần chạy migration và tạo profile/tenant thật trước khi gỡ cờ `DU_LIVE_INFRA`. Với Plane A, hoàn toàn không bị chặn. |

---

## 8. Ma Trận Test Sẽ Unskip Khi Có Đủ Biến Môi Trường (Unskip Matrix)

Toàn bộ 9 file kiểm thử của `@du/admin-web` (tổng cộng **75 tests**) được phân bổ như sau:

| Spec File | Số Test | Plane | Trạng thái hiện tại | Điều kiện kích hoạt (Unskip Trigger) |
|---|:---:|:---:|:---:|---|
| [`p745-ui-keys.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/p745-ui-keys.spec.ts) | 8 | Offline Leaf | **ĐANG CHẠY (PASS)** | Không phụ thuộc env/harness. |
| [`p730-curl-import.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/p730-curl-import.spec.ts) | 16 | Offline Leaf | **ĐANG CHẠY (PASS)** | Không phụ thuộc env/harness (sau khi CJS-fix). |
| [`admin-web.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/admin-web.spec.ts) | 6 | Plane A | Bị chặn tại `beforeAll` | Cần `AWEB01B_URL`, `TOKEN`, `EVIDENCE`. |
| [`overview.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/overview.spec.ts) | 7 | Plane A | Bị chặn tại `beforeAll` | Cần `AWEB01B_URL`, `EVIDENCE`, `AWEB03B_{STUB,OPERATOR,VIEWER,TENANT}`. |
| [`profiles.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/profiles.spec.ts) | 8 | Plane A | Bị chặn tại `beforeAll` | Cần `AWEB01B_URL`, `TOKEN`, `EVIDENCE`, `AWEB03B_{STUB,VIEWER}`. |
| [`api-keys-connectors.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/api-keys-connectors.spec.ts) | 9 | Plane A | Bị chặn tại `beforeAll` | Cần `AWEB01B_URL`, `TOKEN`, `EVIDENCE`, `AWEB03B_{STUB,VIEWER}`. |
| [`operations-business.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/operations-business.spec.ts) | 8 | Plane A | Bị chặn tại `beforeAll` | Cần `AWEB01B_URL`, `TOKEN`, `EVIDENCE`, `AWEB03B_{STUB,OPERATOR,TENANT}`. |
| [`identity-security-settings.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/identity-security-settings.spec.ts) | 8 | Plane A | Bị chặn tại `beforeAll` | Cần `AWEB01B_URL`, `TOKEN`, `EVIDENCE`, `AWEB03B_{STUB,VIEWER}`. |
| [`live-admin-web.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/live-admin-web.spec.ts) | 5 | Plane B | Tự động SKIP offline | Cần `DU_LIVE_INFRA=1`, `AWEB_LIVE_URL`, `AWEB_LIVE_TOKEN`. |
| **TỔNG CỘNG** | **75** | — | **24 PASS / 46 Sẵn sàng unskip / 5 Live Gated** | — |

---

## 9. Khuyến Nghị Cho Coordinator

1. **Thực thi ngay Plane A:** Coordinator có thể chỉ định lane `cc_2` hoặc `codex_tester_offline` chạy ngay script tự động Plane A để thu thập toàn bộ **46 test evidence** của các màn hình (`Overview`, `Profiles`, `Connectors`, `Operations`, `Security`).
2. **Thu thập ảnh bằng chứng:** Toàn bộ ảnh PNG sinh ra trong `coordination/evidence/aweb-run/` sẽ đóng vai trò bằng chứng nghiệm thu trực quan để Antigravity cấp verdict `UI_APPROVED` cấp độ trang (Full-Page Integrated Review).
3. **Giữ cờ Live (Plane B):** Tiếp tục duy trì `DU_LIVE_INFRA` ở chế độ gated cho tới khi các task backend W1c/W3 và Live DB seed được xác nhận hoàn tất.
