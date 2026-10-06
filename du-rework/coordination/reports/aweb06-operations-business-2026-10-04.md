# AWEB-06 — Operations / Usage / Business slice (BFF + UI + browser evidence)

**Packet:** aweb06-operations-business · **Lane:** cc_1 (Admin UI integrator) · **Dispatch:** 2026-10-04T13:32+07:00.
**Trạng thái:** DONE. Không commit, không tick. Không chạm `components/ui/**`, `styles/**`, `app-shell/**`, `server.ts`, `main.ts`, migrations, contracts, openapi, tasks, docs.

## 1. Route / state matrix

| BFF route (mới, `bff/operations.ts`) | Upstream | Fence | Allow-list |
|---|---|---|---|
| `GET /admin/api/operations` | `GET /api/v1/operations` (admin-bearer branch ADM-BASE-01/02) | tenant từ session: operator bị pin (foreign `?tenant=` → 403, upstream untouched); platform có thể narrow | `limit,cursor,state,tenant,id,sort` (drop `evil`) |
| `GET /admin/api/operations/:id` | `GET /api/v1/operations/:id` (merged `{operation,result,artifacts,serverNow}`) | như trên; dot-segment id → 404 trước upstream | — |
| `GET /admin/api/usage?from&to&tenantId` | `GET /api/v1/usage` (admin-bearer branch) | thiếu `from`/`to` → 422 trước upstream; tenant theo session | — |
| `GET /admin/api/businesses[?limit,cursor,sort]` | `GET /api/v1/admin/businesses` (platform-only) | operator/viewer → **403 `ADMIN_CREDENTIAL_REQUIRED`** (không để lộ upstream 401) | `limit,cursor,sort` |
| `GET /admin/api/businesses/:id/versions` | `GET /api/v1/admin/businesses/:id/versions` | platform-only | — |
| `PUT /admin/api/businesses/:id/versions/:v/{enable,activate,deactivate}` | `PUT` tương ứng (real action, đã ship) | admin + **CSRF**; forward nguyên verb + platform bearer | — |

| UI route | States | Hành động |
|---|---|---|
| `/admin/web/operations` | loading/ready/empty/error/denied; filter state + refresh; chi tiết mở từ ID → artifacts table + result | Cancel/Resume/Replay **disabled + badge `actions: requires backend`** (route upstream chỉ phục vụ x-api-key tenant; admin action path chưa compose — P2-06/P9) |
| `/admin/web/businesses` | loading/ready/empty/error/**denied** (operator thấy lý do platform-scoped) | Versions list; Enable/Activate/Deactivate **thật** qua CSRF (activate chỉ khi !isActive, deactivate chỉ khi isActive) |
| `/admin/web/usage` | loading/ready/empty/error/denied | from/to (default 24h) → summary verbatim, không tự aggregate |
| Workflow/schema catalog | — | **không có route backend** → không dựng màn; ghi gap owner P9 |
| Link | nav 6 mục trong Overview (`/operations /businesses /usage /profiles /api-keys /connectors`) | |

## 2. Browser evidence — **37/37 PASS**

```
ok 1..7  operations-business.spec.ts: list ready + actions disabled + detail/artifacts;
          empty; error→retry; operator tenant-fenced (assert wire `tenant=<uuid>` qua /__stub/requests)
          + businesses denied (platform-scoped); businesses ready + versions + Enable thật (notice “Version 3 enabled.”);
          businesses error→retry; usage ready (`"tokens": 3456`); 320px không tràn ngang
37 passed (41.9s)   # + 30 case cũ (AWEB-01b/03b/04/05) regression cùng lượt
```
Screenshots `coordination/evidence/aweb06/06-01..11-*.png` (06-01 đã xem: bảng operations, badge state, 3 nút disabled + badge lý do).

2 bug thật do test bắt, đã sửa: (1) `businesses` screen thiếu bootstrap `getSession()` → CSRF trống → PUT 403; (2) notice bị `openVersions()` xoá ngay sau khi set (thông báo phải set sau reload). Spec cũ `overview.spec.ts` cập nhật 1 locator do nav mới trùng tên tile (đổi sang `getByRole('heading')`).

## 3. Commands literal

```
pnpm exec jest (aweb02+04+05+06)   → 4 suites, 53 tests passed (26+10+8+7)   JEST=0
pnpm --filter @du/orchestrator typecheck → TSC=0
pnpm --filter @du/admin-web build  → exit 0 (2656 modules; JS 430.08 kB / gzip 136.61 kB)
npx playwright test --config admin-web/playwright.config.ts → 37 passed (41.9s)
```

## 4. File đã chạm

| File | Thay đổi |
|---|---|
| `bff/operations.ts` (mới) | 6 route + fence + allow-list + PUT passthrough |
| `bff/handle.ts` | +import/hook operations (route cũ không đổi) |
| `bff/upstream.ts` | `UpstreamCallOptions.method` thêm `'PUT'` (không đổi hành vi cũ) |
| `lib/api/{types,client,index}` | Operations/Usage/Business types + 6 method (request thêm verb PUT) |
| `features/operations/{state,operations-screen}` (mới) | list/detail/artifacts + disabled actions honest |
| `features/businesses/{state,businesses-screen}` (mới) | registry + versions + actions thật |
| `features/usage/usage-screen.tsx` (mới) | window + summary verbatim |
| `routes/{operations,businesses,usage}.tsx` (mới), `router.tsx`, `features/overview/overview-screen.tsx` | route + nav 6 mục |
| `tests/browser/admin-web/{harness.ts,operations-business.spec.ts,overview.spec.ts}` | stub ops/usage/biz + 7 case + 1 locator cập nhật |
| `tests/orchestrator/tests/aweb06-bff-operations.test.ts` (mới) | 7 test fence/forwarding |
| `coordination/evidence/aweb06/**` | 11 ảnh `06-*` |

## 5. Gaps backend (owner rõ)

- **Cancel/Resume admin path (P2-06/P9)**: upstream routes tồn tại nhưng chỉ xác thực `x-api-key` tenant; BFF không giữ api-key ⇒ UI disabled kèm lý do. Khi có admin-accepting route hoặc credential model, chỉ cần bật nút (BFF forward sẵn pattern).
- **Replay**: chưa có route backend (P9) — không nút giả.
- **Workflow/schema catalog**: chưa có route ⇒ không dựng màn (ghi gap).
- **Usage**: phụ thuộc `ctx.usage` composition của deployment (đã có trong createApp); live chứng minh thuộc LIV/P9.
- Platform-global audit view (tenant NULL) vẫn ngoài phạm vi (đã ghi ở ADM-BASE-01).

## Verdict

**ACCEPTED ở tầng BFF + browser harness**: 6 route mới với fence đúng (operator tenant-fenced có bằng chứng wire `tenant=`; business registry platform-only 403 không chạm upstream; usage 422 fail-closed; CSRF cho PUT action), UI 3 màn đủ 5 state + actions thật/disabled-honest, **37/37 Playwright** (7 case mới + 30 regression), **53/53 jest**, build/typecheck 0. Không nút giả; mọi capability thiếu đều ghi owner (P2/P9/PAR).
