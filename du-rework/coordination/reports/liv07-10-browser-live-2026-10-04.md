# LIV-07..10 — Playwright Live Admin UI verify (cc_2)

**Packet:** liv07-10-browser · **Lane:** cc_2 (command-code) · **Dispatch:** 2026-10-04T00:47+07:00 (coordinator command-code).
**Nguồn:** plan LIVE-TEST (LIV-07..10); spec `du-rework/tests/browser/tests/live-admin-e2e.spec.ts` (3 scenario: LIV-08/09/10).
**Mode:** chạy nguyên trạng spec — **không sửa test/source; không restart service; không stop container; không tick; không commit; không chạm `nocobase-10`**. File ghi duy nhất: receipt này.

**TL;DR:** **6/6 PASS (26.0s), exit 0** trên live stack (Admin Shell 3001). Không có failure ⇒ không phát sinh mục chẩn đoán login. 4 screenshot live mới + report JSON; đã mở 2 ảnh xác nhận render thật (không trắng). **1 phát hiện về lệnh trong plan:** lệnh literal `pnpm --filter @du/browser-tests test -- …` là **no-op false-green** (exit 0, không chạy test nào) — lệnh thực đã dùng là fallback `npx playwright test …`; ngoài ra 1 **observation** UI (connector degradations "Unavailable") ghi ở §5.

## 1. Runbook (literal — cwd `D:\Git\dugate\du-rework\tests\browser`)

| Bước | Lệnh | Exit | Kết quả |
|---|---|---:|---|
| Chromium | `npx playwright install chromium` | 0 | không in gì (đã có sẵn); cache `chromium-1243` + `chromium_headless_shell-1243` trong `%LOCALAPPDATA%\ms-playwright` |
| Lệnh literal theo plan | `pnpm --filter @du/browser-tests test -- tests/live-admin-e2e.spec.ts` | **0** | **KHÔNG chạy test nào** — output rỗng (exit 0 kiểu false-green). Nguyên nhân: `package.json` của `@du/browser-tests` **không có script `test`** (chỉ `smoke`, `browser:smoke`, `lint`) ⇒ pnpm no-op im lặng trong môi trường này |
| **Lệnh thực đã dùng (fallback)** | `npx playwright test tests/live-admin-e2e.spec.ts` | **0** | chạy đủ 6 test (xem §2) |

Service đã kiểm tra trước khi chạy (read-only): `http://127.0.0.1:3001/admin/login` → **HTTP 200**; `http://127.0.0.1:3000/` → 404 (không có route gốc, service sống); `http://127.0.0.1:8091/` → 401 (connector sống, cần auth).

## 2. Kết quả chạy (literal output)

```
Running 6 tests using 1 worker

  ok 1 [desktop] › tests\live-admin-e2e.spec.ts:46:7 › Live Admin Web UI Tests › LIV-08: Admin Authentication & Overview Page (4.8s)
  ok 2 [desktop] › tests\live-admin-e2e.spec.ts:80:7 › Live Admin Web UI Tests › LIV-09: API Key Management & Connector Pane (2.5s)
  ok 3 [desktop] › tests\live-admin-e2e.spec.ts:105:7 › Live Admin Web UI Tests › LIV-10: Operations Triage & Detail View (1.5s)
  ok 4 [mobile] › tests\live-admin-e2e.spec.ts:46:7 › Live Admin Web UI Tests › LIV-08: Admin Authentication & Overview Page (6.5s)
  ok 5 [mobile] › tests\live-admin-e2e.spec.ts:80:7 › Live Admin Web UI Tests › LIV-09: API Key Management & Connector Pane (2.3s)
  ok 6 [mobile] › tests\live-admin-e2e.spec.ts:105:7 › Live Admin Web UI Tests › LIV-10: Operations Triage & Detail View (1.8s)

  6 passed (26.0s)
RUN_EXIT=0
```

Report JSON (`artifacts/playwright-report.json`): `{"expected":6,"unexpected":0,"skipped":0,"flaky":0,"duration":26031ms}` (startTime `2026-10-03T17:49:48Z`). LIV-08 bao gồm axe scan (desktop+mobile) với `critical` violations = 0.

## 3. Login — nhánh nào đã chạy (không có mục chẩn đoán vì PASS)

- Trang live `/admin/login` (curl) có các field: `name="token"`, `name="redirect"` — **không có** `username`/`password` ⇒ **token mode**.
- Spec do đó rơi vào nhánh token: `input[name="token"]` + giá trị `process.env.ADMIN_TOKEN || 'du-live-admin-token-secret-32b'`. Shell này **không set `ADMIN_TOKEN`** (`$env:ADMIN_TOKEN` = False) ⇒ token **mặc định `du-live-admin-token-secret-32b` đã được admin shell live chấp nhận**.
- Bằng chứng phiên đăng nhập: screenshot overview hiển thị header "Admin — Role: Admin — Sign out" (§4).
- Nhánh form `admin`/`Admin@123456` (local mode): **không tồn tại field để exercise** trên stack này (page không có username input) — ghi nhận, không phải failure của packet.

## 4. Artifacts (tên | mtime | bytes) — `du-rework/tests/browser/artifacts/`

| File | mtime (2026-10-04) | Bytes |
|---|---|---:|
| `live-admin-overview.png` | 00:50:08 | 247,139 |
| `live-api-keys.png` | 00:50:11 | 73,636 |
| `live-connectors.png` | 00:50:12 | 69,518 |
| `live-operations-list.png` | 00:50:14 | 269,190 |
| `playwright-report.json` | 00:50:14 | 9,701 |

Lưu ý kỹ thuật: 4 tên file là cố định trong spec, 2 project (desktop → mobile, workers=1) **ghi đè cùng tên** ⇒ nội dung PNG cuối = project **mobile** (viewport 390 CSS, DPR 2.625 → ảnh ~1024px rộng, fullPage).

Đã mở kiểm tra trực tiếp (vision):
1. **`live-admin-overview.png`** — trang đã đăng nhập: header "Admin / Role: Admin / Sign out", nav đầy đủ (Businesses, Operations, Overview active, Profiles, Connectors, Grants, API keys, Audit Log); "Operational triage" có số liệu live (FAILED OPERATIONS **1**, TIMED OUT 0, PENDING/ACTIVE **3**, STALLED DISPATCHES 0 + "Integrity OK"). ⇒ **không trắng**, login + overview + live data thật.
2. **`live-operations-list.png`** — bảng operations live **9 dòng**: các state SUCCEEDED / **FAILED** (1: `cec607df…`) / ACCEPTED / RUNNING (2), filter State/Sort/Tenant/ID + pagination "9 of 9 operations", page-size 20/50/100. ⇒ render thật.

(2 ảnh còn lại `live-api-keys.png`, `live-connectors.png` có size 69–74KB — không mở, không claim nội dung.)

## 5. Observations (không thuộc quyền fix của packet — không sửa gì)

1. **Plan command false-green:** dòng lệnh literal trong plan (`pnpm --filter @du/browser-tests test -- …`) trả **exit 0 nhưng không chạy test nào** (package không có script `test`). Đề xuất coordinator sửa plan sang `npx playwright test tests/live-admin-e2e.spec.ts` (hoặc `pnpm --filter @du/browser-tests exec playwright test …`) để tránh tái diễn exit-0-no-op.
2. **UI note (không được spec assert):** trên overview, panel "CONNECTOR DEGRADATIONS" hiển thị **"Unavailable — Network error contacting the platform. Details redacted (see server log)"**; connector 8091 trả 401 khi không auth. Spec không assert phần này nên không ảnh hưởng PASS; nêu để coordinator/product biết (có thể là connector health source chưa cấu hình cho shell hoặc platform fetch lỗi redacted).
3. **Dữ liệu live có thật:** thấy 1 operation FAILED + 3 PENDING/ACTIVE — nếu cần điều tra vận hành, có thể đối chiếu id trong ảnh `live-operations-list.png`.

## 6. Ranh giới & không chứng minh

- Không sửa bất kỳ test/source nào; chạy nguyên trạng spec 2 project desktop+mobile; không restart service; không stop container.
- Không chứng minh: nhánh form-login local mode (không tồn tại trên stack), nội dung 2 ảnh không mở (`live-api-keys`, `live-connectors`), hành vi sau đăng nhập với **local user seed** (ngoài phạm vi spec/stack).
- Không tick gate nào; không commit. HEAD không đổi.
