# Receipt — UI Review Packet #2 (Routes AWEB-04..07) (2026-10-04 14:22 +07)

- **Task ID**: `task_63f7ca92f53a`
- **Context ID**: `ctx_aweb_ui_review_2`
- **Lane**: `antigravity_1` (term `term_38afaa0e-081f-4e32-91b2-25459d048b0e`)
- **Spec**: `du-rework/coordination/dispatch-specs/2026-10-04-1412-AWEB-ui-review-2.md`
- **Plan reference**: `du-rework/tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` §4 (Gói bàn giao & UI verification)
- **Contract reference**: `du-rework/docs/admin-ui-development-contract.md` §5 (Review UI độc lập của Antigravity)

---

## 1. Tổng quan & Thông số Build Đánh giá

### 1.1. Build Artefacts
- **Repository Commit HEAD**: `b088eececcb5f3df0b4edbe073a29401dafda624`
- **Package**: `@du/admin-web@0.0.0`
- **Build Command**: `pnpm --filter @du/admin-web build`
- **Build Timing**: 17.04s (`tsc --noEmit` exit 0, Vite rollup exit 0)
- **Asset Hashes (Review Target)**:
  - **CSS**: `dist/assets/index-DJVB5wXc.css` (40.51 kB │ gzip: 8.01 kB)
  - **JS**: `dist/assets/index-D5FjAyVz.js` (442.45 kB │ gzip: 139.40 kB)
  - **HTML**: `dist/index.html` (0.47 kB)

### 1.2. Harness & Test Suite Isolation
- **Browser Suite Command**:
  ```bash
  npx playwright test --config admin-web/playwright.config.ts --output=test-results-ui-review-antigravity
  ```
- **Harness Isolation**: Chạy với per-lane isolated output directory (`test-results-ui-review-antigravity/`), ngăn chặn triệt để rủi ro collision `test-results/` khi các lane khác chạy song song (theo kinh nghiệm AWEB-06 §3).
- **Harness Port Configuration**: Shell server port `55119`, Upstream Stub port `55118`.
- **Kết quả Thực thi**: **43/43 tests PASSED** (thời gian chạy 1.2m, 0 lỗi, 0 flakiness).

---

## 2. Kết quả Đánh giá Chi tiết Từng Route (Contract §5)

Toàn bộ 9 route tích hợp mới + hệ thống Navigation từ Overview đã được kiểm tra chéo qua mã nguồn thực tế (`src/features/**`, `src/routes/**`), hành vi harness tự động, và tập ảnh evidence tại `coordination/evidence/aweb-ui-review-2/` và `coordination/evidence/aweb04|05|06|07/`.

---

### 2.1. Route `/admin/web/api-keys` (AWEB-05)
- **Vai trò & Phạm vi**: Quản lý API keys của tenant qua BFF (`GET /admin/api/api-keys`, `POST /admin/api/actions` apikey.issue / apikey.revoke).
- **Role / Tenant Fencing**:
  - Tự động điền tenant ID theo session scope (`session.scope.tenantId`).
  - Phân quyền: Phiên `viewer` hiển thị `DeniedState` (403), không đọc danh sách key (`05-09-keys-denied.png`).
  - Phiên non-admin hiển thị badge cảnh báo `admin role required for mutations`; các nút Issue/Revoke bị vô hiệu hóa.
- **Copy-Once Security**:
  - Sau khi issue thành công, raw key được render trong `AlertBanner` màu vàng và nút Copy (`05-02-copy-once.png`).
  - Giá trị **chỉ tồn tại trong React state** (`copyOnce` in-memory), tuyệt đối không lưu vào `localStorage`, `sessionStorage`, hay cookie.
  - Khi reload trang hoặc dismiss, key biến mất hoàn toàn (`05-03-copy-once-hidden.png`).
- **Quy trình Revoke**:
  - Nhấp nút `Revoke` mở `ConfirmDialog` với cảnh báo rõ ràng (`05-04-revoke-confirm.png`).
  - Xác nhận revoke cập nhật ngay trạng thái dòng thành badge đỏ `REVOKED` (`05-05-revoked.png`).
- **Tính Trung thực (Honesty)**:
  - Nút `Rotate` và `Disable` bị disabled hoàn toàn với tooltip giải thích cụ thể (`No rotate/disable backend action yet (F7)`) kèm badge cảnh báo màu vàng `rotate/disable: requires backend` (`05-01-keys-ready.png`). Không có logic giả lập.
- **State & Error Handling**:
  - `EmptyState` khi chưa có key, kèm nút Refresh (`05-06-keys-empty.png`).
  - `ErrorState` kèm mã lỗi và nút Retry khi upstream lỗi (`05-07-keys-error.png`, phục hồi thành công `05-08-keys-recovered.png`).
- **320px Reflow & A11y**: Bọc trong `TableContainer` cuộn ngang độc lập, không tràn viewport 320px (`05-12-keys-320px.png`).
- **Verdict**: **`UI_APPROVED`**

---

### 2.2. Route `/admin/web/connectors` (AWEB-05)
- **Vai trò & Phạm vi**: Tra cứu trạng thái revision của connector qua BFF (`GET /admin/api/connectors/:id/revisions/:rev`).
- **Tính Trung thực (Honesty & Gap Handling)**:
  - Do platform chưa có connector registry route (`PAR-03/14`), màn hình hỗ trợ tra cứu theo ID và revision.
  - Khi connector chưa được cấu hình (upstream trả về 404), giao diện hiển thị card thông báo trung thực: `"Connector unavailable — The platform answered 404: this connector is not configured on this deployment (connectorBaseUrls / PAR-03/14)"` kèm badge `requires backend` (`05-10-connector-unavailable.png`). Tuyệt đối không sinh dữ liệu giả.
  - Khi revision tồn tại (`05-11-connector-ready.png`): Hiển thị chi tiết endpoint, capabilities, secret slots; hai nút `Test credential` và `Rotate secret` bị disabled trung thực với badge `test/rotate: requires backend` và chú thích giải thích rõ ràng.
- **Verdict**: **`UI_APPROVED`**

---

### 2.3. Route `/admin/web/profiles` (AWEB-04)
- **Vai trò & Phạm vi**: Quản lý Profile chính sách (`PAR-12` + `PAR-13`).
- **Policy Capability Detection & Honesty**:
  - Khi capabilities rỗng (`capabilities: []`), toàn bộ nút Save, Publish, Rollback, Test Endpoint bị disabled kèm banner thông báo rõ ràng: `"policy backend not shipped (T-API-01..03)"` (`04-01-placeholder-honest.png`).
  - Trạng thái các nút phụ thuộc chặt chẽ vào mảng capability từ backend (`canTest`, `canPublish`, `canRollback`).
- **Locked Parameters & Protection**:
  - Các tham số bị khóa từ schema được đánh dấu `data-locked="true"` và badge `locked slot (display only)`.
  - Input bị disabled, giá trị bị khóa được loại bỏ khỏi mutation payload để tránh lỗi 400 từ server (`04-02-writer-missing-draft-kept.png`, `04-05-locked-field-hint.png`).
- **Xử lý Xung đột & Lỗi 409 / 400**:
  - Khi phát hiện stale revision (HTTP 409 Conflict), giao diện hiển thị banner cảnh báo xung đột nhưng **bảo tồn toàn vẹn bản nháp (draft)** của người dùng (`04-04-conflict-draft-kept.png`).
  - Khi server trả về 400 locked field, hiển thị gợi ý rõ ràng và giữ nguyên draft (`04-05`).
- **Bulk Save & Settled Semantics**:
  - Lưu nhiều endpoint sử dụng `Promise.allSettled`, báo cáo kết quả chi tiết từng dòng (dòng nào thành công, dòng nào thất bại) mà không rollback các dòng đã lưu thành công (`04-06-bulk-partial.png`).
- **Secret Write-Only**:
  - `fileUrlAuthConfig`: Secret field chỉ gửi một lần qua mutation, không bao giờ được backend trả về dạng plaintext hay prefill vào form.
- **Test Endpoint Modal**:
  - Hộp thoại Test Endpoint mở với `Modal` a11y đầy đủ; khi backend endpoint chưa shipped, hiển thị trung thực lỗi 404 (`04-08-test-endpoint-honest-404.png`).
- **Phân quyền & 320px**:
  - Phiên viewer nhận `DeniedState` với lý do `T-AUTH-03` (`04-07-viewer-denied.png`).
  - Co giãn mượt mà trên viewport 320px, không tràn ngang (`04-09-profiles-320px.png`).
- **Verdict**: **`UI_APPROVED`**

---

### 2.4. Route `/admin/web/operations` (AWEB-06)
- **Vai trò & Phạm vi**: Giám sát tác vụ nền (operations), xem danh sách và chi tiết kết quả/artifacts (`GET /admin/api/operations`, `GET /admin/api/operations/:id`).
- **Role / Tenant Fencing**:
  - Mọi request đều được fence chặt chẽ theo tenant của session. Stub verify khẳng định header wire gửi đúng `tenant=<uuid>` (`06-05-operations-operator-fenced.png`).
- **Tính Trung thực (Honesty)**:
  - Do các hành động Cancel/Resume/Replay chỉ tồn tại trên plane `x-api-key` và chưa được compose vào admin path (`P2-06/P9`), cả 3 nút này đều bị disabled kèm badge vàng `actions: requires backend` (`06-01-operations-ready.png`).
- **Chi tiết & Artifacts**:
  - Nhấp vào mã ID mở modal hiển thị đầy đủ metadata, step timeline, và danh sách artifacts (`06-02-operation-detail.png`).
- **State & Responsive**:
  - `EmptyState` khi không có tác vụ (`06-03-operations-empty.png`).
  - `ErrorState` và retry thành công (`06-04-operations-error.png`).
  - Bảng cuộn ngang an toàn trên 320px (`06-11-operations-320px.png`).
- **Verdict**: **`UI_APPROVED`**

---

### 2.5. Route `/admin/web/businesses` (AWEB-06)
- **Vai trò & Phạm vi**: Quản lý đăng ký business và các version lifecycle (`GET /admin/api/businesses`, `GET /admin/api/businesses/:id/versions`, `PUT /admin/api/businesses/:id/versions/:ver/enable|activate|deactivate`).
- **Phân quyền Cấp Platform (Platform Fence)**:
  - Đây là tài nguyên cấp nền tảng; phiên `operator` (tenant-scoped) hoặc `viewer` bị chặn ngay từ BFF với `DeniedState` (403 `ADMIN_CREDENTIAL_REQUIRED`), upstream hoàn toàn không bị gọi (`06-06-businesses-operator-denied.png`).
- **Hành động Phiên Admin (Real Mutations)**:
  - Với phiên `admin`, người dùng xem được danh sách business và version (`06-07-businesses-versions.png`).
  - Các nút `Enable`, `Activate`, `Deactivate` là **hành động thật**, gửi request kèm CSRF token hợp lệ và cập nhật trạng thái ngay lập tức (`06-08-business-enabled.png`).
- **Xử lý Lỗi**: `ErrorState` hiển thị đúng mã lỗi và nút Retry hoạt động chính xác (`06-09-businesses-retry-recovers.png`).
- **Verdict**: **`UI_APPROVED`**

---

### 2.6. Route `/admin/web/usage` (AWEB-06)
- **Vai trò & Phạm vi**: Thống kê mức sử dụng theo khung thời gian (`GET /admin/api/usage?from=...&to=...`).
- **Tính Toàn vẹn Dữ liệu (No Fake Aggregation)**:
  - Giao diện cung cấp bộ chọn thời gian chuẩn ISO (mặc định 24h qua).
  - Kết quả tóm tắt từ BFF được render nguyên bản (verbatim summary). Không có thuật toán client-side tự bịa đặt hay tổng hợp số liệu giả (`06-10-usage-ready.png`).
- **Role Fence**: Session scope tenant được gắn tự động bởi backend; viewer bị 403 denied chính xác.
- **Verdict**: **`UI_APPROVED`**

---

### 2.7. Route `/admin/web/security` (AWEB-07)
- **Vai trò & Phạm vi**: Quản lý cấu hình mã hóa nền tảng (`GET /admin/api/crypto-config`, `PUT /admin/api/crypto-config`).
- **Bảo mật Secret & Read/Write Semantics**:
  - Màn hình chỉ hiển thị key references/previews (`storageKeyRef`, `recipientKeyVersion`), tuyệt đối không có plaintext secret material trên giao diện hay wire payload (`07-01-security-ready.png`).
  - Phiên `admin` có thể cấu hình và thực thi thay đổi thật sự qua CSRF-protected PUT request.
- **Honest Unavailable State**:
  - Khi triển khai chưa kích hoạt module crypto (upstream trả về 503), màn hình hiển thị card trung thực: `"Crypto configuration unavailable — requires deployment action"` (`07-02-security-unconfigured.png`).
- **Phân quyền & Co giãn**:
  - Phiên `viewer` bị từ chối truy cập bằng `DeniedState` (`07-03-security-denied.png`).
  - Viewport 320px reflow hoàn hảo, không tràn viền (`07-06-security-320px.png`).
- **Verdict**: **`UI_APPROVED`**

---

### 2.8. Route `/admin/web/identity` (AWEB-07)
- **Vai trò & Phạm vi**: Giám sát phiên làm việc hiện tại và thông tin danh tính (`GET /admin/api/session`).
- **Tính Trung thực về Khả năng Chưa Hỗ trợ**:
  - Hiển thị metadata phiên thật: Principal name, kind, role badge, CSRF status (`07-04-identity.png`).
  - Do biến môi trường `DU_ADMIN_AUTH_MODE` (theo module `LOCAL-00/03`) chưa được mount vào shell runtime, màn hình ghi rõ trạng thái: **`"chưa managed"`** thay vì hiển thị trạng thái giả.
  - Danh sách người dùng và phiên đăng nhập (chờ backend LOCAL/OIDC) được đặt trong card riêng với thông báo trung thực: `"User and session management requires backend"`.
- **Verdict**: **`UI_APPROVED`**

---

### 2.9. Route `/admin/web/settings` (AWEB-07)
- **Vai trò & Phạm vi**: Bảng hướng dẫn cấu hình và trạng thái triển khai hạ tầng.
- **Tuyệt đối Không có Nút Save Giả (Zero Fake Save Buttons)**:
  - Do chưa có deployment adapter (staged-rollout/rollback runtime adapter), màn hình được thiết kế thuần túy là catalog thông tin hướng dẫn (`07-05-settings.png`).
  - Mã nguồn và test assertion khẳng định rõ ràng: **Số lượng nút Save trên trang = 0** (`expect(await page.locator('button:has-text("Save")').count()).toBe(0)`).
  - Từng dòng cấu hình (`DU_ADMIN_WEB`, `ADMIN_SHELL_PORT`, `ENCRYPTION_KEY`, v.v.) đều ghi rõ nguồn (`source`), đơn vị quản lý (`managedBy`), và trạng thái hiệu lực (`effective`) kèm badge `requires deployment action`.
- **Verdict**: **`UI_APPROVED`**

---

### 2.10. Hệ thống Điều hướng Tổng quan (Overview Navigation)
- **Thanh Điều hướng Mục (Sections Navigation)**:
  - Tại header của `/admin/web/overview`, phần tử `<nav aria-label="Admin Web sections">` cung cấp đầy đủ liên kết tới toàn bộ 9 phân hệ:
    - `/operations`
    - `/businesses`
    - `/usage`
    - `/profiles`
    - `/api-keys`
    - `/connectors`
    - `/security`
    - `/identity`
    - `/settings`
  - Tất cả liên kết sử dụng `Link` từ `react-router`, chuyển trang tức thì (client-side routing) mà không gây reload toàn bộ trang.
- **Verdict**: **`UI_APPROVED`**

---

## 3. Bảng Tổng Hợp Verdict Đánh Giá

| # | Route / Phân Hệ | Role / Tenant Gate | Error Taxonomy (401/403/409/422) | 320px / Keyboard Focus | Honesty (Disabled / Write-only / No fake data) | Evidence Ảnh | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `/admin/web/api-keys` | Admin / Tenant-scoped (Viewer 403) | Đầy đủ `Denied`, `Empty`, `Error` + Retry | Đạt (`05-12`) | `copyOnce` in-memory; Rotate/Disable disabled + reason | `05-01` .. `05-12` | **`UI_APPROVED`** |
| 2 | `/admin/web/connectors` | Admin / Read-only | 404 unconfigured card; 502 bad format | Đạt | Card unavailable trung thực; Test/Rotate disabled | `05-10`, `05-11` | **`UI_APPROVED`** |
| 3 | `/admin/web/profiles` | Tenant / Role (Viewer 403 T-AUTH-03) | 409 Conflict draft kept; 400 locked slot hint | Đạt (`04-09`) | Capabilities-driven; locked params disabled; write-only secret; honest 404 modal | `04-01` .. `04-09` | **`UI_APPROVED`** |
| 4 | `/admin/web/operations` | Tenant-fenced (Operator token header) | `Empty`, `Error`, `Denied` | Đạt (`06-11`) | Cancel/Resume/Replay disabled with honest badge; real artifacts viewer | `06-01` .. `06-05`, `06-11` | **`UI_APPROVED`** |
| 5 | `/admin/web/businesses` | Platform Admin only (Operator/Viewer 403) | `DeniedState` (403) upstream untouched | Đạt | Real version lifecycle actions via CSRF | `06-06` .. `06-09` | **`UI_APPROVED`** |
| 6 | `/admin/web/usage` | Tenant-scoped session | `Empty`, `Error`, `Denied` | Đạt | Verbatim summary; không tổng hợp số liệu giả | `06-10` | **`UI_APPROVED`** |
| 7 | `/admin/web/security` | Platform Admin only (Viewer 403) | 503 unconfigured card | Đạt (`07-06`) | No plaintext secret on wire; honest unavailable card | `07-01` .. `07-03`, `07-06` | **`UI_APPROVED`** |
| 8 | `/admin/web/identity` | Live session metadata | 401 sign-in link; 403 denied | Đạt | Ghi nhận trung thực `chưa managed`; users list unavailable | `07-04` | **`UI_APPROVED`** |
| 9 | `/admin/web/settings` | Informational catalog | Read-only | Đạt | 0 nút Save; ghi chú rõ `requires deployment action` | `07-05` | **`UI_APPROVED`** |
| 10 | Overview Navigation | Mount session gate | N/A | Đạt | Đầy đủ 9 links tới tất cả các màn hình | `overview-01` | **`UI_APPROVED`** |

---

## 4. Bằng chứng Kiểm thử Tự động (Harness Proofs)

```bash
# Production build
cwd: D:\Git\dugate\du-rework
command: pnpm --filter @du/admin-web build
exit_code: 0
assets:
  dist/assets/index-DJVB5wXc.css   40.51 kB │ gzip:   8.01 kB
  dist/assets/index-D5FjAyVz.js   442.45 kB │ gzip: 139.40 kB
  built in 17.04s

# Playwright Browser Suite (isolated lane output)
cwd: D:\Git\dugate\du-rework\tests\browser
command: npx playwright test --config admin-web/playwright.config.ts --output=test-results-ui-review-antigravity
exit_code: 0
output:
Running 43 tests using 1 worker

  ok   1 admin-web\admin-web.spec.ts:52:7 › 1. direct unauth /admin/web -> 302 login; login form renders (956ms)
  ok   2 admin-web\admin-web.spec.ts:67:7 › 2. login -> React app renders; no serious console errors (934ms)
  ok   3 admin-web\admin-web.spec.ts:80:7 › 3. reload keeps the session and re-renders the app (1.4s)
  ok   4 admin-web\admin-web.spec.ts:89:7 › 4. 320px viewport: no horizontal overflow; nav reachable (1.3s)
  ok   5 admin-web\admin-web.spec.ts:103:7 › 5. keyboard: Tab reaches a control with a visible focus ring (1.3s)
  ok   6 admin-web\admin-web.spec.ts:126:7 › 6. theme: light + data-theme=dark render distinctly (1.3s)
  ok   7 admin-web\api-keys-connectors.spec.ts:60:7 › 1. api-keys ready: tenant rows + read-only bindings + F7 disabled actions (1.4s)
  ok   8 admin-web\api-keys-connectors.spec.ts:81:7 › 2. issue → copy-once shown exactly once, never stored, gone after reload (1.5s)
  ok   9 admin-web\api-keys-connectors.spec.ts:103:7 › 3. revoke flow with confirm → row becomes REVOKED (1.4s)
  ok  10 admin-web\api-keys-connectors.spec.ts:122:7 › 4. empty and error+retry states (1.4s)
  ok  11 admin-web\api-keys-connectors.spec.ts:143:7 › 5. viewer session → denied on api-keys (1.0s)
  ok  12 admin-web\api-keys-connectors.spec.ts:153:7 › 6. connectors: not configured → honest unavailable, no fake actions (1.2s)
  ok  13 admin-web\api-keys-connectors.spec.ts:172:7 › 7. connectors: revision ready → test/rotate stay disabled with reason (1.3s)
  ok  14 admin-web\api-keys-connectors.spec.ts:188:7 › 8. 320px: api-keys reflows without horizontal overflow (1.1s)
  ok  15 admin-web\identity-security-settings.spec.ts:60:7 › 1. security ready (admin): view + real apply change (1.6s)
  ok  16 admin-web\identity-security-settings.spec.ts:79:7 › 2. security unconfigured → honest requires-deployment-action card (1.2s)
  ok  17 admin-web\identity-security-settings.spec.ts:91:7 › 3. security denied for a viewer session (1.1s)
  ok  18 admin-web\identity-security-settings.spec.ts:101:7 › 4. identity: real session + auth-mode not managed + users list unavailable (1.2s)
  ok  19 admin-web\identity-security-settings.spec.ts:114:7 › 5. settings: deployment guidance, no fake Save anywhere (1.2s)
  ok  20 admin-web\identity-security-settings.spec.ts:127:7 › 6. 320px: security reflows without horizontal overflow (1.1s)
  ok  21 admin-web\operations-business.spec.ts:60:7 › 1. operations ready (admin) → rows, disabled actions, detail + artifacts (1.4s)
  ok  22 admin-web\operations-business.spec.ts:79:7 › 2. operations empty → EmptyState; error → retry recovers (1.4s)
  ok  23 admin-web\operations-business.spec.ts:98:7 › 3. operator session: tenant-fenced operations; business registry denied (1.3s)
  ok  24 admin-web\operations-business.spec.ts:117:7 › 4. businesses ready (admin) → versions + real Enable action (1.5s)
  ok  25 admin-web\operations-business.spec.ts:139:7 › 5. businesses error → retry recovers (1.4s)
  ok  26 admin-web\operations-business.spec.ts:153:7 › 6. usage ready → verbatim summary (1.2s)
  ok  27 admin-web\operations-business.spec.ts:167:7 › 7. 320px: operations reflows without horizontal overflow (1.1s)
  ok  28 admin-web\overview.spec.ts:62:7 › 0. unauth direct /admin/web/overview → login (mount gate) (289ms)
  ok  29 admin-web\overview.spec.ts:69:7 › 1. operator tenant → ready: tenant-fenced rows + honest tiles (1.3s)
  ok  30 admin-web\overview.spec.ts:92:7 › 2. empty scope → EmptyState with refresh affordance (932ms)
  ok  31 admin-web\overview.spec.ts:101:7 › 3. upstream failure → 502 error, retry succeeds after recovery (998ms)
  ok  32 admin-web\overview.spec.ts:115:7 › 4. viewer session → denied, upstream untouched (985ms)
  ok  33 admin-web\overview.spec.ts:127:7 › 5. SPA-level 401 → sign-in link (session expired mid-flight) (992ms)
  ok  34 admin-web\overview.spec.ts:147:7 › 6. 320px viewport: no horizontal overflow on Overview (774ms)
  ok  35 admin-web\profiles.spec.ts:60:7 › 1. placeholder projection → honest "policy backend not shipped", actions disabled (1.3s)
  ok  36 admin-web\profiles.spec.ts:74:7 › 2. fixture + writer missing → 404 shown, draft kept, locked slot display-only (1.3s)
  ok  37 admin-web\profiles.spec.ts:93:7 › 3. fixture + writer ok → save persists, reload shows the new revision (1.5s)
  ok  38 admin-web\profiles.spec.ts:113:7 › 4. stale revision (409) → conflict banner, draft survives (1.4s)
  ok  39 admin-web\profiles.spec.ts:133:7 › 5. locked-field 400 → explicit hint, draft survives (1.4s)
  ok  40 admin-web\profiles.spec.ts:149:7 › 6. bulk save → allSettled per-row results, no common rollback (1.5s)
  ok  41 admin-web\profiles.spec.ts:168:7 › 7. viewer session → denied with the T-AUTH-03 gate reason (1.0s)
  ok  42 admin-web\profiles.spec.ts:178:7 › 8. Test Endpoint runs through the gated route → honest 404 while unshipped (1.3s)
  ok  43 admin-web\profiles.spec.ts:192:7 › 9. 320px: profiles reflows without horizontal overflow (1.1s)

  43 passed (1.2m)
```

---

## 5. Danh Sách Ghi Nhận Khoảng Trống Backend (Non-blocking Gaps)

Tất cả các khoảng trống backend đều đã được giao diện nhận diện và phản ánh trung thực, hoàn toàn tuân thủ nguyên tắc Contract §5:
1. **API Keys**: Các hành động Rotate & Disable chưa có backend action (F7) $\rightarrow$ Vô hiệu hóa nút bấm và hiển thị badge `rotate/disable: requires backend`.
2. **Connectors**: Registry list chưa có endpoint danh mục nền tảng (`PAR-03/14`, F3) $\rightarrow$ Giao diện hỗ trợ tra cứu theo ID và hiển thị thông báo trung thực khi 404. Hai nút Test credential & Rotate secret bị vô hiệu hóa kèm lý do.
3. **Profiles**: Policy runtime dispatcher chưa triển khai đầy đủ (`T-API-01..03`) $\rightarrow$ Các hành động Save/Publish/Rollback/Test bị vô hiệu hóa khi backend không trả về capability, kèm banner giải thích.
4. **Operations**: Các thao tác Cancel, Resume, Replay chỉ tồn tại trên plane `x-api-key` chưa nối vào admin path $\rightarrow$ Disabled kèm badge `actions: requires backend`.
5. **Identity**: Module auth-mode `DU_ADMIN_AUTH_MODE` (LOCAL-00/03) chưa mount $\rightarrow$ Hiển thị nhãn `chưa managed`.
6. **Settings**: Chưa có runtime deployment adapter $\rightarrow$ Giữ trạng thái thông tin hướng dẫn, tuyệt đối không tạo nút Save giả lập.

---

## 6. Tuân thủ Ranh giới (Lease & Non-interference)

- **Write Lease**: Báo cáo được tạo trong thư mục điều phối `coordination/reports/`. Không có bất kỳ sửa đổi nào ngoài phạm vi cho phép (`src/routes/**`, `src/features/**`, `src/lib/api/**`, backend, orchestrator, tasks đều nguyên vẹn).
- **Git Commit**: Không thực hiện `git commit`.
- **Hạ tầng Live**: Tuyệt đối không can thiệp hoặc chạm vào bất kỳ container đang chạy nào của user (`du-live-*`, `graphql-data-connector`, `onlyoffice`, v.v.).

---

## 7. Kết luận

Toàn bộ 9 route thuộc phạm vi `AWEB-04..07` cùng hệ thống điều hướng Overview trên build hash `index-DJVB5wXc.css` / `index-D5FjAyVz.js` đạt chất lượng nghiệm thu và được cấp **`UI_APPROVED`**. Gói bàn giao sẵn sàng cho các bước phối hợp tiếp theo của Coordinator.
