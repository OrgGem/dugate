# SHELL-RED-FIX — đóng standing-red admin-shell (nav role drift + cookie posture) — 2026-10-05

**Packet:** SHELL-RED-FIX (coordinator 01:44). **Lane:** cc_3 (`term_4954d39e`). **Root-cause spec:** `connector-wire-b-bff-2026-10-05.md` §5 (CW-B, dsh_1).
**Snapshot:** 2026-10-05 01:44–02:1x +07 · HEAD `b088eececcb5f3df0b4edbe073a29401dafda624`. **Offline; không tick; không commit/push.**

## 0. TL;DR

1. **Item 1 — hướng chọn: align theo SEMANTICS MỚI của fixtures** (profiles/connectors = `admin`), sửa `view-models.ts` + mọi test expectation `operator`→`admin`. Không revert fixtures về operator (lý do ở §1).
2. **Item 2 — cookie posture: sửa TEST-side** — inject `cookiePolicy: {requireSecure:false, trustProxyProtocol:false}` (server suite qua options; mount suite qua seam additive mới trong `AdminShellAttachInput`); **`auth-dispatch.ts` 0 dòng sửa**.
3. **Phát hiện thêm 2 suite cùng họ drift chưa từng được đếm:** `admin-p6-01-shell-fixtures` (**7 fail**) + `admin-shell-render` (**2 fail**) → đã align, xanh.
4. **Kết quả:** 3 suite packet **×3 xanh (118/118, exit 0)**; bộ 6 suite (3 packet + 3 pin nav) **×3 xanh (375/375, exit 0)**; `tsc --noEmit` exit 0. Sweep 11 suite shell-adjacent: 9 pass / 1 skip / 1 fail = `admin-shell-session-lifecycle` (2 test — KHÔNG thuộc packet, không chạm; §5).

## 1. Item 1 — Nav role drift: bằng chứng + hướng chọn

Drift trước fix (3 nguồn CW-B chỉ ra + 2 nguồn cùng họ):

| Nguồn | Trước | Sau |
|---|---|---|
| `src/app/admin/p6-01-shell-fixtures.ts:226-229` (mtime 10-02, canonical nav) | profiles/connectors/grants/api-keys = **admin** | giữ nguyên; comment guard (:45-47) đồng bộ lại theo semantics mới |
| `src/app/admin/view-models.ts:54-55` (mtime 09-25) | `operator` | **`admin`** |
| `tests/admin-shell-router.test.ts:45-46` | `operator` | **`admin`** |
| `tests/admin-p6-01-shell-fixtures.test.ts:43-54` (7 case) | operator allowed/required `operator` | **denied/required `admin`** theo fixtures |
| `tests/admin-shell-render.test.ts:119-129, 189-202` (2 case) | operator+profiles như được phép | empty-state → admin; nav test operator → chỉ viewer-tier |

**Lý do chọn hướng (fixtures là nguồn, KHÔNG revert fixtures về operator):**
1. Fixtures là **nav canonical** được router/render dùng thật (`getCanonicalNavItems` tại `shell-router.ts:166`, `section-dispatch.ts:124,549`, `crypto-config-dispatch.ts:105`); view-models chỉ là projection cũ hơn (mtime 09-25 vs 10-02) và không tham gia route/render.
2. **Semantics mới admin+platform**: fence server-side của profiles/connectors là admin (connector BFF platform-admin-only — CW-B §2.2; grants/api-keys vốn đã admin) — nav không được quảng bá quyền thấp hơn fence thật.
3. Đúng chỉ đạo packet: "profiles/connectors admin+platform; khả năng chính: sửa view-models + test sang admin".

**Boundary có chủ đích:** `view-models.ts` chỉ align **role** — giữ nguyên list 5 item (không thêm `overview`/`api-keys`); lệch danh sách còn lại giữa 2 nguồn ghi ở §5 (đề xuất dedupe packet sau).

## 2. Item 2 — Login 302→503 (cookie TLS posture)

- **Root cause (xác nhận sống):** env shell thừa hưởng **`NODE_ENV=production`** (`node -e` → `{"NODE_ENV":"production"}`) ⇒ `parseCookieSecurePolicy` (`oidc-boot.ts:128-143`) trả `requireSecure=true`; TLS không chứng minh ⇒ mint **503** qua `legacyCookiePosture`/mint branch (`auth-dispatch.ts`, posture fn :185-195).
- **Fix TEST-side (đúng pattern "Tests inject directly" ở `shell-server.ts:101`):**
  - `tests/admin-shell-server.test.ts:113-122` — inject `cookiePolicy` vào options P6-01.
  - `tests/admin-shell-platform-mount.test.ts:186-197` — inject qua `attachAdminShell` config; cần 1 seam additive: `AdminShellAttachInput.config.cookiePolicy?` (`shell-server.ts:944-950`) + 1 dòng forward (`shell-server.ts:972`). Absent ⇒ hành vi byte-identical.
- **`auth-dispatch.ts`: 0 dòng sửa** ✓ (không đụng logic posture).

## 3. Edit set + post pins

| File | Hunk đã sửa | SHA-256 (20) |
|---|---|---|
| `src/app/admin/view-models.ts` | :54-55 role → admin | `9cc89ef97f277602360a` |
| `src/app/admin/p6-01-shell-fixtures.ts` | comment guard :45-47 (0 behavior) | `7e5fa4e11b9c4a062e06` |
| `src/app/admin/shell-server.ts` | attach input `cookiePolicy?` + forward (2 hunk additive) | `a3261ba2e72da28e03a6` |
| `tests/admin-shell-router.test.ts` | :45-46 → admin | `73b252ea1b28b498a996` |
| `tests/admin-shell-server.test.ts` | P6-01 inject policy; message `requires 'admin'`; profileCookie + connectorCookie → admin | `2eb16ae63787fc0c8412` |
| `tests/admin-shell-platform-mount.test.ts` | attach config + cookiePolicy; message `requires 'admin'`; P6-04 cookie → admin | `e4acfb07cbc1b83acd7b` |
| `tests/admin-view-model.test.ts` | :53 operator → viewer-tier chỉ businesses+operations | `3d287878caa2e854d6a8` |
| `tests/admin-p6-01-shell-fixtures.test.ts` | 7 case auth-guard + 2 case view/state → admin semantics | `007d064f5ab5bb76d23f` |
| `tests/admin-shell-render.test.ts` | empty-state → admin; operator-nav → viewer-tier (2 case) | `57ef4ae596e47ca35ffe` |

## 4. Evidence literal

**Baseline đỏ (tái lập, khớp CW-B §5):**
```
Test Suites: 3 failed, 3 total · Tests: 18 failed, 100 passed, 118 total · exit 1     → raw/srf-red-baseline.txt
Họ mở rộng: fixtures 7 failed / 227 passed / 234 (view-model pass)                   → raw/srf-extra-baseline.txt
            render 2 failed trong sweep (regression)                                 → raw/srf-regression.txt
```

**Sau fix — 3 suite packet ×3 (lệnh literal):**
```
npx jest tests/admin-shell-router.test.ts tests/admin-shell-server.test.ts tests/admin-shell-platform-mount.test.ts --runInBand
R1_EXIT=0 · R2_EXIT=0 · R3_EXIT=0
mỗi lượt: Test Suites: 3 passed, 3 total · Tests: 118 passed, 118 total
→ raw/srf-3suite-r1.txt, -r2.txt, -r3.txt
```

**Sau fix — bộ 6 suite (3 packet + fixtures + view-model + render) ×3:**
```
npx jest tests/admin-shell-router.test.ts tests/admin-shell-server.test.ts tests/admin-shell-platform-mount.test.ts tests/admin-p6-01-shell-fixtures.test.ts tests/admin-view-model.test.ts tests/admin-shell-render.test.ts --runInBand
R1_EXIT=0 · R2_EXIT=0 · R3_EXIT=0
mỗi lượt: Test Suites: 6 passed, 6 total · Tests: 375 passed, 375 total
→ raw/srf-6suite-r1.txt, -r2.txt, -r3.txt
```

**Typecheck:** `npx tsc --noEmit -p tsconfig.json` → **TSC_EXIT=0** (không diagnostics) → `raw/srf-tsc-final.txt`.
**Diff-check:** `git diff --check` trên 9 file → exit 0 (không lỗi whitespace).

**Sweep cuối 11 suite shell-adjacent** (`tests/admin-shell* + admin-audit-route + admin-crypto-config-wiring`):
```
PASS: router, server, platform-mount, render, auth, oidc-mount, oidc-flow-integration, audit-route, crypto-config-wiring (9)
FAIL: admin-shell-session-lifecycle (2 test — không thuộc packet; xem §5) · 1 suite skip
Test Suites: 1 failed, 1 skipped, 9 passed, 10 of 11 total · Tests: 2 failed, 1 skipped, 384 passed, 387 total
→ raw/srf-regression-final.txt
```

**Attribution (không phải regression của packet này):**
- HEAD fixtures **đã** `requiredRole:'admin'` cho profiles/connectors/grants/api-keys (`git show HEAD:…p6-01-shell-fixtures.ts` — 4 dòng admin) ⇒ 2 test render (operator+profiles) đỏ trên mọi revision kể từ khi fixtures đổi (10-02); không do fix này (view-models/fixtures/shell-server của tôi đều không tham gia đường render đó).
- `admin-shell-session-lifecycle.test.ts` (file dirty của lane khác — **không chạm**): dưới `NODE_ENV=test` còn **1** fail (`W-SEC-AUDIT-TAXONOMY-1 … default console sink`), dưới env thừa kế production **2** fail (thêm `W-SEC-COOKIE-CONFIG-1 … knobs unset` = env artifact) → `raw/srf-sessionlifecycle-nodeenvtest.txt`.

## 5. Deviations / handoff

1. **`admin-shell-session-lifecycle.test.ts` (2 fail, ngoài packet, chưa chạm):** test "knobs unset → {false,false}" không pin `NODE_ENV` nên đỏ dưới env thừa kế production (xanh dưới `NODE_ENV=test`); fail còn lại (console sink) vẫn đỏ dưới `NODE_ENV=test` → thuộc owner/lane của file (đang dirty). Đề nghị packet riêng: pin NODE_ENV hoặc inject policy trong 2 case đó + điều tra console-sink.
2. **Nav list lệch còn lại:** view-models 5 item (thiếu overview/api-keys) vs fixtures 7 item — role đã align nhưng list chưa single-source; đề xuất dedupe (view-models dùng `getCanonicalNavItems`) ở packet sau.
3. **EOL:** `admin-shell-render.test.ts` có cảnh báo LF→CRLF khi git touch (mixed EOL tích lũy từ nhiều lane) — `git diff --check` clean; không chuẩn hóa để tránh diff toàn file.
4. **Pre-existing dirty:** `shell-server.ts` đã có +430 dòng (Admin Web mount/BFF) từ lane khác trước packet này; tôi chỉ thêm 2 hunk additive ở trên.

## 6. Compliance

- Write set đúng **9 file** trong §3; **không chạm** `auth-dispatch.ts`, `apps/admin-web/**`, BFF routes, `session-lifecycle` test, hay bất kỳ file lane khác.
- HEAD `b088eece` không đổi; không commit/push/staging; không tick task/gate.
