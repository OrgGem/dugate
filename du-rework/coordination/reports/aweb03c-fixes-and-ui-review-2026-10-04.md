# Receipt — AWEB-03c Component fixes & UI review verdict (2026-10-04 12:31 +07)

- **Task ID**: `task_6c65614dcf31`
- **Context ID**: `ctx_aweb03c_fixes_ui_review`
- **Lane**: `antigravity_1` (term `term_38afaa0e-081f-4e32-91b2-25459d048b0e`)
- **Spec**: `du-rework/coordination/dispatch-specs/2026-10-04-1222-AWEB03c-fixes-ui-review.md`
- **Plan reference**: `du-rework/tasks/ADMIN-WEB-DELIVERY-2026-10-04.md` §3 (AWEB-03)
- **Contract reference**: `du-rework/docs/admin-ui-development-contract.md` §2, §3, §5

---

## 1. Phần 1 — Sửa Findings từ Review của Integrator (F1–F6)

Toàn bộ 6 findings từ `coordination/reports/aweb03b-overview-graft-2026-10-04.md` §1 đã được xử lý triệt để trong write-set được cấp (`components/ui/**`, `styles/**`, `app-shell/**`):

| # | Mức | Finding gốc | Giải pháp đã áp dụng & Vị trí sửa |
|---|---|---|---|
| **F1** | minor | `button.tsx:47` primary dùng hardcoded `text-white` thay vì token | Đã thêm token `--on-action: #ffffff;` vào `:root` và dark blocks của `src/styles/tokens.css`. Cập nhật `button.tsx` sử dụng `text-[var(--on-action)]`. |
| **F2** | minor | `table.tsx:10` TableContainer dùng `shadow-xs` thay vì `--shadow-card` | Đã cập nhật `TableContainer` trong `src/components/ui/table.tsx` sử dụng `shadow-[var(--shadow-card)]` đồng bộ với `card.tsx`. |
| **F3** | minor a11y | `field.tsx:113-121` FormField chưa tự động gắn `aria-describedby` / `aria-errormessage` vào child input | Đã triển khai `React.cloneElement` trong `FormField` (`src/components/ui/field.tsx`) để tự động truyền `id`, `aria-describedby` (kết hợp descriptionId + errorId), `aria-errormessage`, và `aria-invalid` vào child input. Cập nhật tài liệu trong `README.md`. |
| **F4** | minor | `index.ts` barrel export cả `./demo` và `./fixtures`, kéo phình bundle | Đã xóa 2 dòng export `./demo` và `./fixtures` khỏi `src/components/ui/index.ts`. Production barrel chỉ export production UI primitives. Demo & fixtures giữ nguyên ở subpath `@/components/ui/demo` và `@/components/ui/fixtures`. Bundle size JS duy trì mức tối ưu: 304.14 kB (gzip 100.88 kB). |
| **F5** | info | `state-panel.tsx:95-98` `ErrorState` render `error.message` nếu caller truyền `Error` | Đã ghi rõ quy ước trong `src/components/ui/README.md` (mục 10): Callers bắt buộc truyền error message đã được sanitized/bounded hoặc mã chuẩn `problem.code`, không truyền raw stack traces nội bộ. |
| **F6** | info | `app-shell.tsx:12` NAV chỉ có nhãn "Bootstrap" và footer ghi "AWEB-01" | Đã cập nhật `NAV` trong `src/app-shell/app-shell.tsx` gồm cả `{ label: 'Overview', href: '/overview' }` và `{ label: 'Bootstrap', href: '/' }` (bảo toàn tương thích test). Cập nhật footer thành "Admin Web (AWEB-03)". |

---

## 2. Phần 2 — UI Review Packet & Verdict (Contract §5)

### 2.1. Đối tượng và Thông số Build Review
- **Git HEAD**: `b088eececcb5f3df0b4edbe073a29401dafda624`
- **Package**: `@du/admin-web@0.0.0`
- **Build Hash/Assets**:
  - CSS: `dist/assets/index-BdwAIkBX.css` (39.60 kB, gzip 7.88 kB)
  - JS: `dist/assets/index-C86-GURc.js` (304.14 kB, gzip 100.88 kB)
  - HTML: `dist/index.html` (0.47 kB)
- **Harness & Server Seam**:
  - `createAdminShellServer` từ mã nguồn với mount `/admin/web` và `/admin/web/overview`.
  - In-memory OIDC session store (`operator` tenant UUID và `viewer`).
  - Scripted upstream stub `/api/v1/admin/audit` với scenario control (`rows`, `empty`, `error`).

### 2.2. Chi tiết Đánh giá từng Màn hình

#### Route A: `/admin/web` (Bootstrap Home / Entry Route)
- **Screen Spec & Routing**: Đáp ứng đúng vai trò root view của Admin Web React.
- **Bảo mật & Session Gate**:
  - Khi chưa đăng nhập (unauthenticated) $\rightarrow$ 302 redirect chính xác về `/admin/login`.
  - Sau khi đăng nhập $\rightarrow$ Giao diện React render hoàn chỉnh, nhận diện đúng session cookie, reload trang giữ nguyên session.
- **A11y & Focus**: Tab key di chuyển tuần tự qua các interactive links với vòng focus rõ ràng (`--focus-ring`).
- **Responsive 320px**: Không có tràn ngang (`scrollWidth <= clientWidth + 1`), thanh điều hướng tự co giãn hợp lý.
- **Theme**: Light mode và Dark mode (`data-theme="dark"`) phân tách thị giác rõ ràng, tuân thủ token màu nền, viền và chữ.
- **Verdict**: **`UI_APPROVED`**

#### Route B: `/admin/web/overview` (Overview Dashboard)
- **Screen Spec & Role/Tenant Matrix (`ACUI-M07`)**:
  - **Operator Session**: Đọc dữ liệu audit ledger thật được fence theo đúng tenant ID của phiên (`11111111-1111-4111-8111-111111111111`). Header upstream stub nhận đúng tenant credential, không mượn platform bearer.
  - **Viewer Session**: Hiển thị trạng thái `DeniedState` (403 Forbidden), upstream audit stub ghi nhận **0 request** (bằng chứng âm - không bị leak dữ liệu xuyên quyền).
  - **SPA-level 401**: Khi phiên hết hạn giữa chừng, hiển thị `ErrorState` kèm liên kết "Sign in again" rõ ràng.
- **Các Trạng thái Màn hình (States Compliance)**:
  - `ready`: Render Session Card + Bảng Audit Events + Badges trạng thái + 2 tile trạng thái.
  - `empty`: Khi tenant chưa có dữ liệu audit, chuyển sang `EmptyState` với nút "Refresh" để tải lại.
  - `error`: Khi upstream lỗi 502/500, hiển thị `ErrorState` kèm nút "Try again" và phục hồi thành công khi upstream sống lại.
- **Tính Trung thực (Honest Capability Reporting)**:
  - Hai tile *Usage rollup* và *Operations* được gắn badge **`requires backend`** màu vàng rõ ràng, giải thích cụ thể rằng tính năng này đang chờ endpoint backend và không hiển thị số liệu giả lập/mock.
- **Responsive 320px**: Bảng audit được bọc trong `TableContainer` cuộn ngang độc lập, layout trang không bị tràn ngang ở 320px width.
- **Verdict**: **`UI_APPROVED`**

---

## 3. Bằng chứng Kiểm thử Thực tế (Literal Commands & Evidence)

### 3.1. Build & Typecheck
```bash
# Typecheck admin-web
cwd: D:\Git\dugate\du-rework
command: pnpm --filter @du/admin-web typecheck
exit_code: 0

# Production build admin-web
cwd: D:\Git\dugate\du-rework
command: pnpm --filter @du/admin-web build
exit_code: 0
output:
  ✓ 2636 modules transformed.
  dist/assets/index-BdwAIkBX.css   39.60 kB │ gzip:   7.88 kB
  dist/assets/index-C86-GURc.js   304.14 kB │ gzip: 100.88 kB
  ✓ built in 20.44s

# Typecheck orchestrator
cwd: D:\Git\dugate\du-rework
command: pnpm --filter @du/orchestrator typecheck
exit_code: 0
```

### 3.2. Playwright Browser Test Suite
```bash
cwd: D:\Git\dugate\du-rework\tests\browser
command: npx playwright test --config admin-web/playwright.config.ts
exit_code: 0
output:
Running 13 tests using 1 worker

  ok  1 admin-web\admin-web.spec.ts:52:7 › 1. direct unauth /admin/web -> 302 login; login form renders (963ms)
  ok  2 admin-web\admin-web.spec.ts:67:7 › 2. login -> React app renders; no serious console errors (996ms)
  ok  3 admin-web\admin-web.spec.ts:80:7 › 3. reload keeps the session and re-renders the app (1.5s)
  ok  4 admin-web\admin-web.spec.ts:89:7 › 4. 320px viewport: no horizontal overflow; nav reachable (1.3s)
  ok  5 admin-web\admin-web.spec.ts:103:7 › 5. keyboard: Tab reaches a control with a visible focus ring (1.4s)
  ok  6 admin-web\admin-web.spec.ts:126:7 › 6. theme: light + data-theme=dark render distinctly (1.3s)
  ok  7 admin-web\overview.spec.ts:62:7 › 0. unauth direct /admin/web/overview → login (mount gate) (294ms)
  ok  8 admin-web\overview.spec.ts:69:7 › 1. operator tenant → ready: tenant-fenced rows + honest tiles (1.3s)
  ok  9 admin-web\overview.spec.ts:92:7 › 2. empty scope → EmptyState with refresh affordance (935ms)
  ok 10 admin-web\overview.spec.ts:101:7 › 3. upstream failure → 502 error, retry succeeds after recovery (1.0s)
  ok 11 admin-web\overview.spec.ts:115:7 › 4. viewer session → denied, upstream untouched (980ms)
  ok 12 admin-web\overview.spec.ts:127:7 › 5. SPA-level 401 → sign-in link (session expired mid-flight) (1.0s)
  ok 13 admin-web\overview.spec.ts:147:7 › 6. 320px viewport: no horizontal overflow on Overview (778ms)

  13 passed (15.5s)
```

### 3.3. BFF Hygiene & Regression Suite
```bash
cwd: D:\Git\dugate\du-rework\services\orchestrator
command: jest --runInBand tests/aweb02-bff-foundation.test.ts
exit_code: 0
output:
  26 passed, 26 total (quét static bundle hygiene, token leakage guard, tenant isolation)
```

### 3.4. Screenshots Evidence
15 ảnh chụp thực tế đã được làm mới tại `du-rework/coordination/evidence/aweb03b/`:
- `01-unauth-login.png` — mount gate 302 login
- `02-login-rendered.png` — React app bootstrap ready
- `03-reload.png` — reload session persistence
- `04-320px-reflow.png` — mobile viewport reflow
- `05-keyboard-focus.png` — tab focus outline visible
- `06-theme-light.png` / `07-theme-dark.png` — light/dark palette consistency
- `overview-00-unauth-login.png` — overview mount gate unauth
- `overview-01-ready.png` — session card, audit rows, honest tiles
- `overview-02-empty.png` — empty state with refresh
- `overview-03-error.png` / `overview-04-error-retried.png` — 502 error and recovery
- `overview-05-denied.png` — 403 viewer boundary
- `overview-06-session-401.png` — mid-flight SPA 401 sign-in affordance
- `overview-07-320px.png` — overview table horizontal scrolling on 320px

---

## 4. Tổng kết & Kết luận

1. **Findings F1–F6**: Đã đóng 100% (Token compliance, Table shadow, FormField a11y auto-wiring, Production barrel pruning, ErrorState convention, Overview nav link).
2. **Review Verdict**: **`UI_APPROVED`** cho cả 2 route `/admin/web` và `/admin/web/overview` trên build `index-C86-GURc.js` / `index-BdwAIkBX.css`.
3. **Tuân thủ Ranh giới**:
   - Không sửa `src/lib/api/**`, `src/routes/**`, `src/features/**`, Orchestrator backend, `tasks/**`, `docs/**`.
   - Không commit code, không can thiệp hạ tầng container của user.
   - Sẵn sàng bàn giao cho slice tiếp theo (`AWEB-04` Profile vertical slice).
