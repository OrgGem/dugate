# WTV-01b — Cross-verify RFX-10/11/12 sống sót trong CONV refactor (cc_2)

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Dispatch:** 2026-10-03T13:32+07:00 (coordinator command-code).
- **Mode:** READ-ONLY source + **được chạy test**. Không sửa file nào; **không tick; không commit; không chạm `nocobase-10`**.
- **Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` WTV-01 + `wtv08-rfx-gapcheck-2026-10-03.md` §0–1 (3 row self-authored, cần verify chéo). Receipt này tự re-derive từ source + test; không dùng receipt cũ làm bằng chứng (chỉ đối chiếu).

**TL;DR (VI):** **PRESERVED — không drift.** Cả 3 fix hiện diện nguyên semantics tại vị trí mới sau CONV-01/02/03, và chứng minh được là **post-fix state** (so với HEAD `b088eec` là pre-fix): RFX-10 gate `shouldSeedDevFallback` (`create-app.ts:171-183`, call site `:234-248`) thay cho seed **vô điều kiện** ở HEAD (`server.ts:463-477`); RFX-11 chuỗi quyết định host (`runtime.ts:113-167`) thay cho `absoluteGrantUrl(host,url)` 2 tham số Host-derived ở HEAD (`server.ts:4241`), đủ **4 call site** grant URL; RFX-12 heartbeat `DEGRADED` + không chạm DB (`runtime.ts:348-368`) thay cho `health:'HEALTHY'` stub ở HEAD (`server.ts:1601`). Focused suites `rfx10-seed-gate` + `rfx11-12-route-hardening`: **2 suites / 15 tests PASS, EXIT=0**; `tsc --noEmit` **EXIT=0**; re-export surface: **59 import site / 59 file / 20 symbol / 0 unresolved**. Không tick/commit.

## 1. RFX-10 — dev fallback seed gate

**Hiện tại (worktree, sau CONV-03):**
- `app/bootstrap/create-app.ts:154-183` — `shouldSeedDevFallback(env, {zeroConfigBoot})`: `DU_SEED_DEV_FALLBACK=true` → seed; `false`/`''` → không seed (veto mọi tín hiệu); unset → chỉ `NODE_ENV` development/test **hoặc** zero-config boot (`autoMigrate:true`); flag sai → **throw** lúc boot.
- `create-app.ts:227-248` — **cả 2 INSERT** (tenant `…0001` + `api_keys dev-fallback`) nằm trong `if (shouldSeedDevFallback(process.env, { zeroConfigBoot: config.autoMigrate === true }))`; comment :227-233 nêu đúng chủ đích (production không ghi row nào; auth vẫn fail-closed vì placeholder hash không khớp raw key nào).

**Đối chiếu pre-fix (HEAD `b088eec`):** `server.ts:463-477` — **không có gate**: 2 INSERT chạy **vô điều kiện** sau migrate/verify (đã đọc trực tiếp từ `git show HEAD:…server.ts`). ⇒ Code hiện tại không phải trạng thái pre-fix; fix còn nguyên sau khi dời sang bootstrap.

**Test pin (chạy lại, PASS):** `rfx10-seed-gate.test.ts` — matrix gate 11 dòng (`:135-150`) + flag sai throw (`:152-156`) + boot smoke `createApp` thật với pg scripted: production/autoMigrate=false/không flag → **0 INSERT seed** (`:159-170`); zero-config boot seeds (`:172-187`); `DU_SEED_DEV_FALLBACK=true` seeds (`:189-201`); development không flag seeds (`:203-211`).

## 2. RFX-11 — grant URL không dựng từ Host header

**Hiện tại (`http/routes/runtime.ts`, sau CONV-02):**
- `:105-119` `allowHostDerivedGrantUrl(env, {zeroConfigBoot})` — chỉ development/test/zero-config được fallback Host.
- `:121-128` `GrantUrlOptions { publicBaseUrl?, zeroConfigBoot?, env? }`.
- `:130-159` `absoluteGrantUrl(host, url, options)` — thứ tự: (1) URL http(s) tuyệt đối passthrough; (2) `publicBaseUrl` cấu hình **luôn thắng**; (3) dev/test/zero-config → fallback `http://${host}${path}`; (4) production không base → **relative path** (không bao giờ dựng từ Host).
- `:161-167` `requestGrantUrl(ctx, url)` truyền `ctx.config.publicBaseUrl` + `zeroConfigBoot = ctx.config.autoMigrate === true`.
- **Đủ 4 call site** qua helper: upload `:191`, access download `:213`, access upload `:214`, multipart part `:245` — grep `absoluteGrantUrl(` chỉ có định nghĩa `:146` + helper `:163`, **không** còn chỗ gọi trực tiếp Host-derived.
- Audit `Host` toàn `src/`: chỉ còn (a) ingress parse `create-app.ts:528` (`new URL(req.url, http://${req.headers.host})` — dựng ctx, không phải grant URL); (b) dòng fallback dev-only `runtime.ts:156` (bên trong gate). Không có builder host-derived nào khác.
- Re-export giữ tên cũ: `server.ts:41` (`allowHostDerivedGrantUrl, absoluteGrantUrl, GrantUrlOptions`).

**Đối chiếu pre-fix (HEAD):** `server.ts:4241` `export function absoluteGrantUrl(host: string, url: string)` — 2 tham số, luôn `http://${host}…`; HEAD **không có** `publicBaseUrl` trong `ServerConfig`, không `allowHostDerivedGrantUrl`/`requestGrantUrl` (grep 0 match). ⇒ Hiện tại là post-fix state.

**Test pin (PASS):** `rfx11-12-route-hardening.test.ts:115-189` — `Host: evil.example` + base cấu hình → cả 3 route (upload/access/part) trả host cấu hình; zero-config/dev không base → legacy Host; **production không base → relative, `not.toContain('evil.example')`**; matrix `absoluteGrantUrl`/`allowHostDerivedGrantUrl` (`:165-188`).

## 3. RFX-12 — heartbeat là stub trung thực

**Hiện tại (`runtime.ts:348-368`):**
- Route `PUT /api/runtime/v1/workers/:instanceId/heartbeat` giữ auth business-scoped như cũ, nhưng response `health: 'DEGRADED'` (`:367`) + comment `:348-357`: "RFX-12: STUB COMPAT SURFACE … **must not report HEALTHY**… 'DEGRADED' là giá trị trong enum `HeartbeatAckSchema`; leaseExpiresAt/capacity giữ cho wire-shape; monitoring thật là `GET /health`". Không đọc/ghi DB/lease state.

**Đối chiếu pre-fix (HEAD):** `server.ts:1601` `health: 'HEALTHY'` (stub số liệu cố định sai sự thật). ⇒ Hiện tại là post-fix state.

**Test pin (PASS):** `rfx11-12-route-hardening.test.ts:191-204` — qua `route()` thật: `health === 'DEGRADED'` và `!== 'HEALTHY'`, parse hợp lệ bằng chính `HeartbeatAckSchema` (`@du/contracts`), `leaseExpiresAt` tương lai, `capacity 1`, **`db.query` không được gọi**.

**Deviation cần chốt (không phải drift của CONV):** spec RFX-12 gợi ý literal `'UNKNOWN'`, implementation chọn `'DEGRADED'` vì enum contract chỉ có HEALTHY/DEGRADED/OFFLINE (rationale ở `cc-rfx-server-2026-10-02.md` §4 + comment `:353-355`; gapcheck §1 cũng đã ghi). Đây là quyết định sản phẩm/coordinator, **không** do refactor sinh ra.

## 4. Re-export spot-check — public surface `server.ts` cũ còn resolve

Script `wtv01b-reexport.js` (statement-scoped): liệt kê export của `src/server.ts` hiện tại, quét mọi import từ specifier `*/server` trong `src/` + `tests/`:

```
server.ts exports: 35 unique names
import sites from a *server module: 59 across 59 files
distinct symbols imported: 20
UNRESOLVED (not exported by server.ts): 0
```

20 symbol được consumer import: `createApp, route, ServerConfig, RouteContext, App, absoluteGrantUrl, allowHostDerivedGrantUrl, buildCryptoConfigOptions, buildDeliveryEncryptionConfig, createMultipartSweepHook, multipartLimitsFromEnv, parseOperationsListQuery, registerAdminCryptoConfigWiring, resolveAdminPrincipal, resolveAdminAuditPrincipal, authorizeAuditTenantRead, authorizeBindingTenant, requireResourceTenant, AdminAuditPrincipal` — **tất cả resolve** (0 unresolved). Spot-check riêng yêu cầu WTV: `createApp/route/ServerConfig/RouteContext/RouteResult/shouldSeedDevFallback/allowHostDerivedGrantUrl/absoluteGrantUrl/GrantUrlOptions/multipartLimitsFromEnv/createMultipartSweepHook/parseOperationsListQuery` đều **EXPORTED**; 10/12 đang được consumer import trực tiếp từ server (RouteResult/GrantUrlOptions là type export qua re-export block `server.ts:41-42`).

## 5. Compile + focused run (literal)

cwd `D:\Git\dugate\du-rework\services\orchestrator`, `NODE_ENV=test` (các test tự quản `NODE_ENV` qua `withEnv`/`withNodeEnv`):

```
> pnpm exec jest --runInBand tests/rfx10-seed-gate.test.ts tests/rfx11-12-route-hardening.test.ts
JEST_EXIT=0
PASS tests/rfx10-seed-gate.test.ts
PASS tests/rfx11-12-route-hardening.test.ts
Test Suites: 2 passed, 2 total
Tests:       15 passed, 15 total

> pnpm exec tsc --noEmit -p tsconfig.json
TSC_EXIT=0
```

## 6. Verdict

- **`PRESERVED` — drift list ∅.** 3/3 fix hiện diện nguyên semantics tại file mới; mỗi fix đều chứng minh được là *post-fix* so với HEAD pre-fix; test pin tương ứng chạy xanh qua route/boot thật (offline seam); re-export surface zero-unresolved; tsc 0.
- **Chưa chứng minh offline / open items (không thuộc CONV):**
  1. **Live boot smoke RFX-10** trên PG thật (chưa mở DB window) — acceptance live của row RFX-10.
  2. **RFX-11 wiring**: `main.ts` hiện **chưa** truyền `PUBLIC_BASE_URL` → `config.publicBaseUrl` (grep `publicBaseUrl|PUBLIC_BASE_URL` trong `main.ts` = 0) — production không cấu hình sẽ trả relative (fail-closed đúng thiết kế); cần packet nối ở composition (ngoài lease WTV này).
  3. **RFX-12 deviation** `'DEGRADED'` vs spec `'UNKNOWN'`: cần coordinator/Product chốt (muốn `'UNKNOWN'` phải sửa contract + worker SDK — ngoài phạm vi row).
  4. Live E2E với Host header qua reverse proxy thật — ngoài offline seam; caveat `AUTO_MIGRATE=true` (doc-note #4 của RFX receipt) vẫn đứng nguyên: one-shot production `AUTO_MIGRATE=true` được coi là zero-config → seed + Host fallback; veto seed bằng `DU_SEED_DEV_FALLBACK=false`.

## 7. Ranh giới

- READ-ONLY: không sửa source/test; chỉ ghi receipt này + script scratchpad. Không chạm `server.ts` (lease serialize). HEAD vẫn `b088eec`; không tick, không commit, không chạm `nocobase-10`.
