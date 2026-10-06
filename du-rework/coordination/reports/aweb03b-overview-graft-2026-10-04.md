# AWEB-03b — Overview graft + component diff review (2026-10-04)

**Packet:** aweb03b-overview-graft · **Lane:** cc_1 (Admin UI integrator) · **Dispatch:** 2026-10-04T12:05+07:00.
**Trạng thái:** DONE. Backend **zero-diff** trong packet này (`shell-server.ts` mtime 11:49 = từ AWEB-02; không sửa). Không commit, không tick. Không sửa file Antigravity (`components/ui/**`, `styles/**`, `app-shell/**`).

## 1. Review độc lập diff components Antigravity (không tự sửa — lease)

Đã đọc 15 file `apps/admin-web/src/components/ui/**` + receipt `aweb03a-components-2026-10-04.md`. Kiểm bằng chứng máy:

- **Zero-fetch/cookie/role**: grep `fetch(|document.cookie|localStorage|role ===` trên `components/ui` → 0 hit (ngoài prop `tenantId` hiển thị của `DeniedState` — đúng thiết kế, là prop thuần).
- **Token-clean**: grep hex `#rrggbb` trong `components/ui/*.tsx` → **0 hit**; mọi màu đi qua `var(--*)`.
- **Deps**: chỉ `@base-ui/react`, `lucide-react`, `cn`, `@/lib/utils` — không dep mới nào ngoài danh sách đã chốt.
- **A11y**: Dialog focus-trap/Escape/restore qua Base UI + `aria-label="Close dialog"`; Tabs roving tabindex/data-selected; Button `aria-busy`; Input `aria-invalid`; Badge dot/icon `aria-hidden`.

**Findings (không tự sửa, đề xuất gửi Antigravity/coordinator):**

| # | Mức | Finding (file:line) | Đề xuất |
|---|---|---|---|
| F1 | minor | `button.tsx:47` primary dùng `text-white` hardcode thay vì token (app.css đã có `--primary-foreground: #ffffff`) | thêm token `--on-action`/dùng `--primary-foreground` |
| F2 | minor | `table.tsx:10` TableContainer dùng `shadow-xs` (Tailwind mặc định) trong khi `card.tsx:9` dùng `shadow-[var(--shadow-card)]` | thống nhất về `--shadow-card` |
| F3 | minor (a11y) | `field.tsx:113-121` `FormField` sinh `descriptionId`/`errorId` nhưng **không tự gắn** `aria-describedby`/`aria-errormessage` vào input con; README (`components/ui/README.md` mục 3) claim “Automatically generates linked IDs” | hoặc wire qua cloneElement/context, hoặc sửa README để callers tự truyền `aria-describedby` |
| F4 | minor | `index.ts` barrel export cả `./demo` + `./fixtures`; import barrel kéo toàn bộ Base UI/demo vào bundle | **đã đo**: đổi sang subpath import giảm JS **411.099 → 304.083 bytes** (gzip 137.50 → 100.87 kB). Đề xuất tách barrel production vs demo (hoặc bỏ demo/fixtures khỏi barrel) |
| F5 | info | `state-panel.tsx:95-98` `ErrorState` render `error.message` nguyên văn nếu caller truyền `Error` | quy ước callers chỉ truyền code/đã-bounded (Overview tuân thủ: chỉ truyền `problem.code`) |
| F6 | info | `app-shell.tsx:12` NAV còn nhãn `Bootstrap` + footer “Admin Web bootstrap (AWEB-01)” — lệch ngữ nghĩa sau khi có Overview | Antigravity cập nhật nhãn/nav (lease của họ); integrator thêm link Overview trong màn index (thuộc lease) |

Không finding nào blocking. Demo/fixtures fixture strings không lọt vào bundle (`grep tenant-enterprise-beta|ComponentDemo` trong `dist/assets/*.js` = 0).

## 2. Ghép Overview read-only

- Route mới `/admin/web/overview` (`src/router.tsx:27`, `src/routes/overview.tsx`) + link từ màn bootstrap (`src/routes/bootstrap-home.tsx:52-56`); `/` giữ nguyên để không phá evidence AWEB-01b.
- Feature `src/features/overview/`:
  - `overview-screen.tsx` — Session card (từ `/admin/api/session`), **Audit ledger thật theo tenant** (từ `/admin/api/audit`, BFF tự ép tenant theo session), 2 tile Usage/Operations gắn badge **`requires backend`** + ghi rõ “no placeholder data”.
  - `state.ts` — parse runtime cho audit page (unknown→typed, bỏ row thiếu trường) + `paneStateFrom` (403→denied, còn lại→error) + map severity→badge.
- Đủ state: `loading` (LoadingState) / `ready` (Table) / `empty` (EmptyState + Refresh) / `error` (ErrorState + Try again + link khi 401) / `denied` (DeniedState); 401 SPA-level → link “Sign in again”.
- Subpath imports (badge/card/state-panel/table/app-shell-primitives) — không đụng barrel của Antigravity.

## 3. Browser evidence (harness `tests/browser/admin-web/**`, mở rộng)

- `harness.ts` (mở rộng, giữ tương thích AWEB-01b): stub upstream `/api/v1/admin/audit` có điều khiển scenario (`/__stub/mode?scenario=rows|empty|error`) + log request (`/__stub/requests`, chỉ path/tenantId/authHeaderPresent — **không log token**); session store in-memory (operator tenant uuid + viewer); `tenantAdminTokens` map tenant→credential.
- `overview.spec.ts` (mới): 0) unauth → login; 1) operator ready (rows + tenant uuid + bảng + tiles); 2) empty; 3) error 502 + retry thành công; 4) viewer → denied, **upstream untouched** (đếm request trước/sau bằng chứng âm); 5) 401 SPA-level qua route interception → link sign-in; 6) 320px không tràn ngang.
- Literal run (final bundle):
```
Running 13 tests using 1 worker
  ok  1 … admin-web.spec.ts … 1. direct unauth /admin/web -> 302 login
  ok  2 … 2. login -> React app renders; no serious console errors
  ok  3 … 3. reload keeps the session and re-renders the app
  ok  4 … 4. 320px viewport: no horizontal overflow; nav reachable
  ok  5 … 5. keyboard: Tab reaches a control with a visible focus ring
  ok  6 … 6. theme: light + data-theme=dark render distinctly
  ok  7 … overview.spec.ts … 0. unauth direct /admin/web/overview → login (mount gate)
  ok  8 … 1. operator tenant → ready: tenant-fenced rows + honest tiles
  ok  9 … 2. empty scope → EmptyState with refresh affordance
  ok 10 … 3. upstream failure → 502 error, retry succeeds after recovery
  ok 11 … 4. viewer session → denied, upstream untouched
  ok 12 … 5. SPA-level 401 → sign-in link (session expired mid-flight)
  ok 13 … 6. 320px viewport: no horizontal overflow on Overview
  13 passed (15.9s)
```
  (chạy 2 lần: 13/13 trước và sau tối ưu subpath imports; screenshots đều refresh.)
- Screenshots: `coordination/evidence/aweb03b/` — 15 ảnh (`overview-00..07-*.png` + 6 ảnh AWEB-01b cũ). Ảnh `overview-01-ready.png` đã xem trực tiếp: Session card (principal/role/tenant) + audit table 2 dòng + severity badges + 2 tile “requires backend”.

## 4. Build / typecheck / regression (literal)

```
pnpm --filter @du/admin-web build   → BUILD_EXIT=0
  ✓ 2636 modules transformed.
  dist/assets/index-C4nk74u6.css  39.49 kB │ gzip:  7.86 kB
  dist/assets/index-wz0eDwNj.js  304.08 kB │ gzip: 100.87 kB   (trước tối ưu: 411.10 kB │ 137.50 kB)

pnpm exec jest --runInBand tests/aweb02-bff-foundation.test.ts   → 26 passed, 26 total (bundle hygiene quét bundle mới)
pnpm --filter @du/orchestrator typecheck                          → TSC_EXIT=0
```
Không chạy lại shell suites vì packet này **không sửa backend** (shell-server mtime 11:49, markers AWEB-01/02 còn nguyên — kiểm bằng grep lần cuối).

## 5. File đã chạm

| File | Thay đổi |
|---|---|
| `apps/admin-web/src/features/overview/overview-screen.tsx` (mới) | màn Overview |
| `apps/admin-web/src/features/overview/state.ts` (mới) | parse + pane-state + severity map |
| `apps/admin-web/src/routes/overview.tsx` (mới) | route thin |
| `apps/admin-web/src/router.tsx` | +route `/overview` |
| `apps/admin-web/src/routes/bootstrap-home.tsx` | +link Overview |
| `tests/browser/admin-web/harness.ts` | stub upstream + sessions store + outfile fields (giữ tương thích env AWEB01B_*) |
| `tests/browser/admin-web/overview.spec.ts` (mới) | 7 case |
| `coordination/evidence/aweb03b/**` | 15 screenshot |

**Không chạm:** `components/ui/**`, `styles/**`, `app-shell/**` (Antigravity); `server.ts`; `packages/contracts/**`; `tasks/**`, `docs/**`. Ghi nhận tree có nhiều thay đổi lane khác (`server.ts`, `modules/**`, `api-key-section-*`) — không phải của tôi, không chặn.

## 6. Gaps / open items

- Nav/footer còn nhãn “Bootstrap” (F6) — chờ packet Antigravity; hiện Overview vào bằng link ở màn index hoặc URL trực tiếp.
- Usage/Operations tiles chờ backend thật (đúng thiết kế “requires backend”, không dữ liệu giả).
- 401 asset-level chỉ có thể chứng minh bằng mount gate (302) — case SPA-level 401 đã dùng route interception một cách trung thực.
- Retry của Session card hiện `window.location.reload()` (đủ cho lỗi transport hiếm); có thể thay bằng refetch khi có nhu cầu.

## Verdict

**ACCEPTED ở tầng harness browser + build**: 13/13 Playwright (gồm 7 case Overview + 6 case AWEB-01b cũ), aweb02 26/26, typecheck/build 0, review component có 4 finding minor + 2 info (không tự sửa, báo coordinator), bundle tối ưu −107 kB. Backend zero-diff. Ảnh bằng chứng đủ 401/403/320px + ready/empty/error-retry.
