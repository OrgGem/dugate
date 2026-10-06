# AWEB-02 — BFF foundation (`/admin/api/*`, session/CSRF/tenant fence)

**Packet:** aweb02-bff-foundation · **Lane:** cc_1 (Admin UI integrator) · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T11:42+07:00.
**Trạng thái:** DONE (BFF + client + focused test 26/26 + regression no-change). Không commit, không tick. `server.ts`, `packages/contracts`, `styles/**`, `components/**`, `app-shell/**`, `tasks/**`, `docs/**` **không bị sửa** (xem §6).

## 1. BFF — bề mặt & semantics

| Route | Hành vi | Evidence |
|---|---|---|
| `GET /admin/api/session` | Resolve session (OIDC `du_session` quyết định một mình; legacy `du_admin` chỉ khi không có `du_session`), trả `{schemaVersion, plane, role, principal{kind,tenantId}, scope, displayName, csrfToken}`; `no-store` + `nosniff` | `bff/context.ts:50-84`, `bff/handle.ts:115-141` |
| `GET /admin/api/audit` | Read có **tenant fence** (ACUI-M07), proxy tới `GET {jsonBaseUrl}/api/v1/admin/audit` | `bff/handle.ts:142-213` |
| `POST /admin/api/actions` | Mutation admin-only + **CSRF bắt buộc**, forward `idempotency-key`, proxy `POST /api/v1/admin/actions` | `bff/handle.ts:214-289` |
| khác | `404 NOT_FOUND` / `405 METHOD_NOT_ALLOWED` problem+json | `bff/handle.ts:73-110` |

- Session gate dùng đúng thứ tự của shell cũ (SEC-02: session chết **không** downgrade sang legacy cookie) — test riêng: `aweb02-bff-foundation.test.ts` "dead du_session is not downgraded".
- Principal suy từ **record server-side** (`role`/`tenantId`), không bao giờ từ query/body/URL; CSRF: OIDC = `record.csrfToken` (constant-time `verifySessionCsrf`), legacy = HMAC `deriveCsrfToken(secret, cookie)`.
- BFF bật/tắt cùng switch `DU_ADMIN_WEB` của AWEB-01 (`shell-server.ts:702-708` ghi rõ lý do: một switch cho "bề mặt admin mới"; flag tắt → `/admin/api/*` 404 như cũ).
- Không token nào vào log: logger chỉ log `errorClass`/status/correlationId; upstream 5xx → `502 UPSTREAM_ERROR` với text cố định, không echo body (`bff/handle.ts:336-380`, `bff/envelope.ts:58-77`). Response body giới hạn 64 KiB (`bff/body.ts:5,12`).

## 2. Tenant-fence matrix (ACUI-M07) — đo bằng test thật

| Session (principal) | `?tenantId=` | Kết quả BFF | Credential tới upstream | Upstream gọi? |
|---|---|---|---|---|
| không session | bất kỳ | `401 UNAUTHENTICATED` | — | không |
| legacy admin (platform) | `tenant-b` | `200` | `Bearer <ADMIN_TOKEN>` (platform) | có |
| legacy admin | `''` | `200` (không lọc tenant) | platform | có |
| OIDC operator `tenant-a` | (không có) | `200`, **tenant ép = tenant-a** | `Bearer <TENANT_A_TOKEN>` | có |
| OIDC operator `tenant-a` | `tenant-a` | `200` | `TENANT_A_TOKEN` | có |
| OIDC operator `tenant-a` | `tenant-b` | **`403 PERMISSION_DENIED`** | — | **không** |
| OIDC operator `tenant-c` (chưa cấu hình token) | bất kỳ | **`403 TENANT_SCOPE_UNAVAILABLE`** (fail closed, không mượn platform token) | — | không |
| OIDC viewer | bất kỳ | `403 PERMISSION_DENIED` (no admin principal) | — | không |
| legacy operator/viewer | bất kỳ | `403` (legacy plane không có tenant binding) | — | không |

- Fence dùng lại đúng helper RBAC của platform (`authorizeAuditTenantRead` — `modules/admin-actions/rbac.ts:71-83`), không tự viết luật mới; test còn khẳng định trực tiếp helper: tenant_operator + tenant ngoài → throw 403 (legacy `direct-API leg`).
- Phía API trực tiếp (bearer tenant_operator + `?tenantId=` ngoài): suite nền tảng `admin-audit-scope.test.ts` **21/21 pass** (chạy trong receipt này).
- Token chỉ được chọn theo principal: platform → `adminToken`; tenant_operator → token của **đúng tenant trong session** (đảo map `tenantAdminTokens` token→tenant, own-entries scan — `bff/handle.ts:410-423`).

## 3. CSRF matrix (mutations)

| Plane | Proof gửi | Kết quả | Upstream |
|---|---|---|---|
| legacy admin | thiếu `x-csrf-token` | `403 CSRF_REJECTED` | không |
| legacy admin | `deriveCsrfToken(secret, du_admin)` | `200`, forward `idempotency-key` | có |
| OIDC admin | token sai (`X`×43) | `403 CSRF_REJECTED` | không |
| OIDC admin | `record.csrfToken` | `200` | có |
| operator/viewer (mọi plane) | — | `403 PERMISSION_DENIED` (admin-only, kiểm trước CSRF) | không |

## 4. Error envelope (problem+json, cùng shape `@du/contracts problem()`)

| Nguồn | Status/code ra wire |
|---|---|
| thiếu session | 401 `UNAUTHENTICATED` |
| không có principal / tenant ngoài / CSRF / thiếu credential tenant | 403 `PERMISSION_DENIED` / `CSRF_REJECTED` / `TENANT_SCOPE_UNAVAILABLE` |
| route/method sai | 404 `NOT_FOUND` / 405 `METHOD_NOT_ALLOWED` |
| body > 64 KiB | 413 `PAYLOAD_TOO_LARGE` |
| JSON hỏng / action sai shape | 422 `INVALID_SCHEMA` |
| upstream 4xx | pass status + `code` (vd `409 REVISION_CONFLICT`, `422 INVALID_SCHEMA`) + `errors[]` đã sanitize (≤200 ký tự, bỏ control chars) |
| upstream 5xx / unreadable | 502 `UPSTREAM_ERROR` (text cố định) |
| chưa cấu hình `jsonBaseUrl` | 503 `UPSTREAM_UNAVAILABLE` |

Mọi response BFF: `cache-control: no-store`, `x-content-type-options: nosniff`, `x-correlation-id`.

## 5. Commands + literal evidence

```
# orchestrator typecheck
> tsc --noEmit -p tsconfig.json
TSC_EXIT=0

# focused suite (fresh, cuối cùng)
Test Suites: 1 passed, 1 total
Tests:       26 passed, 26 total
Time:        7.878 s
EXIT=0
```

Regression (so với baseline AWEB-01 — y hệt, pre-existing ambient/loopback):
```
batch1 admin-shell-{server,router,render,fixtures}+auth:  4 failed, 1 passed, 5 total | 23 failed, 148 passed, 171 total
batch2 admin-shell-{platform-mount,session-lifecycle,oidc-mount}: 2 failed, 1 passed | 3 failed, 91 passed, 94 total
admin-audit-scope.test.ts (API-side fence): 1 passed | 21 passed, 21 total
```

Lần chạy focused ĐẦU TIÊN: 13 fail — test bắt được **1 bug thật**: lookup credential tenant bị đảo chiều (`tenantAdminTokens[tenantId]` trong khi map là token→tenant) → đã sửa thành `credentialForTenant()` (`bff/handle.ts:415`); lỗi còn lại là fixture test dùng epoch giây thay vì ms — sửa fixture. Sau đó 26/26.

```
# admin-web (client mới) build
vite v6.4.3 building for production... ✓ 46 modules transformed.
dist/index.html                0.47 kB
dist/assets/index-B34cL5Le.css 39.37 kB │ gzip: 7.84 kB
dist/assets/index-_Z6t_nO2.js  273.41 kB │ gzip: 92.42 kB
BUILD_EXIT=0
```

Hygiene (trong suite): quét `dist/index.html` + **mọi asset** — không chứa `ADMIN_TOKEN`/tenant token/`cookieSecret`, không có literal `adminToken`; mọi body BFF (session/audit/actions/error) không echo token; upstream 500 body chứa token giả → BFF 502 không lộ (`res.body` không chứa token/message gốc).

## 6. File đã chạm + boundary

| File | Thay đổi |
|---|---|
| `src/app/admin/bff/context.ts` (mới) | session→context/principal/CSRF |
| `src/app/admin/bff/handle.ts` (mới) | router + fence + upstream proxy + envelope writer |
| `src/app/admin/bff/envelope.ts` (mới) | problem builder + upstream mapping + sanitize |
| `src/app/admin/bff/body.ts` (mới) | bounded body reader |
| `src/app/admin/shell-server.ts` | +32 dòng AWEB-02 (imports :47, option `tenantAdminTokens` :134-140, attach :832-833,:858, hook BFF :702-708,:725-736); tổng diff vs HEAD = **+342 dòng, 0 xóa** (gồm AWEB-01) |
| `tests/aweb02-bff-foundation.test.ts` (mới) | 26 test offline |
| `apps/admin-web/src/lib/api/{types,client,index}.ts` (mới) | typed client + envelope decoder (no `any`) |
| `apps/admin-web/src/routes/bootstrap-home.tsx` | đọc session thật qua client (loading/ready/error, 401 → link login) |

**Không chạm:** `server.ts`, `packages/contracts/**`, `styles/**`, `components/**`, `app-shell/**` (Antigravity), `tasks/**`, `docs/**`.
**Ghi nhận lane khác (không phải tôi):** `api-key-section-data.ts` + `api-key-section-renderer.ts` xuất hiện modified mtime **15:06:41** (5 dòng diff) — đang có writer khác trong cùng thư mục; tôi không sửa và không chặn.

## 7. ACUI-M07 — trạng thái

- **Đã xử lý cho read path của app mới**: tenant luôn lấy từ session server-side; `?tenantId=` của operator bị 403; credential operator là token **của tenant đó**, không dùng platform bearer; tenant chưa cấu hình token → fail closed. Trước đây fetcher của shell cũ gọi API bằng platform bearer cho mọi role — BFF mới không lặp lại mẫu đó.
- **Còn mở (không thuộc lease)**: (1) `main.ts` chưa parse env nào cho `config.tenantAdminTokens` → trên deployment thật, operator reads sẽ 403 `TENANT_SCOPE_UNAVAILABLE` cho tới khi platform lane nối env (ServerConfig field đã có, validation boot đã có — chỉ thiếu main.ts); (2) các màn Profile/Connector chưa expose qua BFF (thuộc AWEB-04/05, phải theo cùng fence); (3) OIDC operator session cần `tenantId` do IdP claims map — đã có test nền tảng (`admin-oidc04-claims-tenant-offline`), live chưa chạy.

## 8. Open items / next

- Coordinator chốt: BFF dùng chung switch `DU_ADMIN_WEB` với static mount (đã chọn trong receipt này) hay tách cờ riêng `DU_ADMIN_API`?
- Platform lane: parse `tenantAdminTokens` env trong `main.ts` (blocker duy nhất của operator read live).
- AWEB-03: primitives (Antigravity) + màn Overview read-only dùng `lib/api` này; browser test 401/403/320px bổ sung sau.

## Verdict

**ACCEPTED ở tầng unit/HTTP offline**: BFF session/CSRF/envelope 26/26, fence matrix đủ 9 dòng + helper RBAC, token hygiene bundle/HTML/body, regression 0 (bằng chứng baseline), orchestrator typecheck 0, admin-web build 0. Chưa có live browser evidence và chưa có tenant token trên deployment (ghi rõ là gap, không overclaim).
