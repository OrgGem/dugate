# AWEB-08-prep — per-route rollout flag + rollout matrix + docs (2026-10-04)

**Packet:** aweb08prep-per-route-flag · **Lane:** cc_1 · **Dispatch:** 2026-10-04T14:12+07:00.
**Trạng thái:** DONE. **Không gỡ file/renderer nào**; legacy giữ nguyên mặc định. Không commit, không tick.
Không chạm: renderer cũ (`shell-render.ts`, section renderers), `components/ui/**`, `styles/**`, `app-shell/**`, migrations/contracts, `server.ts`, `main.ts`, `tasks/**`, `docs/**`.

## 1. Per-route flag — semantics (đã chốt)

`DU_ADMIN_WEB_ROUTES` (comma list, tên = segment của SPA route): `overview, profiles, api-keys, connectors, operations, businesses, usage, security, identity, settings`.

| Env | Hành vi |
|---|---|
| vắng / blank | **giữ nguyên hành vi cũ** (toàn bộ SPA như trước AWEB-08) |
| danh sách một phần (vd `overview,security`) | route trong list → 200 index thật; route ngoài list → **một 404 document nhất quán** ("Route not enabled on this deployment") + link `/admin` |
| tên lạ (vd `overview,bogus`) | tên lạ bị bỏ (log warn), phần còn lại vẫn áp dụng |
| `,` (present, rỗng sau parse) | chỉ shell root `/admin/web` còn reachable (fail-closed) |

**Quyết định “route ngoài allow-list”**: chọn **not-found nhất quán ở tầng server** (không auto-redirect), vì (a) contract §1 nói “route chưa chuyển tiếp tiếp tục dùng renderer hiện tại” — legacy vẫn phục vụ tại `/admin/<section>`; (b) lease packet này không mở client (`router.tsx` không thuộc lease), nên lọc trong SPA cần packet sau; (c) fail-closed: route chỉ hiện khi được liệt kê tường minh. Trang 404 escape đúng segment (HTML-escape) và giữ CSP/no-store như index. Assets không bị gate (đi nhánh asset riêng).

Implementation: `shell-server.ts` — `parseAdminWebRoutes` (:402-421), mount giữ `routes` (:317-330, :423-470), gate trong `handleAdminWebRequest` trước nhánh index (:611-632), `escapeHtmlText` (:477-485).

## 2. Rollout matrix (route → UI verdict → điều kiện cutover → trạng thái hiện tại)

| Route | UI verdict hiện có | Điều kiện cutover (AWEB-08) | Trạng thái |
|---|---|---|---|
| `/admin/web` (shell + bootstrap) | **UI_APPROVED** (AWEB-01b: direct/reload/login/logout/keyboard/theme/320px; 6 case) | mount gate + session gate giữ nguyên | đang tắt trong deployment (`DU_ADMIN_WEB` chưa set — LIV-03) |
| `/overview` | **UI_APPROVED** (AWEB-03b accepted; 7 case browser) | + evidence live của service theo route khi bật | có thể bật đầu tiên khi triển khai |
| `/security` | PENDING review #2 (Antigravity UI review) | backend REAL (crypto-config; 503 nếu chưa compose) + UI_APPROVED | chờ review #2 |
| `/identity`, `/settings` | PENDING review #2 | honest-unavailable (chưa có backend LOCAL/OIDC/DEP) — chỉ bật khi đã chấp nhận trạng thái honest | chờ review #2 |
| `/api-keys`, `/connectors` | PENDING review #2 | reads real; connector composition (F3) cần cho ready-state; rotate/disable (F7) vẫn disabled | chờ review #2 |
| `/operations`, `/businesses`, `/usage` | PENDING review #2 | reads real (ops/usage admin-bearer; business platform); cancel/resume (P2-06/P9) chưa compose | chờ review #2 |
| `/profiles` | PENDING review #2 | wire frozen; backend T-API-01..03 chưa ship (UI honest placeholder/disabled) | chờ review #2 + T-API |
| Legacy `/admin/*` toàn bộ | giữ nguyên (không đổi 1 dòng) | chỉ retire sau khi từng route đạt parity + evidence; **không xóa trong packet này** | default surface |

Gợi ý staging (không tự áp — deployment env thuộc user/DEP): `DU_ADMIN_WEB=1` + `DU_ADMIN_WEB_ROUTES=overview` bật đầu; thêm route sau khi có UI_APPROVED của review #2 và evidence live tương ứng.

## 3. Tests (mới) + regression

`tests/aweb08-per-route-flag.test.ts` — 6 case (real HTTP, env set/restore per test):
1. env vắng → toàn bộ route 200 + SPA fallback (behavior cũ).
2. env blank → treat như vắng.
3. allow-list một phần → route trong list 200 (index thật, `<div id="root">`); route ngoài (kể cả path lạ) → **404 cùng document** + link `/admin` + no-store; root 200; asset-miss 404 riêng (không phải gate).
4. tên lạ bị bỏ, phần còn lại áp dụng.
5. `,` → chỉ root reachable.
6. mount flag off → legacy 404 nguyên trạng.

```
pnpm exec jest (6 suite: aweb02+04+05+06+07+08) → 6 suites, 65 tests passed (59 cũ + 6 mới)   JEST=0
pnpm --filter @du/orchestrator typecheck → TSC=0
pnpm --filter @du/admin-web build        → exit 0 (không đổi app code)
npx playwright test (env mặc định, flag vắng) → 43 passed (54.1s)   # chứng minh default behavior KHÔNG đổi
```

## 4. Docs

- `apps/admin-web/README.md`: bổ sung bảng `DU_ADMIN_WEB_ROUTES` (absent/partial/unknown/empty + decision 404-nhất-quán + lý do không auto-redirect).
- **Doc-note (không sửa `docs/**`)**: cần đưa `DU_ADMIN_WEB_ROUTES` vào docs deploy/compose (owner docs lane) và ghi chú trong ADM-UX/AWEB-08 rằng gate là server-side, client không cần biết allow-list (nếu sau này muốn ẩn nav theo allow-list thì cần lease client + inject meta).

## 5. File đã chạm

| File | Thay đổi |
|---|---|
| `services/orchestrator/src/app/admin/shell-server.ts` | +parse allow-list, +mount.routes, +gate 404, +escape helper (route cũ không đổi) |
| `apps/admin-web/README.md` | +bảng flag + decision |
| `tests/orchestrator/tests/aweb08-per-route-flag.test.ts` (mới) | 6 case |

Không xóa/đổi renderer cũ; không chạm `router.tsx`/client (ngoài lease).

## Verdict

**ACCEPTED ở tầng flag + tests**: default behavior chứng minh không đổi (43/43 Playwright với env vắng), allow-list một phần hoạt động đúng (6/6 case mới, gồm negative “route ngoài list → 404 trước khi render”), 65/65 jest, tsc/build 0. Rollout matrix sẵn sàng cho AWEB-08; cutover thực tế vẫn chờ UI_APPROVED review #2 + evidence live từng route; renderer cũ nguyên trạng.
