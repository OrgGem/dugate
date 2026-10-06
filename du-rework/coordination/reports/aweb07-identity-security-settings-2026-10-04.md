# AWEB-07 — Identity / Security / Settings (BFF + UI + browser evidence)

**Packet:** aweb07-identity-security-settings · **Lane:** cc_1 (Admin UI integrator) · **Dispatch:** 2026-10-04T13:52+07:00.
**Trạng thái:** DONE. Không commit, không tick. Không chạm `components/ui/**`, `styles/**`, `app-shell/**`, `server.ts`, `main.ts`, migrations, contracts, openapi, tasks, docs.

## 1. Route / state matrix — real vs unavailable từng mục

| Màn / BFF route | Backend | Trạng thái UI |
|---|---|---|
| `GET /admin/api/crypto-config?tenantId` (mới, `bff/security.ts`) | **REAL** — `GET /api/v1/admin/crypto-config` (admin-bearer branch, view chỉ refs/previews) | ready → render view (JSON refs); viewer 403 denied; operator bị pin tenant (own credential) |
| `POST /admin/api/crypto-config` | **REAL** — apply change; BFF yêu cầu **platform admin + CSRF session**; body forward verbatim | ready → notice `Applied. Changed fields: …`; 422/403 passthrough |
| crypto khi deployment chưa compose | upstream 503 (`cryptoConfig` block absent) | **special-case trung thực**: BFF `503 CRYPTO_CONFIG_UNAVAILABLE` (không rơi vào gộp 5xx→502 vì đây là feature-flag); UI card “Crypto configuration unavailable + requires deployment action” |
| `/admin/web/identity` | session **REAL** (`/admin/api/session`); auth-mode policy **chưa có** (không có `DU_ADMIN_AUTH_MODE` wiring — LOCAL-00/03) | session card thật; auth mode hiện **`chưa managed`** + note + dòng evidence; **Users & sessions: `requires backend`** owner LOCAL/OIDC (không route list user/session) |
| `/admin/web/settings` | **Không có adapter** (staged rollout/rollback chưa tồn tại) | catalog tĩnh source/managed-by/effective, mọi dòng `requires deployment action` + hướng dẫn deploy (env/compose → restart → reload); **0 nút Save** (assert bằng test `getByRole('button', {name:/save/i}) == 0`) |
| States chung | — | loading/ready/empty/error/denied đủ (security: 503-unavailable, 403-denied, 500-error retry; identity: loading/error/denied; settings: tĩnh + cảnh báo) |
| Nav | — | Overview thêm 3 link Security/Identity/Settings (tổng 9) |

## 2. Browser evidence — **43/43 PASS**

```
ok 1..6 identity-security-settings.spec.ts:
  1. security ready + Apply change thật (notice 'Applied. Changed fields: deliveryEncryption')
  2. crypto=unconfigured → card 'Crypto configuration unavailable' + 'requires deployment action'
  3. viewer session → DeniedState
  4. identity: session thật (legacy:admin) + 'chưa managed' + 'requires deployment action'/`requires backend` users list
  5. settings: guidance + không có nút Save nào (count 0)
  6. 320px security không tràn ngang
43 passed (50.5s)   # + 37 case cũ (AWEB-01b/03b/04/05/06) regression cùng lượt
```
Screenshots `coordination/evidence/aweb07/07-01..06-*.png` (07-04 đã xem: session thật + auth-mode chưa managed + users list requires-backend).

1 bug thật do test bắt, đã sửa: `save()` set notice rồi `load()` (vốn reset notice) xoá mất — chuyển set-after-load (cùng lớp với AWEB-04/06, đã ghi nhận).

## 3. Commands literal

```
pnpm exec jest (aweb02+04+05+06+07) → 5 suites, 59 tests passed (26+10+8+7+6)   JEST=0
pnpm --filter @du/orchestrator typecheck → TSC=0
pnpm --filter @du/admin-web build  → exit 0 (2662 modules; JS 442.45 kB / gzip 139.40 kB)
npx playwright test --config admin-web/playwright.config.ts → 43 passed (50.5s)
```

## 4. File đã chạm

| File | Thay đổi |
|---|---|
| `bff/security.ts` (mới) | crypto-config GET/POST + fence + CSRF + 503 special-case |
| `bff/handle.ts` | +import/hook security (route cũ không đổi) |
| `lib/api/{types,client,index}` | `getCryptoConfig/updateCryptoConfig` (+ type CryptoConfigView) |
| `features/security/security-screen.tsx` (mới) | view + apply-change + 503-unavailable/denied |
| `features/identity/identity-screen.tsx` (mới) | session thật + auth-mode honest + users list requires-backend |
| `features/settings/settings-screen.tsx` (mới) | catalog + deploy guidance, không Save |
| `routes/{security,identity,settings}.tsx` (mới), `router.tsx`, `features/overview/overview-screen.tsx` | route + nav |
| `tests/browser/admin-web/{harness.ts,identity-security-settings.spec.ts}` | stub crypto (ok/unconfigured/error) + 6 case |
| `tests/orchestrator/tests/aweb07-bff-security.test.ts` (mới) | 6 test fence/CSRF/passthrough/503 |
| `coordination/evidence/aweb07/**` | 6 ảnh `07-*` |

## 5. Gaps backend (owner rõ)

- **Auth mode (LOCAL-00) + local overlay (LOCAL-03)**: chưa parse/mount `DU_ADMIN_AUTH_MODE` → identity screen giữ nhãn `chưa managed` cho tới khi có wiring.
- **User/session list + session revoke (LOCAL/OIDC/T-AUTH)**: chưa có route ⇒ card unavailable, không dữ liệu giả.
- **Settings deployment adapter (DEP)**: chưa có staged-rollout/rollback ⇒ không có Save; khi adapter ship, catalog chuyển sang source/desired/effective revision thật (UI đã tách sẵn khung).
- **Crypto config composition**: deployment phải compose `cryptoConfig` (ENC) mới hết 503; UI đã sẵn sàng hiển thị view + áp change khi có.

## Verdict

**ACCEPTED ở tầng BFF + browser harness**: crypto-config là real end-to-end (read + CSRF-gated write + 503-unavailable trung thực + viewer/operator fence), identity/settings là honest-unavailable đúng spec (không nút Save giả, không claim auth mode), **43/43 Playwright** (6 case mới + 37 regression), **59/59 jest**, tsc/build 0. Gaps ghi owner LOCAL/OIDC/DEP/ENC.
