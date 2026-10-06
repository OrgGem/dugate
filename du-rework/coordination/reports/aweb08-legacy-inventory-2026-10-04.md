# AWEB-08-inv — Legacy surface inventory cho cutover (READ-ONLY, cc_2)

**Packet:** AWEB-08-inv · **Lane:** cc_2 · **Dispatch:** 2026-10-04T16:31+07:00 (spec `coordination/dispatch-specs/2026-10-04-1631-AWEB08-legacy-inventory.md`).
**Mode:** audit READ-ONLY — **không sửa/xoá gì**; chỉ ghi receipt này. Không commit.
**Nguồn rollout:** `aweb08prep-per-route-flag-2026-10-04.md` §2; UI routes: `apps/admin-web/src/router.tsx:37-46`; legacy route table: `shell-router.ts:166-205` + `p6-01-shell-fixtures.ts:222-230` (`getCanonicalNavItems`).

## 1. Route → legacy surface (file:line + vai trò)

| # | Route mới (`/admin/web/...`) | Legacy tương ứng (file:line) | Vai trò legacy |
|---|---|---|---|
| 0 | shell root `/` + mọi layout | `shell-render.ts` (chrome/nav/login/404 — `:21,:215,:329`), `shell-router.ts:173` (admin-root), `shell-router-shared.ts` (`ShellRuntimeConfig`, `parseQueryString`), `shell-server.ts` (mount/static/BFF hooks), `shell-types.ts` | Chrome + session gate + mount — **dùng chung** |
| 1 | `overview` | nav `p6-01-shell-fixtures.ts:225`; `section-dispatch.ts:211-227` (fetcher splice); `overview-section-data.ts`, `overview-section-renderer.ts`, `overview-view-models.ts` (`buildUsageRollupView`/`buildAuditListView`/`buildHealthOverviewView`) | Trang overview + usage rollup + audit column + health |
| 2 | `profiles` | nav `p6-01-shell-fixtures.ts:226`; `section-dispatch.ts:155-182`; `profile-section-data.ts`, `profile-section-renderer.ts`, `profile-view-models.ts`; form mutations **không** có trong `mutation-dispatch.ts` (grep match list `:38-41` chỉ có api-keys/connectors) | Trang profile + form tĩnh |
| 3 | `api-keys` | nav `:229`; `section-dispatch.ts:183-196`; `api-key-section-data.ts`, `api-key-section-renderer.ts`, `api-key-view-models.ts`; mutations `mutation-dispatch.ts:38,46,70-71` (`apikey.issue`/`apikey.revoke`) | List/issue/revoke legacy |
| 4 | `connectors` | nav `:227`; `section-dispatch.ts:169-182`(?); `connector-section-data.ts`, `connector-section-renderer.ts`, `connector-view-models.ts`; mutations `mutation-dispatch.ts:40,65-76,70-71` (test/rotate-secret) | Connector pane + 2 actions |
| 5 | `operations` | nav `:224`; `section-dispatch.ts:197-210`; `operation-section-data.ts`, `operation-section-renderer.ts`, `operation-view-models.ts`; `parseOperationListQuery` (`shell-router-shared.ts:…`, sanitize filters) | Ops list/detail + toolbar |
| 6 | `businesses` | nav `:223`; `section-dispatch.ts:142-154,229-266`; `business-section-data.ts`, `business-section-renderer.ts`, `business-view-models.ts`; enable/activate/deactivate là **JSON API PUT** (không qua shell mutation-dispatch) | Registry + versions legacy |
| 7 | `usage` | **Không có section legacy riêng** — usage nằm trong overview (`overview-view-models.ts` `buildUsageRollupView`) + JSON API `/api/v1/usage` (`http/routes/admin.ts`) | Usage tile (legacy) / API dùng chung |
| 8 | `security` | legacy `/admin/crypto-config` (`shell-router.ts:197`, role admin) + `crypto-config-dispatch.ts`, `crypto-config-renderer.ts`, `crypto-config-view-models.ts`, `crypto-config-api.ts`, `crypto-config-store.ts`, `crypto-config-index.ts` | Crypto-config pane + apply form |
| 9 | `identity` | **Không có trang legacy** — tương ứng: login/session UI `shell-render.ts:215,329` + parser `admin-auth-mode.ts:20-41` (`DU_ADMIN_AUTH_MODE`, LOCAL-03) + `auth-dispatch.ts`/`shell-auth.ts`/`oidc-*` | Session plane + auth-mode parser (server-side) |
| 10 | `settings` | **Không có tương ứng legacy nào** (không route, không renderer, không store) | — |
| — | (chưa có route mới) `grants`, `audit` | nav `:228` (grants, admin); `audit-section-data.ts`/`audit-section-renderer.ts` + `shell-router.ts:190` (`/admin/audit`, operator) + `section-dispatch.ts` handleAuditGet `:144` | **Không có cutover target** — 2 section này hiện vẫn legacy-only |

## 2. Phân loại

### `còn dùng chung` (KHÔNG được xoá ở bất kỳ cutover nào)
- `shell-server.ts` (mount, session gate, static + BFF hook) — hạ tầng của CẢ SPA.
- `shell-render.ts` (chrome/login/error), `shell-router.ts` (matcher + role matrix), `shell-router-shared.ts` (`ShellRuntimeConfig`), `shell-types.ts`, `shell-auth.ts` (verifyCookie — được `bff/context.ts` import), `auth-dispatch.ts` (session resolution — BFF dùng cùng precedence), `mutation-dispatch.ts` (CSRF path legacy + fallback khi flag tắt), `upstream-error-body.ts` (dùng bởi cả data fetchers cũ lẫn các nơi khác), `oidc-boot.ts`/`oidc-flow.ts` (session plane), `admin-auth-mode.ts` (parser boot-side).
- JSON API admin routes (`http/routes/admin.ts`) + `modules/admin-actions/*` — backend cho CẢ legacy và BFF; không thuộc phần xoá của cutover UI.
- Section data fetchers còn phục vụ legacy path khi flag per-route tắt/rỗng (default behavior — AWEB-08-prep: env vắng ⇒ mọi route 200).

### `phải giữ tới khi X`
- `*-section-renderer.ts` + `*-section-data.ts` + view-models theo section: giữ tới khi **route tương ứng** đạt cutover (UI_APPROVED + flag bật + quyết định redirect) **và** không còn consumer nào. Đặc biệt:
  - `audit-*` và `grants` nav entry: **chưa có route mới** ⇒ giữ tới khi có slice tương ứng (audit ledger mới; grants chưa có kế hoạch).
  - `profile-*`: giữ tới khi T-API-01..03 ship + AWEB-04 màn profiles chạy real (hiện honest placeholder).
- `p6-01-shell-fixtures.ts` (`getCanonicalNavItems` `:222-230`): giữ tới khi cả 8 mục nav legacy không còn ai dùng; fixture role matrix còn là nguồn test.

### `dead-sau-cutover` (ứng viên, CHỈ sau khi route đạt đủ điều kiện §3 + grep 0 consumer)
| Route | Dead candidates |
|---|---|
| overview | `overview-section-renderer.ts`, pane splice trong `section-dispatch.ts:211-227` |
| profiles | `profile-section-renderer.ts` (+ data khi backend real thay thế) |
| api-keys | `api-key-section-renderer.ts` (+ nhánh `mutation-dispatch.ts:38,46,70-71` nếu redirect form) |
| connectors | `connector-section-renderer.ts` (+ nhánh test/rotate trong mutation-dispatch) |
| operations | `operation-section-renderer.ts` |
| businesses | `business-section-renderer.ts` |
| usage | không có renderer riêng; tile trong `overview-view-models.ts` chết cùng overview |
| security | `crypto-config-renderer.ts` + `:197` route entry (dispatch/store/api vẫn cần cho JSON side → chỉ UI phần chết) |
| identity/settings | không có gì để xoá |

## 3. Điều kiện cutover mỗi route (theo rollout matrix + acceptance)

| Route | UI_APPROVED | Service condition | Live evidence cần | Ghi chú |
|---|---|---|---|---|
| shell `/admin/web` | ✅ AWEB-01b (6 case) | mount gate + session gate giữ nguyên | live flags (LIV-03) | flag chưa bật trong deployment |
| overview | ✅ AWEB-03b (7 case) | reads real (ops/usage/audit tổng hợp) | live session + real data | có thể bật đầu tiên |
| profiles | PENDING review #2 | T-API-01..03 (backend) + WIRE-FREEZE chốt | live CRUD revision + rollback | UI honest placeholder hôm nay |
| api-keys/connectors | PENDING review #2 | connector composition (F3) cho ready-state; F7 rotate/disable còn disabled | live S3/connector credential | |
| operations/businesses/usage | PENDING review #2 | reads real; cancel/resume (P2-06/P9) chưa compose | live PG data | |
| security | PENDING review #2 | crypto-config compose (ENC); thiếu → 503 honest | live Vault-backed config | |
| identity | PENDING review #2 | LOCAL-00 quyết định + `DU_ADMIN_AUTH_MODE` wiring (hiện parser có nhưng **chưa mount** — new screen nói "chưa managed") | live local/oidc login | |
| settings | PENDING review #2 | deployment adapter (DEP) chưa tồn tại | — | 0 nút Save là chủ đích |

## 4. Rủi ro xoá sớm (≥5 dòng cụ thể)

1. **`/admin/grants` + `/admin/audit` không có route mới**: xoá `section-dispatch`/nav/renderers theo "cutover" sẽ mất 2 màn chưa có thay thế (audit mới chưa làm; grants chưa có slice) — 403/404 người dùng thật.
2. **Bookmark/URL cũ**: contract §1 nói route chưa chuyển tiếp `dùng renderer hiện tại`; legacy URLs (`/admin/profiles`…) là default surface tới khi có redirect — xoá sớm phá bookmarks/redirect-back sau login (login hiện về `/admin`, chưa có redirect-back — AWEB-04 gap #3).
3. **Session/CSRF dùng chung**: `bff/context.ts` import `verifyCookie` (`shell-auth.ts`), `deriveCsrfToken` + `SESSION_COOKIE_NAME`; BFF 403/302 gate phụ thuộc trực tiếp các module này. Xoá theo "legacy" sẽ đổ BFF.
4. **62 suite `tests/admin-*.test.ts`**: 12 suite renderer/view-model trỏ thẳng vào `*-section-*` + 5 suite shell/pre-existing (một số đang đỏ sẵn, đã A/B). Xoá module không xoá/đổi test ⇒ ts-jest fail-to-run hàng loạt + `tsc` đỏ.
5. **Role matrix**: `shell-router.ts:166-205` + nav `requiredRole` (`p6-01-shell-fixtures.ts:222-230`) là nguồn enforcement viewer/operator/admin của legacy còn phục vụ audit/crypto/grants; xoá khi các route này chưa migrate = mất fence phía UI (server vẫn còn, nhưng UX lộ 403 thô).
6. **Docs trỏ legacy**: `docs/21-openapi.json`, `apps/admin-web/README.md` (bảng flag + cách serve), rollout matrix và các receipt AWEB-0x đều tham chiếu path legacy/renderer — xoá sớm làm docs sai, vi phạm "không sửa docs ngoài lease" của các lane trước.
7. **Per-route flag semantics**: `DU_ADMIN_WEB_ROUTES` vắng ⇒ mọi route 200 (behavior cũ). Nếu xoá legacy trước khi flag được bật + redirect chốt, deployment mặc định mất bề mặt admin (flag-off 404 cả hai phía).

## 5. Không thể quyết trong audit này

- Chính sách URL sau cutover: `/admin/<section>` **redirect** sang `/admin/web/<route>` hay giữ song song/404 — quyết định user/coordinator (ảnh hưởng bookmark + login redirect-back).
- Số phận `grants`/`audit` legacy (chưa có slice mới) — chờ PAR-00/ACUI-10 hoặc plan mới.
- Thời điểm bật flag live (LIV-03) + credential/composition cho security/connectors — thuộc deployment/user.
- LOCAL-00 (auth mode) và DEP adapter (settings) chưa tồn tại ⇒ điều kiện cutover identity/settings không thể chốt hôm nay.

## 6. Đề xuất bước AWEB-08 kế tiếp (KHÔNG thực thi trong packet này)

1. **Cutover theo route, mặc định OFF, có redirect**: bật `DU_ADMIN_WEB_ROUTES=overview` trước; khi bật route X, thêm server-side 302 `/admin/<section>` → `/admin/web/<route>` (giữ legacy renderer nguyên trạng làm fallback; chỉ tắt khi có live evidence).
2. **Đóng review #2 (Antigravity)** cho security/api-keys/connectors/operations/businesses/usage/profiles → nâng verdict UI_APPROVED + ghi kèm; song song lấy live evidence từng route theo §3.
3. **Decision packet nhỏ cho URL policy** (redirect vs parallel vs 404) + update `apps/admin-web/README`/deploy docs (owner docs).
4. **Dead-code removal chỉ sau cùng**: mỗi route, sau 1 chu kỳ ổn định + grep 0 consumer + test đã chuyển/xoá tương ứng, mới xoá renderer/data như §2 `dead-sau-cutover`; ưu tiên bắt đầu từ overview (ít rủi ro nhất).
5. **Giữ nguyên tuyệt đối** nhóm `còn dùng chung` (§2) trong mọi bước — đặc biệt `shell-auth.ts`, `auth-dispatch.ts`, `mutation-dispatch.ts` CSRF, `shell-server.ts`, `admin-auth-mode.ts`.

*READ-ONLY: không file nào ngoài receipt này được ghi; không commit.*
