# AWEB-01b — Browser evidence cho Admin Web mount (cc_2)

**Packet:** aweb01b-browser-evidence · **Lane:** cc_2 · **Dispatch:** 2026-10-04T11:53+07:00 (spec `coordination/dispatch-specs/2026-10-04-1153-AWEB01b-browser-evidence.md`).
**Mode:** READ-ONLY với source ngoài lease; **không commit**; không đụng container user. File ghi (trong lease):
`tests/browser/admin-web/{harness.ts, playwright.config.ts, admin-web.spec.ts}`, `coordination/evidence/aweb01b/**`, receipt này. Không sửa `apps/admin-web/src/**`, orchestrator `src/**`, `tasks/**`, `docs/**`.

**TL;DR:** **6/6 PASS (10.6s), exit 0** — Playwright Chromium chạy trực tiếp vào harness `createAdminShellServer` (source, port 0 → 60334, `NODE_ENV=test`) đã mount `/admin/web`: unauth→302 login ✓, login→React render (không lỗi console) ✓, reload giữ session ✓, 320px không tràn ngang ✓, keyboard focus ring ✓, light/dark (`data-theme`) ✓. **7 screenshot + harness.json** trong `coordination/evidence/aweb01b/`. Harness được viết để tái sử dụng cho AWEB-03b/04.

## 1. Harness (source seam — KHÔNG phải live stack)

- `tests/browser/admin-web/harness.ts` — gọi thẳng `createAdminShellServer` từ source với `{ port: 0, host: '127.0.0.1', cookieSecret, adminToken, adminWeb: { distDir: apps/admin-web/dist } }`; chạy dưới `NODE_ENV=test` (cookie policy permissive cho http). Server ghi `harness.json` (`{url, port, token, dist}`) rồi giữ nguyên; SIGTERM để tắt.
- `tests/browser/admin-web/playwright.config.ts` — config riêng, `testDir: '.'`, 1 project Chromium desktop 1280×800, workers 1 — **không** dùng `playwright.config.ts` của repo (tránh kéo theo live-admin-e2e 2 project). Reporters: list.
- `tests/browser/admin-web/admin-web.spec.ts` — 6 case (§2); credentials/login qua form token thật của shell; console-error filter chỉ bỏ qua favicon 404, mọi lỗi khác fail.

**Lệnh tái lập (literal):**

```
# terminal 1 (harness)
cd D:\Git\dugate\du-rework
$env:NODE_ENV='test'; pnpm dlx tsx tests/browser/admin-web/harness.ts coordination/evidence/aweb01b/harness.json
→ HARNESS_READY http://127.0.0.1:60334 dist=D:\Git\dugate\du-rework\apps\admin-web\dist   (task s0sqxflj, PID 31824)

# terminal 2 (Playwright — KHÔNG dùng pnpm --filter @du/browser-tests test)
cd D:\Git\dugate\du-rework\tests\browser
$env:AWEB01B_URL='http://127.0.0.1:60334'; $env:AWEB01B_TOKEN='aweb01b-browser-token'
$env:AWEB01B_EVIDENCE='D:\Git\dugate\du-rework\coordination\evidence\aweb01b'
npx playwright test --config admin-web/playwright.config.ts
```

## 2. Test matrix + literal run

```
Running 6 tests using 1 worker

  ok 1 admin-web\admin-web.spec.ts:52:7 › … › 1. direct unauth /admin/web -> 302 login; login form renders (1.8s)
  ok 2 admin-web\admin-web.spec.ts:67:7 › … › 2. login -> React app renders; no serious console errors (1.3s)
  ok 3 admin-web\admin-web.spec.ts:80:7 › … › 3. reload keeps the session and re-renders the app (1.6s)
  ok 4 admin-web\admin-web.spec.ts:89:7 › … › 4. 320px viewport: no horizontal overflow; nav reachable (1.4s)
  ok 5 admin-web\admin-web.spec.ts:103:7 › … › 5. keyboard: Tab reaches a control with a visible focus ring (1.0s)
  ok 6 admin-web\admin-web.spec.ts:126:7 › … › 6. theme: light + data-theme=dark render distinctly (1.1s)

  6 passed (10.6s)
PW_EXIT=0
```

| # | Case (theo spec §2) | Assertion chính | Verdict |
|---|---|---|---|
| 1 | unauth `/admin/web` → login | `APIRequest GET maxRedirects:0` → **302** + `location: /admin/login`; browser theo redirect → pathname `/admin/login`, `input[name="token"]` visible, title khớp `/Admin/` | PASS |
| 2 | login → React render | token form → 302 → `/admin`; vào `/admin/web`: title `DUGate Admin`, `#root` > 200 ký tự, h1 "Admin Web bootstrap is running", nav (`Admin Web Navigation`) + badge visible; **0 console error sau filter favicon, 0 pageerror** | PASS |
| 3 | reload | `page.reload()` → URL vẫn `/admin/web`, h1 render lại (cookie `du_admin` giữ session) | PASS |
| 4 | 320px | `scrollWidth ≤ clientWidth + 1` (đo thật: 320/320), nav + link "Bootstrap" vẫn visible; header wrap dọc | PASS |
| 5 | keyboard | Tab đầu tiên → activeElement là `<A>` có label, `outline-style ≠ none`, `outline-width ≥ 1px` (rule `:focus-visible` trong app.css) | PASS |
| 6 | theme | light (emulate `colorScheme: light`) vs `document.documentElement[data-theme=dark]`: computed `body` background-color **và** color đều đổi; tokens.css `:root[data-theme='dark']` kích hoạt | PASS |

## 3. Evidence — `coordination/evidence/aweb01b/`

| File | mtime 2026-10-04 | Bytes |
|---|---:|---:|
| `01-unauth-login.png` | 11:56:26 | 20,971 |
| `02-login-rendered.png` | 11:56:28 | 60,961 |
| `03-reload.png` | 11:56:29 | 60,961 |
| `04-320px-reflow.png` | 11:56:31 | 54,781 |
| `05-keyboard-focus.png` | 11:56:32 | 61,193 |
| `06-theme-light.png` | 11:56:33 | 60,961 |
| `07-theme-dark.png` | 11:56:33 | 60,420 |
| `harness.json` | 11:55:47 | 153 |

Đã mở kiểm tra (vision): **02** = app render thật (header DUGate Admin + nav Bootstrap/Legacy shell + badge; card "Session (live from /admin/api/session)" ở trạng thái **ready**: `legacy:admin (platform)` / `admin · auth plane legacy` / scope platform — tức BFF `/admin/api/session` đã trả lời qua seam); **04** = reflow dọc đúng ở 320px, không tràn, nav wrap xuống hàng riêng; **07** = dark palette thật (canvas #0b0f19, card tối, link xanh sáng). Ảnh không trắng.

## 4. Nuances (đọc kỹ trước khi trích dẫn)

1. **Bundle phục vụ = bản AWEB-02 build lúc 11:56:09** (assets `index-_Z6t_nO2.js` 273,409 B + `index-B34cL5Le.css` 39,372 B) — lane AWEB-02 đang tích hợp song song (`apps/admin-web/src` sửa 11:55:22–11:55:42, shell-server +32 dòng lúc 11:49). Harness đọc dist **theo từng request**, nhưng rebuild xảy ra **trước test đầu tiên (11:56:26)** ⇒ cả 6 test + 7 ảnh dùng **một bundle nhất quán** (hash ghi ở trên). Evidence ghim theo **build**, không theo git revision (HEAD vẫn `b088eec`; `apps/**` untracked).
2. Card session hiển thị trạng thái `ready` — nghĩa là endpoint BFF `/admin/api/session` + client typed (AWEB-02) hoạt động qua seam harness này; **chi tiết contract của AWEB-02 thuộc lane đó**, packet này chỉ ghi nhận render.
3. Harness/spec giữ lại `tests/browser/admin-web/**` để tái sử dụng (đúng mục tiêu spec: AWEB-03b/04 cần browser evidence).

## 5. Giới hạn (không overclaim)

- Đây là **server-seam + browser thật (Chromium headless) trên harness local** — **không phải live stack** (không service user, không DB/Redis), không thay thế acceptance live.
- 320px = viewport resize trên desktop Chromium, không phải device emulation; chỉ 1 browser; không axe/WCAG scan trong packet này (thuộc harness khác).
- Case keyboard chỉ xác nhận stop đầu tiên + focus ring computed style; chưa phải full tab-order audit.
- Theme kiểm qua `data-theme` attribute + màu computed; chưa kiểm `prefers-color-scheme` media (tokens.css có nhánh đó nhưng ngoài 6 case yêu cầu).

## 6. Ranh giới & verdict

- Trong lease: 3 file spec/harness mới + 8 file evidence + receipt này. Không sửa `apps/**`, orchestrator `src/**`, `tasks/**`, `docs/**`; harness đã tắt (kill task s0sqxflj) sau khi chạy; không commit.
- **Harness + 6/6 browser case PASS** — đủ deliverable theo dispatch; sẵn sàng tái dùng cho các slice sau.
