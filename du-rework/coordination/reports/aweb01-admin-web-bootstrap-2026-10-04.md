# AWEB-01 — Admin Web bootstrap (React + Vite + shadcn Base UI + mount sau session gate)

**Packet:** aweb01-admin-web-bootstrap · **Lane:** cc_1 (Admin UI integrator) · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T11:15+07:00.
**Trạng thái:** DONE (bootstrap + mount + verify). Không commit, không tick, không restart container của user. `server.ts`, `shell-router.ts`, `main.ts` **không bị sửa dòng nào** — xem §4.

## 1. Cấu trúc app mới (`du-rework/apps/admin-web`)

```
apps/admin-web/
  package.json            @du/admin-web (private, type: module)
  vite.config.ts          base '/admin/web/', react + @tailwindcss/vite
  tsconfig.json           TS strict (noUncheckedIndexedAccess, noUnused*, strict true)
  postcss.config.mjs      pipeline RỖNG — chặn kế thừa postcss.config.mjs của legacy app (Tailwind v3)
  components.json         shadcn config: style "base-nova" (Base UI + preset nova), cssVariables
  index.html
  src/main.tsx            entry: import '@/styles/app.css' + RouterProvider
  src/router.tsx          React Router Data Mode (createBrowserRouter + loader, basename từ BASE_URL)
  src/app-shell/app-shell.tsx      shell tối thiểu: header/nav/nội dung/footer — không auth/tenant logic
  src/routes/bootstrap-home.tsx    route thử read-only (loader data, không gọi API)
  src/routes/not-found.tsx
  src/lib/utils.ts        cn (re-export từ package `cn` do shadcn CLI chọn)
  src/styles/tokens.css   NGUỒN TOKEN DUY NHẤT — mirror `shell-render.ts:500,503-504`
  src/styles/app.css      Tailwind v4 entry + @theme inline + map shadcn semantic vars → cf-* (1 palette)
  src/components/ui/README.md      skeleton dir — primitives thuộc AWEB-03 (Antigravity)
  .gitignore              node_modules/ dist/ (*.tsbuildinfo)
  README.md               commands + quyết định + cách serve
```

`git add --dry-run` xác nhận 17 file sẽ được tracked; `node_modules/` + `dist/` bị ignore (`git check-ignore` 2/2).

## 2. Commands + literal output

### 2.1 Workspace + install

- `pnpm-workspace.yaml`: thêm `- 'apps/*'` (dòng 6).
- `pnpm install --filter @du/admin-web...` → `Done in 58.9s using pnpm v10.18.3` (42 package mới).
- Sau khi dọn dep thừa: `pnpm install --filter @du/admin-web` → `Done in 16.7s` (exit 0). `pnpm-lock.yaml` importer mới tại `apps/admin-web:` (lockfile dòng 15).

### 2.2 shadcn CLI (đã review diff)

```
pnpm dlx shadcn@latest init -t vite -b base -p nova -y -f --no-monorepo --no-reinstall
✔ Preflight checks. / Verifying framework. Found Vite. / Validating Tailwind CSS. Found v4.
✔ Validating import alias. / Writing components.json. / Checking registry. / Installing dependencies.
✔ Created 1 file: src\components\ui\button.tsx
ℹ Updated 1 file: src\lib\utils.ts
✔ Updating src\styles\app.css
```
Review diff (đã merge, KHÔNG dùng nguyên trạng):
- **Gỡ** `src/components/ui/button.tsx` (primitive do CLI sinh — lease primitives thuộc AWEB-03); giữ dir + README skeleton.
- **Gỡ Geist**: `@fontsource-variable/geist` + `@import` + `--font-sans 'Geist Variable'` → **Inter** (Q3).
- **Gộp palette**: block oklch `:root/.dark` của CLI bị thay bằng map shadcn semantic (`--background`, `--primary`, `--ring`, …) → `--cf-*` trong `tokens.css`; `--radius` → `--radius-md`; bỏ self-reference `--radius-sm/md`/`--shadow-card/pop` trong `@theme` (tránh vòng var); dark tự động qua `prefers-color-scheme` của tokens.css (Q4: media-query).
- **Deps**: `shadcn` chuyển sang devDependencies (chỉ dùng `shadcn/tailwind.css` lúc build); xóa `clsx`/`tailwind-merge` (không còn dùng — `cn` package thay thế). Giữ `@base-ui/react`, `class-variance-authority`, `lucide-react`, `tw-animate-css`, `cn` — provenance đã kiểm: `cn` = `github.com/shadcn-ui/cn` (MIT), `@base-ui/react` = `github.com/mui/base-ui`, `shadcn` = `github.com/shadcn-ui/ui`.
- **Fix build**: Vite kế thừa `D:/Git/dugate/postcss.config.mjs` (Tailwind v3 legacy) → thêm `postcss.config.mjs` rỗng trong app; lỗi `@layer base ... no matching @tailwind base` biến mất.

### 2.3 Typecheck + build (apps/admin-web)

```
> tsc --noEmit -p tsconfig.json
TYPECHECK_EXIT=0

> tsc --noEmit -p tsconfig.json && vite build
vite v6.4.3 building for production...
✓ 39 modules transformed.
dist/index.html                0.47 kB │ gzip:  0.29 kB
dist/assets/index-CFISdnBo.css 14.29 kB │ gzip:  4.00 kB
dist/assets/index-Dt_kkQaI.js  240.26 kB │ gzip: 79.14 kB
✓ built in 7.14s
BUILD_EXIT=0
```
Assets content-hashed → phục vụ immutable. (Lần build đầu thiếu CSS vì entry chưa import `app.css` — đã sửa `src/main.tsx:5`, build lại xanh.)

### 2.4 Mount verification (script thật, HTTP port 0) — 20/20 PASS

Script tạm (đã xóa sau khi chạy): `.cache/aweb01-mount-check.ts`, chạy bằng `tsx`, gọi `createAdminShellServer` từ source. Output literal:

```
PASS  1. flag-off /admin/web -> 404 (route absent)  [status=404]
PASS  2. flag-off /admin/login -> 200 legacy form  [status=200]
PASS  3. unauth /admin/web -> 302 /admin/login no-store  [status=302 loc=/admin/login cc=no-store]
PASS  4. POST /admin/login -> 302 + du_admin cookie  [status=302 cookie=du_admin=eyJpc…]
PASS  5. authed /admin/web -> 200 index html  [status=200 bytes=471]
PASS  6. index cache-control no-store  [cc=no-store]
PASS  7. index CSP strict  [default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self']
PASS  8. correlation header on mount responses  [id=88f8e382-…]
PASS  9. index references hashed asset  [/admin/web/assets/index-Dt_kkQaI.js]
PASS  10. asset -> 200 immutable cache  [status=200 cc=public, max-age=31536000, immutable]
PASS  11. asset content-type  [ct=text/javascript; charset=utf-8]
PASS  12. missing asset -> 404 (never SPA html)  [status=404]
PASS  13. deep link -> SPA fallback 200 index  [status=200]
PASS  14. raw encoded traversal -> 404  [status=404 head="HTTP/1.1 404 Not Found"]
PASS  15. backslash traversal -> 404  [status=404]
PASS  16. HEAD /admin/web -> 200  [status=200]
PASS  17. POST /admin/web -> 405  [status=405]
PASS  18. legacy /admin still renders shell (flag on)  [status=200]
PASS  19. env DU_ADMIN_WEB=1 -> route exists (302 gate)  [status=302]
PASS  20. bundle missing -> 503 fixed message  [status=503]
SUMMARY 20/20 PASS
```
Check 14/15 dùng **raw socket** (không qua fetch) để tránh client tự normalize `%2e%2e`; cookie phải mint hợp lệ → chứng minh direct URL/reload/login/logout ở tầng server.

### 2.5 Regression trên shell suites (pre-existing có đối chứng baseline)

Chạy `NODE_ENV=test` (ambient `NODE_ENV=production` làm cookie posture enforce — đúng thiết kế):

| Batch | Mine | Baseline (HEAD `shell-server.ts`, swap tạm rồi phục hồi, hash khớp) |
|---|---|---|
| `admin-shell-{server,router,render,fixtures}` + `auth` | **23 failed** / 148 passed (4 suite fail + auth PASS) | **23 failed** / 119 passed — *cùng 4 suite, cùng 23 test* |
| `admin-shell-{platform-mount,session-lifecycle,oidc-mount}` | **3 failed** / 91 passed (2 suite fail) | **3 failed** / 91 passed — *cùng 2 suite, cùng tên test* |

→ Toàn bộ fail là **pre-existing** (ambient/loopback, đã ghi nhận từ CONV-02/03); thay đổi AWEB-01 **0 regression**. Orchestrator `tsc --noEmit -p tsconfig.json` = 0.

## 3. Cơ chế flag + mount (toàn bộ trong `shell-server.ts`)

- **Flag** (`parseAdminWebFlag` :357): `DU_ADMIN_WEB` unset/'' → tắt (nguyên trạng legacy); `1|true|yes|on` → mount `/admin/web`; giá trị bắt đầu `/` → mount path đó; giá trị khác → warn + tắt.
- **Bundle dir** (`resolveAdminWebDist` :373): `DU_ADMIN_WEB_DIST` → `apps/admin-web/dist` theo `cwd` → theo `__dirname` (5 cấp lên từ `dist/app/admin`). Không thấy `index.html` → mount vẫn bật, request nhận **503** cố định, log warn lúc mount (:388-408) — không fallback âm thầm.
- **Test seam**: option `adminWeb?: { path?, distDir }` (:302) — inject trong script verify; platform dùng env (main.ts không cần sửa).
- **Session gate** (`resolveAdminWebClaims` :445): mirror `shell-router.dispatchShellRequestAsync` — opaque `du_session` live thắng; legacy `du_admin` chỉ khi không có `du_session`; còn lại null → **302 `/admin/login`** `no-store` (:482-491). Cookie thử của harness dùng policy permissive inject — production giữ nguyên enforcement hiện có.
- **Serve** (`handleAdminWebRequest` :467): GET/HEAD; `/admin/web[//]` + deep link không phải asset → `index.html` `no-store` + CSP nghiêm (:317) + `nosniff` + `referrer-policy: no-referrer`; `/admin/web/assets/<hashed>` → allow-list đuôi + `immutable` 1 năm; asset thiếu → 404 (không trả HTML); chặn `\`, NUL, segment `..`/rỗng (:508-519); POST → 405.
- **Hook**: `const adminWebMount = resolveAdminWebMount(options)` một lần lúc mount (:693) + nhánh sớm trước `dispatchShellRequestAsync` (:705-709) → khi flag tắt, luồng request **byte-for-byte** như trước.

## 4. File đã chạm (đúng lease, `server.ts` không chạm)

| File | Thay đổi |
|---|---|
| `du-rework/pnpm-workspace.yaml` | +1 dòng `- 'apps/*'` |
| `du-rework/pnpm-lock.yaml` | importer `apps/admin-web` + dep shadcn/base-ui/cn/… |
| `services/orchestrator/src/app/admin/shell-server.ts` | **+310 dòng, 0 xóa** (`git diff --stat HEAD`): imports (:25-27,:41-43), option (:127-133), section mount (:283-541), factory hook (:690-709) |
| `du-rework/apps/admin-web/**` | 17 file mới (untracked tới khi coordinator stage) |
| `main.ts`, `shell-router.ts`, `server.ts`, `packages/contracts/**`, `tasks/**`, `docs/**` | **KHÔNG sửa** (không xuất hiện trong `git status`) |

File tạm verify đã xóa: `.cache/aweb01-mount-check.ts`, `.cache/aweb01-{mine,head}-shell-server.ts`.

## 5. Quyết định đã chốt (theo coordinator defaults)

Q5 viết lại toàn bộ (không port code legacy); Q3 Inter; Q2 giữ `--cf-*` (`--cf-blue` cho action, brand cam); Q4 media-query, theme-toggle sau; Q10 flag server-side per-route mặc định tắt; Q11 lane này giữ `pnpm-workspace.yaml` + lockfile. Primitive base: **Base UI** (`@base-ui/react`) — chưa thêm primitive nào (AWEB-03).

## 6. Cách serve static (dev-live + production)

- **Dev UI**: `pnpm --filter @du/admin-web dev` (Vite port riêng, HMR; không session/API — BFF là AWEB-02).
- **Tích hợp**: `pnpm --filter @du/admin-web build` → `apps/admin-web/dist`; Orchestrator (khi được user restart với env) `DU_ADMIN_WEB=1` (+ `DU_ADMIN_WEB_DIST` nếu dist ngoài vị trí chuẩn) → `http://<host>:3001/admin/web`. Flag tắt: `/admin/web` 404 như cũ.
- **Lưu ý**: URL asset gắn với Vite `base=/admin/web/` — muốn path khác phải build lại với base tương ứng (đã ghi README).

## 7. Blockers / chưa làm (thẳng thắn)

- **Chưa có browser-level test** (Playwright/jsdom) — mới chứng minh ở tầng HTTP server; keyboard/320px/direct-URL browser thuộc browser test của slice sau.
- Static route chưa phát `securityAudit` cho dead-session và chưa sweep cookie như gate OIDC của shell renderer (302 thuần) — chuyển sang AWEB-02 khi BFF session ra đời.
- Login thành công hiện về `/admin` (form mặc định) rồi user bấm sang `/admin/web`; redirect-back theo query chưa có ở login cũ (không sửa ngoài lease).
- `dist/` không commit (build artifact); deploy cần bước build — thuộc gói AWEB-08/docs.

## 8. Verdict

**ACCEPTED tại tầng build + HTTP mount (offline harness)**: app bootstrap xanh (`typecheck` + `vite build` exit 0), mount 20/20 check PASS, legacy nguyên trạng khi flag tắt, flag bật thì legacy vẫn 200, shell suites **0 regression** (bằng chứng baseline swap, cùng số fail). Chưa có live-browser evidence — ghi rõ là gap, không nhận thay ACUI-10.
