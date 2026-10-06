# AWEB-04 — Profile vertical slice (wire freeze + BFF fence + UI + browser evidence)

**Packet:** aweb04-profile-slice · **Lane:** cc_1 (Admin UI integrator) · **Dispatch:** 2026-10-04T12:31+07:00.
**Trạng thái:** DONE ở tầng wire-freeze + BFF + UI + browser (backend T-API-01..03 **chưa ship** — mọi hành vi backend-thiếu hiển thị honest, không mock giả). Không commit, không tick. `shell-server.ts` mtime 11:49 — **không đổi**; `components/ui/**`, `styles/**`, `app-shell/**`, `server.ts`, `main.ts`, migrations, contracts, openapi, tasks, docs không chạm.

## 1. WIRE FREEZE (tạm thời, chờ T-API-01..03 xác nhận)

**Profile read** — giữ nguyên base body đang có của `admin.ts:444-455`, bổ sung additive:

```
GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName   (BFF: /admin/api/profiles/…)
{
  schemaVersion: '1',
  businessId, businessVersion, profileName,      // 'new' sentinel → server echo '' (giữ nguyên)
  revision: number,                              // 0 = placeholder hiện tại; real sau T-API-01
  currentValues: Record<string, unknown>,
  manifest: { actions: [{ name?, action?, slots?: [{key, value, isLocked}] }] },
  capabilities: string[],                        // [] hôm nay; ['publish','rollback','testEndpoint'] sau T-API-01
  endpoints: ProfileEndpointPolicy[],            // additive (rỗng hôm nay)
  effective: Record<string,unknown> | null       // T-UI-03 preview; null = "requires backend"
}
ProfileEndpointPolicy = { endpointSlug, enabled, parameters: Slot[], jobPriority: LOW|MEDIUM|HIGH,
                          allowedFileExtensions /*CSV*/, connectionsOverride: ConnectionStep[],
                          fileUrlAuthConfigured?: true }
ConnectionStep = { slug, stepId?, captureSession?, injectSession? }   // đúng legacy PAR-12
```

**Profile mutations** — tất cả qua dispatcher (single-writer), BFF forward `POST /api/v1/admin/actions`:

```
profile.upsert   params { businessId, businessVersion, profileName, expectedRevision?, policy }
                 policy = { endpointSlug, enabled, parameters: { key: { value } } (CHỈ unlocked; locked bị bỏ hẳn),
                            jobPriority, allowedFileExtensions, connectionsOverride,
                            fileUrlAuthConfig? { mode, header, secret } }   // write-only, mã hóa server-side T-PROF-04
profile.publish  params { businessId, businessVersion, profileName, expectedRevision }   // CAS bắt buộc
profile.rollback params { businessId, businessVersion, profileName, targetRevision, expectedRevision? }
prompt-override.upsert params { connectionId, apiKeyId, endpointSlug, stepId (default '_default'),
                                promptOverride, isActive }               // §PAR-13 key-4
POST /admin/api/profiles/test-endpoint → POST /api/v1/admin/profile-test-endpoint   (T-UI-06, passthrough)
```

**Role matrix (T-UI-05, CHỈ Profile routes)**: admin/platform → đọc + ghi (CSRF bắt buộc khi ghi); tenant_operator → **đọc bằng token tenant của chính mình** (không platform bypass), ghi → 403 `PROFILE_SCOPED_GATE`; viewer/scoped → đọc 403 `PROFILE_SCOPE_GATE` (chờ assignment T-AUTH-03/VFY-LOCAL). **Error taxonomy**: `PROFILE_LOCKED_FIELD` (400, kể cả same-value), `REVISION_CONFLICT` (409 → giữ draft), `INVALID_SCHEMA` (422), `CSRF_REJECTED` (403), `PROFILE_SCOPE_GATE`/`PROFILE_SCOPED_GATE` (403), `NOT_FOUND`/`ACTION_NOT_FOUND` (backend chưa ship). Fixture chung: harness `profiles.spec.ts` + `aweb04-bff-profiles.test.ts`.

## 2. BFF (nền AWEB-02) — file mới `bff/profiles.ts`, helpers tách `bff/upstream.ts`

- Tách proxy helpers sang `bff/upstream.ts` (credential theo principal, tenant map đảo, `callUpstream`/`relayUpstream`, writers no-store) — không nhân bản logic; `handle.ts` chỉ còn routing + route cũ (session/audit/api-keys/connectors/actions) + hook 1 khối cho profiles.
- `profiles.ts`: read proxy (viewer gate/tenant credential) + upsert/publish/rollback qua dispatcher + `test-endpoint` passthrough; validation fail-closed (422) — publish **bắt buộc** `expectedRevision`, rollback bắt buộc `targetRevision`; mọi mutation yêu cầu CSRF + admin.
- Fence matrix đã kiểm bằng jest (10/10): anonymous 401; viewer read 403 `PROFILE_SCOPE_GATE` **upstream untouched**; operator read → `Bearer <tenant-token>` (không phải adminToken); operator mutation 403 không chạm upstream; admin thiếu CSRF 403; admin upsert → forward đúng action/params/bearer/idempotency; publish/rollback validation; path segment hỏng → 404; test-endpoint operator 403/admin passthrough; hygiene không token trong body.

## 3. UI `features/profiles/**` (map theo plan)

| Task | Đã làm | Evidence |
|---|---|---|
| T-UI-02 | Form/matrix: toggle enabled; priority select; CSV extensions; parameters theo slot — **locked readonly+disabled+`data-locked="true"`+badge**; `fileUrlAuthConfig` write-only (mode/header/secret, không prefill, gửi-1-lần); ConnStep list (slug/stepId/caps); prompt override key-4 textarea | ảnh 04-02/04-05 |
| T-UI-03 | Preview card chỉ render khi `effective` có thật; mặc định “Preview requires backend” | ảnh 04-01 |
| T-UI-04 | Save-all: **1 POST/endpoint + Promise.allSettled** + per-row OK/FAILED hiển thị, không rollback chung | ảnh 04-06 |
| T-UI-06 | Modal Test Endpoint gọi route gated; chưa ship → 404 honest trong modal (tách follow-up, không half-claim) | ảnh 04-08 |
| 409/400 | Banner `409 · REVISION_CONFLICT` + hint giữ draft; `400 · PROFILE_LOCKED_FIELD` + hint | ảnh 04-04/04-05 |
| Gating | `capabilities=[]` (placeholder thật hôm nay) → Save/Publish/Rollback/Test disabled + badge “policy backend not shipped” | ảnh 04-01 |

3 bug thật do test bắt, đã sửa trong lane: (1) screen quên bootstrap `getSession()` → thiếu CSRF (403); (2) dùng `detail.profileName` (echo `''` cho sentinel `new`) làm path segment → mutation 404; chuyển sang identifiers chụp lúc load; (3) `load()` reset notice/rowResults → thông báo bị xoá ngay sau khi set; chuyển set-after-load.

## 4. Browser evidence — **30/30 PASS**

```
ok 22..30 profiles.spec.ts (9 case): placeholder honest; writer-missing 404 + draft kept + locked slot;
  save-ok → revision 8 persisted; 409 conflict; 400 locked; bulk partial (extract OK / compare FAILED);
  viewer denied (T-AUTH-03 reason); test-endpoint 404 in modal; 320px reflow
30 passed (34.7s)   # + 6 AWEB-01b + 7 overview + 8 api-keys/connectors (regression cùng lượt)
```
Screenshots: `coordination/evidence/aweb04/04-01..09-*.png` (ảnh 04-03 đã xem: notice saved + **revision 8** + row `extract: OK — saved (revision 8)`).

## 5. Commands literal

```
pnpm --filter @du/admin-web build                         → exit 0 (2648 modules; JS 413.64 kB / gzip 133.57 kB)
npx playwright test --config admin-web/playwright.config.ts → 30 passed (34.7s)
pnpm exec jest tests/aweb02+aweb04+aweb05 (--runInBand)    → 3 suites, 44 tests passed (26+10+8)
pnpm --filter @du/orchestrator typecheck                   → TSC=0
```

## 6. File đã chạm + boundary

| File | Thay đổi |
|---|---|
| `bff/upstream.ts` (mới), `bff/types.ts` (mới) | tách helpers proxy/credential dùng chung (refactor từ handle) |
| `bff/profiles.ts` (mới) | toàn bộ route + fence Profile |
| `bff/handle.ts` | routing hook + import (không đổi hành vi route cũ; aweb02/aweb05 suites xanh) |
| `apps/admin-web/src/lib/api/{types,client,index}.ts` | Profile types + 5 method |
| `apps/admin-web/src/features/profiles/{state,profiles-screen}.tsx` (mới) | screen + parser + error hints |
| `apps/admin-web/src/routes/profiles.tsx` (mới), `router.tsx`, `features/overview/overview-screen.tsx` | route + link |
| `tests/browser/admin-web/{harness.ts,profiles.spec.ts}` | stub profile + 9 case |
| `tests/orchestrator/tests/aweb04-bff-profiles.test.ts` (mới) | 10 test fence/forwarding |
| `coordination/evidence/aweb04/**` | 9 ảnh profiles (+ ảnh các spec khác cùng lượt chạy) |

Boundary note: `bff/handle.ts` là shared BFF route — đã được lane này giữ từ AWEB-02/05 và dispatch cho lease “bff Profile routes”; thay đổi ở đây là **tối thiểu** (import + 1 hook + refactor sang upstream.ts, hành vi cũ chứng minh bằng 2 suite cũ xanh). Lane khác vẫn đang sửa `api-key-section-*.ts` (mtime 15:06 trước đó) — không chạm.

## 7. Gaps / next (owner rõ)

- **T-API-01..03 (backend lane)**: khi ship, gỡ `revision:0`/`capabilities:[]` là UI tự bật (không cần sửa thêm — gate đã theo capability).
- **T-PROM-01/02**: prompt-override UI đã có, hiện 404 honest; khi dispatcher có action là chạy.
- **T-AUTH-03/VFY-LOCAL**: scoped-user + viewer read mở sau receipt VFY-LOCAL (fence đã sẵn 2 nhánh).
- **T-UI-03/T-UI-06**: preview + test-endpoint cần backend tương ứng (đã ghi follow-up, không claim).
- Chưa có live evidence (PG/Redis/worker) cho profile — thuộc T-TST-01..06 backend.

## Verdict

**ACCEPTED ở tầng wire-freeze + BFF fence + browser harness**: 30/30 Playwright (9 case Profile: placeholder honest, writer-missing 404 + draft kept, save-ok persisted revision 8, 409/400 giữ draft, bulk allSettled per-row, viewer denied, test-endpoint gated 404, 320px), 44/44 jest 3 suite (fence + regression), build/typecheck 0. Wire freeze ghi rõ là **tạm thời chờ T-API-01..03**; các hành vi backend-chưa-ship đều là trạng thái honest, không mock giả.
