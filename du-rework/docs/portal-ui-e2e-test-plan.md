# KỊCH BẢN KIỂM THỬ GIAO DIỆN (UI E2E TEST PLAN) — ORCHESTRATOR PORTAL
**Mục tiêu:** Kiểm thử toàn diện tất cả các màn hình chức năng, trạng thái dữ liệu (Loading / Empty / Error / Denied), các tương tác Form/Modal và phát hiện lỗi giao diện (CSS, responsive, layout vỡ, console errors, accessibility).

---

## I. TỔNG QUAN PHẠM VI & MÔI TRƯỜNG KIỂM THỬ

1. **Ứng dụng kiểm thử:** Orchestrator Portal (`orchestrator/apps/admin-web`, build Vite production).
2. **Mount base URL:** `http://localhost:3301/admin/web/` (hoặc test preview `http://localhost:4173/admin/web/`).
3. **Công cụ thực thi tự động:** Playwright Test Suite (Chromium & Mobile viewport Pixel 7/iPhone).
4. **Các khía cạnh phát hiện lỗi UI bắt buộc (Defect Coverage):**
   - **Console Errors / Unhandled Exceptions:** 0 lỗi đỏ trong browser console (`window.onerror`, unhandled promise rejection).
   - **Mạng / Network Leak:** Không gọi ra các domain ngoài (CDN, Google Fonts, unpkg, cdnjs).
   - **Giao diện vỡ / Layout Overflow:** Không có phần tử tràn khung ngang (horizontal scrollbar ngoài ý muốn ở desktop & mobile).
   - **Xử lý trạng thái (State Panels):** Kiểm tra đủ 4 trạng thái trên từng màn:
     1. `LoadingState` (Skeleton / Spinner khi dữ liệu đang tải).
     2. `ReadyState` (Render đúng bảng, thẻ, biểu đồ khi có dữ liệu).
     3. `EmptyState` (Thông báo rỗng trực quan khi danh sách trống, không để màn hình trắng).
     4. `ErrorState` / `DeniedState` (Hiển thị banner lỗi lịch sự, không crash trang khi BFF trả về 401, 403, 500).
   - **Tiêu chuẩn Tiếp cận (A11y / Accessibility):** Đạt chuẩn WCAG 2.1 qua công cụ `axe-core` (0 critical/serious violations).

---

## II. MA TRẬN KỊCH BẢN KIỂM THỬ CHI TIẾT THEO TỪNG MÀN HÌNH

### 1. App Shell & Điều Hướng Toàn Cục (App Shell & Navigation)
- **Đường dẫn:** `/admin/web/`
- **Mục tiêu test:**
  - Tiêu đề trang (`document.title`): Phải hiển thị chính xác **"Orchestrator Portal"**.
  - Thanh điều hướng bên trái (Sidebar Navigation): Hiển thị đầy đủ logo, các mục điều hướng:
    * *Core:* Overview, API Keys, Connectors, Profiles, Operations, Businesses, Usage
    * *Governance:* Security, Identity, Settings, Workflows
    * *Resources:* Documentation, API Reference (`/api-docs`)
  - Chân trang / Header: Hiển thị đúng nhãn role người dùng, session tenant, và nút Đăng xuất.
  - **Lỗi UI cần bắt:**
    * Vỡ layout khi thu nhỏ màn hình (Responsive test ở 390px, 768px, 1440px).
    * Active state của menu item không sáng khi chuyển route.
    * Menu bị nhảy giật khi bấm collapse/expand sidebar.

---

### 2. Màn hình Tổng quan (Overview Screen)
- **Đường dẫn:** `/admin/web/overview`
- **Mục tiêu test:**
  - Thẻ thông tin Session: Hiển thị Tenant ID, Session Expiry, CSRF status.
  - Thẻ Metrics / Trạng thái hệ thống: Database (Healthy), Redis/Queue (Healthy), Worker Status.
  - Bảng Nhật ký Kiểm toán gần đây (Audit Ledger Table): Hiển thị danh sách hành vi quản trị (Action, Principal, Status, Timestamp).
- **Lỗi UI cần bắt:**
  - Cột thời gian bị mất format (hiển thị raw epoch hoặc `NaN-NaN-NaN`).
  - Tràn text (overflow) khi Tenant ID hoặc UUID quá dài.
  - Nút phân trang (Pagination) hoặc lọc audit bị lệch dòng.

---

### 3. Màn hình Khóa API (API Keys Screen)
- **Đường dẫn:** `/admin/web/api-keys`
- **Mục tiêu test:**
  - Bảng danh sách API Key: Key name, Prefix (`du_live_...`), Tenant ID, Created At, Status (`ACTIVE` / `REVOKED`).
  - Form Tạo mới API Key (Issue API Key):
    * Nhập Tenant ID hợp lệ → Bấm **Issue Key**.
    * Modal hiển thị Key 1 lần duy nhất (Copy-once banner): Nút "Copy Key" hoạt động và chuyển icon sang "Copied!".
  - Thu hồi Key (Revoke):
    * Bấm Revoke → Hiển thị Confirm Dialog cảnh báo.
    * Xác nhận → Key chuyển sang badge đỏ `REVOKED`, nút Revoke bị vô hiệu hóa.
- **Lỗi UI cần bắt:**
  - Input field thiếu validation (để trống tenant vẫn bấm được nút tạo).
  - Không che mờ (mask) secret key; hoặc copy không hoạt động trên clipboard trình duyệt.
  - Nút Revoke không hiển thị trạng thái `Loading...` khi đang chờ backend xử lý.

---

### 4. Màn hình Quản lý Connector (Connectors Screen)
- **Đường dẫn:** `/admin/web/connectors`
- **Mục tiêu test:**
  - Danh sách Connector Revisions: Adapter (`json-http`, `multipart-http`), State (`ACTIVE`, `DRAFT`, `DISABLED`).
  - Xem chi tiết Revision: Provider URL, Authentication Config, Capabilities (Test / Management / Invocation).
  - Thử nghiệm kết nối (Test Credential / Probe): Bấm "Test Connector" kiểm tra phản hồi thành công/thất bại.
- **Lỗi UI cần bắt:**
  - Lộ credentials (API Token của provider) ra thẻ hiển thị dạng plaintext thay vì masked `••••••••`.
  - JSON Schema editor / Config viewer bị vỡ khung khi payload JSON lớn.

---

### 5. Màn hình Cấu hình Profile (Profiles Screen)
- **Đường dẫn:** `/admin/web/profiles`
- **Mục tiêu test:**
  - Danh sách Business Profiles (ví dụ: `extraction-default`, `classification-fast`).
  - Liên kết slot (`reasoning`, `ocr`, `vision`) với Connector Revision tương ứng.
  - Đổi phiên bản active của Profile và lưu cấu hình.
- **Lỗi UI cần bắt:**
  - Dropdown chọn Connector Revision không hiển thị đúng tên revision hoặc bị che khuất dưới bảng.
  - Không có cảnh báo khi Profile chưa bind connector cho slot bắt buộc.

---

### 6. Màn hình Theo dõi Tác vụ (Operations Screen)
- **Đường dẫn:** `/admin/web/operations`
- **Mục tiêu test:**
  - Bảng danh sách Operations: Operation ID, Action (`ingest`, `extract`), State (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`).
  - Xem chi tiết Operation: Danh sách các Checkpoints (Step Name, Completed At), Artifact Output Link.
- **Lỗi UI cần bắt:**
  - Thiếu Badge màu trực quan cho trạng thái (`SUCCEEDED` = xanh lá, `FAILED` = đỏ, `RUNNING` = xanh dương có hiệu ứng xoay).
  - Link tải Artifact bấm vào không phản hồi hoặc không hiển thị thông báo lỗi khi artifact đã hết hạn.

---

### 7. Màn hình Quản lý Business Workers (Businesses Screen)
- **Đường dẫn:** `/admin/web/businesses`
- **Mục tiêu test:**
  - Danh sách Worker đã đăng ký: `document-core`, `lc-checker`, `example-review`.
  - Hiển thị Version đang kích hoạt (Active Version: `1.0.0`), Trạng thái (`ENABLED`, `ACTIVATED`).
  - Các nút hành động vòng đời: *Enable*, *Drain*, *Retire*.
- **Lỗi UI cần bắt:**
  - Bấm hành động không có thông báo Toast/Alert xác nhận trạng thái thành công.
  - Nút bị bấm liên tục nhiều lần (Double click) gây lỗi race condition trên backend.

---

### 8. Màn hình Cài đặt Hệ thống (Settings Screen)
- **Đường dẫn:** `/admin/web/settings`
- **Mục tiêu test:**
  - Danh mục 17 cấu hình hệ thống:
    * Port/Host Orchestrator Backend (`3000`/`3002`)
    * Port Orchestrator Portal (`3001`)
    * Encryption Key status, Storage Adapter (Postgres/S3), Auth Mode.
  - Phân định rõ các cấu hình: Có nhãn `managedBy: deployment compose` hoặc `effective: boot-time` để tránh người dùng hiểu lầm là sửa trực tiếp được trên UI.
- **Lỗi UI cần bắt:**
  - Màu sắc chữ quá mờ, độ tương phản kém (Contrast ratio < 4.5:1).
  - Thiếu tooltip giải thích ý nghĩa các biến môi trường.

---

### 9. Màn hình Tài liệu Swagger UI / API Reference (Api Docs Screen)
- **Đường dẫn:** `/admin/web/api-docs`
- **Mục tiêu test:**
  - Nạp đầy đủ 57 endpoint operations và 14 schemas từ artifact `docs/21-openapi.json`.
  - Bộ lọc Family hoạt động: Bấm *Public* (12 ops), *Admin* (10 ops), *Runtime* (18 ops), *Connector* (17 ops).
  - Ô tìm kiếm: Gõ `"ingest"` hoặc `"claim"` lọc đúng danh sách operation.
  - Xem chi tiết từng Endpoint: Hiển thị Method tag màu chuẩn (GET=xanh dương, POST=xanh lá, PUT=cam, DELETE=đỏ), Origin server tương ứng (3000/3002/8080), Request Body và Response Schema.
  - Xác nhận nút "Try it out" bị ẩn hoàn toàn để bảo vệ credential.
- **Lỗi UI cần bắt:**
  - Bảng tham số (Parameters Table) bị tràn chiều rộng trên màn hình nhỏ.
  - Khối mã JSON (Code Block) không có nút Copy hoặc format thụt đầu dòng bị lỗi.

---

### 10. Màn hình 404 & Xử lý Ngoại lệ (Not Found & Error Boundary)
- **Đường dẫn:** `/admin/web/some-random-unknown-path`
- **Mục tiêu test:**
  - Render màn hình Not Found chuyên nghiệp: Tiêu đề "Admin — 404", mô tả lỗi lịch sự và nút bấm "Return to Admin home".
  - Thử nghiệm tắt backend BFF: Khi gọi API trả 500 hoặc rớt mạng, trang hiển thị `ErrorState` có nút "Retry / Thử lại", không văng màn hình trắng (White Screen of Death).
- **Lỗi UI cần bắt:**
  - React error crash bung cả stack trace ra màn hình người dùng.
  - Nút "Return home" trỏ sai đường dẫn hoặc bị redirect lặp vô tận.

---

## III. TỔ CHỨC FILE KIỂM THỬ TỰ ĐỘNG & BƯỚC THỰC THI (PLAYWRIGHT)

Kịch bản được tích hợp dưới dạng file Playwright spec:
- **File kịch bản:** `du-rework/tests/browser/tests/orchestrator-portal-e2e.spec.ts`
- **Tập lệnh chạy kiểm thử:**
  ```powershell
  cd du-rework/tests/browser
  npx playwright test tests/orchestrator-portal-e2e.spec.ts --project=desktop
  npx playwright test tests/orchestrator-portal-e2e.spec.ts --project=mobile
  ```
- **Tiêu chuẩn nghiệm thu báo cáo:**
  1. Kết quả chạy đạt **100% PASS** trên tất cả các route.
  2. Báo cáo Axe Core đạt **0 Critical / 0 Serious Accessibility Violations**.
  3. Xuất file tổng kết JSON và bộ ảnh chụp màn hình đầy đủ (Screenshots) của tất cả các màn hình vào thư mục `tests/browser/artifacts/`.
