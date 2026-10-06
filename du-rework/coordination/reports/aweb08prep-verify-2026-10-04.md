# AWEB-08-prep — Independent verify per-route flag (cc_2)

**Packet:** aweb08prep-verify · **Lane:** cc_2 · **Dispatch:** 2026-10-04T14:23+07:00 (spec `coordination/dispatch-specs/2026-10-04-1423-AWEB08prep-verify.md`).
**Mode:** READ-ONLY — không sửa source/test/plan; không commit. File ghi: receipt này (+ temp scratchpad; script tạm đã xoá). Harness đã tắt.
**Đối tượng:** `reports/aweb08prep-per-route-flag-2026-10-04.md` (cc_1).

## 0. TL;DR — VERDICT: `VERIFIED`

- Jest 6 suite: **65/65** (26+10+10+7+6+6) `JEST_EXIT=0`; `tsc` **0**; build **0** (2662 modules).
- Adversarial semantics tự viết: **9/9 PASS** — đúng toàn bộ ma trận env (vắng/blank/partial/unknown/`,`) + assets không gate + mount off + escape `<script>`.
- Playwright default env (flag vắng): **43 passed**, 5 **skipped** (live suite AWEB-08 gated — xem §4), `PW_EXIT=0`, chạy `--output` riêng ⇒ **default behavior không đổi**.
- Không có finding cần `CHANGES_REQUIRED`.

## 1. Re-derive (literal)

```
cwd: du-rework/services/orchestrator (NODE_ENV=test)
> pnpm exec jest --runInBand tests/aweb02… tests/aweb04… tests/aweb05… tests/aweb06… tests/aweb07… tests/aweb08-per-route-flag.test.ts
per-suite: aweb02=26 · aweb04=10 · aweb05=10 · aweb06=7 · aweb07=6 · aweb08=6  → TOTAL 65/65 PASS
JEST_EXIT=0
> pnpm exec tsc --noEmit -p tsconfig.json
TSC_EXIT=0

cwd: du-rework
> pnpm --filter @du/admin-web build
✓ 2662 modules transformed. ✓ built in 17.05s   BUILD_EXIT=0
```

## 2. Adversarial semantics — 9/9 PASS (script riêng, env set/restore từng case, cookie session thật)

| # | Case | Kết quả |
|---|---|---|
| W1 | env vắng | mọi path (`/admin/web`, `/overview`, `/profiles`, deep `a/b/c`) **200 + `id="root"`** (hành vi trước AWEB-08) |
| W2 | env blank (`'   '`) | như vắng — 200/200 |
| W3a | allow-list `overview,security` | route trong list (kể cả deep) **200**; root 200 |
| W3b | route ngoài list | **404 document nhất quán** ("Route not enabled on this deployment") + link `href="/admin"` + `no-store` (2 path khác nhau cùng template) |
| W3c | **assets không bị gate** | hashed asset (`/admin/web/assets/index-D5FjAyVz.js`) **200 + immutable** dù routes bị giới hạn |
| W4 | `overview,bogus` | tên lạ bị bỏ, phần còn lại áp dụng: overview 200 / profiles 404 |
| W5 | `,` | chỉ shell root reachable: root **200**, overview **404** (fail-closed) |
| W6 | mount off (`DU_ADMIN_WEB` vắng, không inject) | **404 legacy nguyên trạng**, không có marker gate |
| W7 | `/admin/web/%3Cscript%3Ealert(1)%3C%2Fscript%3E` | **404 + escape đúng** (`&lt;script&gt;`), không phản chiếu raw `<script>` |

`SUMMARY 9/9 PASS`, exit 0. *(Ghi chú trung thực: lần chạy đầu của tôi FAIL toàn bộ 302 vì script thiếu cookie session — lỗi assertion của tôi, đã thêm cookie `du_admin` mint bằng `signCookie` rồi chạy lại; không phải lỗi sản phẩm.)*

## 3. Spot-check `file:line` (đối chiếu receipt §1)

| Claim trong receipt | Đo thực tế | Kết quả |
|---|---|---|
| `parseAdminWebRoutes` :402-421 | **:425-444** (dời +23 do các edit khác trong cùng file trước receipt) | khớp nội dung, lệch số dòng |
| gate trong `handleAdminWebRequest` :611-632 | **:621-642** (dời +10) | khớp nội dung, lệch số dòng |
| `escapeHtmlText` :477-485 | **:478-485** | ✓ |
| mount giữ `routes` :317-330, :423-470 | type `routes` **:329**; `ADMIN_WEB_ROUTE_NAMES` **:335**; `resolveAdminWebMount` **:446-471**; `routes = parseAdminWebRoutes(...)` **:457** | tương đương |

## 4. Playwright — default behavior không đổi

```
cwd: du-rework/tests/browser (env flag vắng; harness riêng)
> npx playwright test --config admin-web/playwright.config.ts --output=<scratchpad>\aw08-pw-out
Running 48 tests using 1 worker — 43 passed, 5 skipped (51.9s)     PW_EXIT=0
```
- 43 passed = đúng 43 case cũ (01b/03b/04/05/06/07) — default behavior KHÔNG đổi khi `DU_ADMIN_WEB_ROUTES` vắng.
- 5 skipped = `live-admin-web.spec.ts` (suite “AWEB-08 live — Admin Web on du-live (gated)”, mới thêm, gate theo hạ tầng live — ngoài phạm vi prep này; ghi nhận, không claim).

## 5. Bundle hygiene

`du_test_copy_once_raw_key_9f2c` = 0 · `aw08v-tenant-a-token` = 0 · `change_me` = 0 (dist hiện tại).

## 6. Race / giới hạn / verdict

- **Race:** `shell-server.ts` ổn định suốt lượt đo (mtime **14:14:07**, không đổi trước/sau); dist = build của chính lượt verify; các suite khác không bị chạm.
- **Giới hạn:** offline/HTTP seam (không live); 5 case live suite được skip có chủ đích; rollout thực tế vẫn chờ UI_APPROVED review #2 + evidence live từng route (đúng như receipt gốc nói — packet này chỉ verify cơ chế flag).
- **`VERIFIED`** — 65/65 jest, tsc 0, build 0, 9/9 adversarial semantics (gồm escape + assets-not-gated + fail-closed `,`), 43/43 case cũ xanh với flag vắng, hygiene sạch. Claim “default behavior không đổi” có bằng chứng độc lập.

*Không tick, không commit; script tạm đã xoá khỏi repo.*
