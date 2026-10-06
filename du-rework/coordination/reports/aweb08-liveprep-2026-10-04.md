# AWEB-08-live-prep — gated live browser spec + runbook (2026-10-04)

**Packet:** aweb08-live-prep · **Lane:** cc_1 · **Dispatch:** 2026-10-04T14:23+07:00.
**Trạng thái:** DONE. **Không đổi env, không restart deployment** trong packet này. Không chạm `apps/admin-web/src/**` (không cần test-id hook — mọi locator dùng role/text/label sẵn có), orchestrator `src/**`, `.env.live` (chỉ đọc qua LIV-03 + lần này không sửa), `tasks/**`, `docs/**`. Không commit.

## 1. Live spec (gated) — `tests/browser/admin-web/live-admin-web.spec.ts`

Gate: `test.skip(!LIVE, …)` ở cấp describe với `LIVE = DU_LIVE_INFRA==='1' && AWEB_LIVE_URL` — **offline skip sạch, exit 0, không tạo file/không chạm deployment**.

Env (runbook bên dưới): `DU_LIVE_INFRA=1`, `AWEB_LIVE_URL` (vd `http://127.0.0.1:3001`), `AWEB_LIVE_TOKEN` (login token) **hoặc** `AWEB_LIVE_COOKIE` (`du_session=…` cho chạy operator/OIDC), `AWEB_LIVE_TENANT` (uuid — bật assert audit nghiêm), `AWEB_LIVE_EVIDENCE` (default `coordination/evidence/aweb08-live`, chỉ mkdir khi live).

| # | Case (live) | Assert chính |
|---|---|---|
| 1 | Session gate thật + login render | `/admin/web` unauth → 302 `/admin/login` (hoặc 200 nếu deployment cho phép); sau login → heading “Admin Web bootstrap is running” + nav |
| 2 | `/overview` dữ liệu thật theo tenant | Session card thật + “Audit ledger” ở **một trong hai trạng thái honest** (bảng rows hoặc “No audit events”) |
| 3 | `/security` | **cả hai nhánh hợp lệ**: `fingerprintPreview` (view thật) HOẶC “Crypto configuration unavailable” (503 chưa compose) |
| 4 | **Mutation thật + audit**: issue → copy-once đúng 1 lần → dismiss → reload-list có row mới → revoke → `REVOKED`; sau đó query `GET /admin/api/audit?limit=50` bằng session cookie | rawKey đúng 1 lần; revoke có hiệu lực; **khi `AWEB_LIVE_TENANT` được set** → bắt buộc thấy event `apikey.issue` trong ledger (strict); không set → chỉ assert 200 + ghi nhận (ledger platform-scope có thể rỗng — honest) |
| 5 | 320px reflow + **reload giữ session** | scrollWidth ≤ clientWidth; reload vẫn `/admin/web/overview` + Overview render |

Screenshots chỉ ghi khi chạy live: `live-01..08-*.png` trong `coordination/evidence/aweb08-live/` (offline: thư mục **không được tạo** — kiểm: chưa tồn tại sau packet này).

## 2. Runbook (user/DEP thực hiện khi muốn bật live)

**B0 — đọc trước** (không sửa trong packet này): `du-rework/.env.live` (dev runner nạp qua `node scripts/dev.cjs --env-file=.env.live`); shell ở `ADMIN_SHELL_PORT` (mặc định 3001), orchestrator JSON API 3000; docker backends của user giữ nguyên.

**B1 — health TRƯỚC khi bật**
```
curl -s  http://127.0.0.1:3000/health                      # {"status":"ok",…}
curl -sI http://127.0.0.1:3001/admin/login | head -1       # 200
curl -sI http://127.0.0.1:3001/admin/web   | head -1       # 404 (flag đang tắt — legacy nguyên trạng)
```

**B2 — bật cờ (chỉ service rework, KHÔNG đụng container user)**: thêm vào `.env.live`
```
DU_ADMIN_WEB=1
DU_ADMIN_WEB_ROUTES=overview          # bắt đầu 1 route UI_APPROVED; thêm dần sau review
# (tuỳ chọn) DU_ADMIN_WEB_DIST=<abs>/apps/admin-web/dist — mặc định cwd đã đúng khi chạy từ du-rework
```
Restart **dev runner của rework** (dừng `node scripts/dev.cjs` của rework rồi chạy lại) — không restart/không dừng docker containers.

**B3 — health SAU khi bật**
```
curl -sI http://127.0.0.1:3001/admin/web        | head -1   # 302 → /admin/login (chưa login)
curl -sI http://127.0.0.1:3001/admin/web/profiles | head -1 # 404 “Route not enabled…” (ngoài allow-list)
curl -sI http://127.0.0.1:3001/admin/login      | head -1   # 200 (legacy không đổi)
```

**B4 — chạy live spec** (từ `du-rework/tests/browser`):
```
DU_LIVE_INFRA=1 AWEB_LIVE_URL=http://127.0.0.1:3001 AWEB_LIVE_TOKEN=<shell token> \
  [AWEB_LIVE_TENANT=<uuid>] AWEB_LIVE_EVIDENCE=<abs>/coordination/evidence/aweb08-live \
  npx playwright test --config admin-web/playwright.config.ts --grep "AWEB-08 live" --output .live-output
```

**B5 — rollback (bất kỳ lúc nào)**: xoá 2 dòng cờ khỏi `.env.live` + restart dev runner rework; kiểm `/admin/web` → 404 legacy, `/admin/login` → 200; mọi route legacy `/admin/*` chưa từng bị đổi trong suốt quá trình.

**GO/NO-GO**: GO khi 5/5 live case xanh, copy-once đúng 1 lần, revoke `REVOKED`, (nếu set tenant) event `apikey.issue` có trong ledger, 320px không tràn, reload giữ session, và **không regression legacy** (B3/B5). NO-GO nếu bất kỳ route legacy 500, hoặc `/admin/web` trả trang lạ khi flag off.

## 3. Flag test bổ sung (offline)

`tests/aweb08-per-route-flag.test.ts` +1 case (tổng 7): **`DU_ADMIN_WEB_ROUTES='overview,security'` nhưng `DU_ADMIN_WEB` off → KHÔNG mount** — cả 3 path (`/admin/web`, `/overview`, `/security`) trả 404 legacy “No Admin route matches” (allow-list chỉ siết thêm cho app đã mount, không tự mount).

## 4. Offline regression (literal)

```
pnpm exec jest (aweb02+04+05+06+07+08)  → 6 suites, 66 tests passed (65 cũ + 1 case mới)   JEST=0
pnpm --filter @du/orchestrator typecheck → TSC=0
npx playwright test --config admin-web/playwright.config.ts (env mặc định, không AWEB_LIVE_*)
  43 passed
  5 skipped        # live-admin-web.spec.ts — skip sạch, exit 0, không tạo evidence dir
```

## 5. File đã chạm

| File | Thay đổi |
|---|---|
| `tests/browser/admin-web/live-admin-web.spec.ts` (mới) | live spec gated 5 case + env matrix + evidence dir chỉ khi live |
| `services/orchestrator/tests/aweb08-per-route-flag.test.ts` | +1 case (ROUTES set + flag off → không mount), tổng 7 |
| `coordination/reports/aweb08-liveprep-2026-10-04.md` | receipt này |

Không sửa `apps/admin-web/src/**` (không cần test-id hook — locator hiện có đủ), không sửa orchestrator src, `.env.live` không đổi, `docs/**`/`tasks/**` không đổi. `coordination/evidence/aweb08-live/` chưa được tạo (đúng: chỉ tạo khi live).

## 6. Blockers / notes

- Audit side-effect **strict** cần `AWEB_LIVE_TENANT` + session đọc được ledger tenant đó (operator session qua `AWEB_LIVE_COOKIE`); với legacy admin token, ledger scope rỗng là honest-empty — spec ghi rõ nhánh này, không overclaim.
- Mutation live tạo key thật rồi revoke ngay (không để lại key ACTIVE); nếu chạy nhiều lần, row mới luôn nằm đầu danh sách (prefix lạ) - spec chọn row đầu sau khi count tăng.
- Restart dev runner thuộc user (B2/B5); packet này không restart.

## Verdict

**READY-for-live**: spec live gated viết xong (skip sạch offline — literal `43 passed / 5 skipped`, exit 0), flag test bổ sung xanh (7/7), regression **66/66 jest** + tsc 0. Runbook bật/rollback chỉ chạm service rework, giữ container user; GO/NO-GO rõ. Việc bật cờ + chạy live thuộc user/coordinator khi sẵn sàng.
