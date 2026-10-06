# PACKET 4 [P1] — SC-03 Portal Fixes & Omitted Semantics (receipt)

- **Task:** PACKET 4 [P1] SC-03 Portal Fixes: F2 duplicate DOM id, F3 stale DISABLED ref + Clear, F4 purpose filter, F8 CB omitted-means-preserve + stale spec.
- **Owner:** OpenCode 4 (`oc_4`), Portal & Admin UI.
- **Ngày:** 2026-10-06. **HEAD:** `4308cc5` (snapshot application code) + working-tree diffs chưa commit.
- **Trạng thái:** IMPLEMENTED + owner-verified offline (build exit 0, verification probe 16/16, browser suites xanh); **chưa VERIFIED độc lập / chưa UI review**; không commit/push.

## 1. Tóm tắt theo hạng mục

| Hạng mục | Tình trạng | Thay đổi chính |
|---|---|---|
| **F2** duplicate DOM id | ✅ Fixed | `CallbackPolicyEditor` nhận prop bắt buộc `idPrefix`; mọi field id đi qua `${idPrefix}-…`; `profiles-screen` truyền `profile-${rowIndex}-callback`. Không còn id trùng khi nhiều row (probe: `duplicates=[]`). |
| **F3** stale DISABLED ref + Clear | ✅ Fixed | `ValueSourceSelector` thêm `currentSecret` (metadata cho ref không nằm trong danh sách chọn) → hiển thị option/khối “configured reference” với state thật; thêm nút **Clear reference**; `stored`/`replacing`/`onRequestReplace`/`onClear` nay được callback editor nối thật (seed từ read: `configuredOnServer`/`replacing`). |
| **F4** purpose filter | ✅ Fixed | Select client secret chỉ nhận purpose `profile.callback_oauth2_client_secret`; select header chỉ nhận `profile.callback_header`; `CALLBACK_SECRET_PURPOSES` là nguồn duy nhất; secret khác purpose vẫn hiển thị nếu đang được lưu (lookup toàn bộ state) nhưng không chọn mới được. |
| **F8** omitted = preserve | ✅ Đối chiếu + Fixed UI | CB-01/CB-02: write schema `callbackPolicy: ProfileCallbackPolicySchema.nullable().optional()` (“Absent = leave unchanged; explicit null clears” — `packages/contracts/src/profile-policy.ts:298-303`), merge tại `services/orchestrator/src/modules/profiles/profiles.ts:268-276` (`null` → clear; có key → validate/write; thiếu key → carry previous). UI: bỏ tick sau khi đã có policy → gửi `callbackPolicy: null` + cảnh báo; chưa từng cấu hình → **omit** key (preserve). |
| **Stale spec SC-03** | ✅ Updated | `tests/browser/admin-web/navigation-completion.spec.ts:21` đổi locator sang aria-label thật `Orchestrator Portal Navigation`; `:23` count `15 → 16`; spec now **4/4 pass**. |

## 2. Chi tiết thay đổi

### F2 — id namespacing
- `callback-policy-editor.tsx`: prop `idPrefix: string`; áp cho mode/auth, header name/prefix, ValueSourceSelector (`${idPrefix}-header-secret-${index}`), oauth2 fields (`-token-url`, `-client-id`, `-client-auth`, `-token-lifetime`, `-scope`, `-audience`, `-resource`), `-client-secret`, `-extension-name/-value-${index}`, `-approved-origins`, `-path-prefixes`.
- `profiles-screen.tsx`: `<CallbackPolicyEditor idPrefix={`profile-${rowIndex}-callback`} … />`.
- Bỏ kiểu id “gắn giá trị” (`callback-mode-${draft.mode}`) → id ổn định theo row.

### F3 — configured/replace/clear + stale ref
- `value-source-selector.tsx`:
  - prop mới `currentSecret?: SecretOption | null`; `selected = secrets.find(...) ?? currentSecret`.
  - Khi `secretId` không có trong option list: chèn option hiện tại (`name — Secret (STATE)`) hoặc nhãn “Current reference (not in the selectable list)”; render select cả khi danh sách chọn rỗng.
  - Thêm khối cảnh báo khi ref không tra được metadata; thêm nút **Clear reference** ở nhánh edit khi `secretId !== null && onClear`.
- `callback-policy.ts`: `CallbackDraft.clientSecretConfiguredOnServer/clientSecretReplacing`; mỗi `CallbackHeaderDraft` có `configuredOnServer/replacing`; `callbackPolicyFromRead` seed `configuredOnServer=true` cho ref đọc được.
- `callback-policy-editor.tsx`: nối `stored`/`replacing`/`onRequestReplace`/`onClear` cho client secret + từng header; Clear xoá ref + cờ (validation sẽ nhắc chọn lại — không có fallback ngầm).

### F4 — purpose filter
- `CALLBACK_SECRET_PURPOSES = { header: 'profile.callback_header', oauth2ClientSecret: 'profile.callback_oauth2_client_secret' }` trong `callback-policy.ts`.
- Editor lọc `state === 'ACTIVE'` **và** purpose khớp nhánh; `currentSecret` lookup dùng danh sách đầy đủ (mọi state/purpose) nên ref đã lưu vẫn thấy; `purpose` thiếu metadata (catalog cũ) hoặc `generic` vẫn được chọn để tương thích (ghi chú chủ đích).

### F8 — omitted/preserve/clear
- `profiles-screen.tsx`: `RowDraft.callbackClearPending`, `callbackConfiguredOnServer`; seed từ `detail.policy.callbackPolicy`; uncheck khi có policy → `callbackClearPending=true`; `buildPolicy`:
  - `callbackClearPending` → `policy.callbackPolicy = null` (explicit clear);
  - có draft touched → object policy;
  - ngược lại → **không gửi key** (server carry previous).
- Cảnh báo dưới checkbox: “Saving now sends an explicit clear (`callbackPolicy: null`); an omitted key would keep the stored policy active.”

### Stale spec
- `navigation-completion.spec.ts:21` aria-label → `Orchestrator Portal Navigation` (spec-follows-app, cùng hướng với các sửa stale spec của test-owner ở `admin-web.spec.ts`/`identity-security-settings.spec.ts`).
- `:23` count → **16**.
  - **Đính chính so với audit Lane 1:** tổng link trong `<nav>` = 15 mục NAV (đã gồm Secrets) + link `Legacy shell` = **16**, không phải 14→15 như ghi chú cũ (link legacy nằm trong nav). Snapshot trước đó để `15` (14 NAV + legacy); nay cập nhật đúng thành 16.

## 3. Bằng chứng (cwd `D:\Git\dugate\du-rework`)

| # | Lệnh | Kết quả | Raw |
|---|---|---|---|
| 1 | `pnpm --filter @du/admin-web run build` | **exit 0** (tsc strict + vite) | `coordination/reports/raw/sc-03-portal-fixes-build-2026-10-06.txt` |
| 2 | Verification probe (harness thật, mock `/admin/api/secrets**` + `/admin/api/profiles**`, profile write qua stub): `node coordination/reports/raw/sc-03-portal-fixes-verify.cjs` | **16/16 PASS** — chi tiết: stored policy seed; stale DISABLED ref hiển thị tên+state; **không id trùng** (2 editor); oauth2 select chỉ có secret đúng purpose + current ref; DISABLED label giữ; Clear xoá ref + validation lên tiếng; chọn secret đúng purpose hợp lệ; uncheck gửi `callbackPolicy:null`; policy chưa cấu hình **omit** key; header select chỉ đúng purpose; save header ref thành công; không page error | `coordination/reports/raw/sc-03-portal-fixes-verify-2026-10-06.txt` + screenshots `coordination/evidence/sc-03-portal-fixes/01,02-*.png` |
| 3 | `npx playwright test --config admin-web/playwright.config.ts navigation-completion.spec.ts` (vite preview 127.0.0.1:5173) | **4/4 pass**, exit 0 | `coordination/reports/raw/sc-03-portal-fixes-browser-nav-2026-10-06.txt` |
| 4 | `npx playwright test --config admin-web/playwright.config.ts profiles.spec.ts` (harness) | **9/9 pass**, exit 0 | `coordination/reports/raw/sc-03-portal-fixes-browser-profiles-2026-10-06.txt` |
| 5 | `pnpm --filter @du/orchestrator exec jest --config jest.unit.config.cjs --runInBand tests/cb02-admission-writer.test.ts tests/cb-02-webhook-result-delivery.test.ts tests/vfy-cb01-dispatch-matrix.test.ts` | **3 suites / 38 tests pass** — CB-01/CB-02 acceptance quanh callback policy/admission | `coordination/reports/raw/sc-03-portal-fixes-cb-suites-2026-10-06.txt` |
| 6 | `pnpm --filter @du/contracts exec jest tests/profile-callback.test.ts --runInBand` | **16/16 pass** — schema/freeze CB-01 | `coordination/reports/raw/sc-03-portal-fixes-contracts-callback-2026-10-06.txt` |

## 4. Đối chiếu F8 với CB-01/CB-02 (kết luận)

- **Writer contract (CB-01):** `ProfileEndpointPolicySchema.callbackPolicy` = `ProfileCallbackPolicySchema.nullable().optional()` — docstring tại chỗ ghi rõ “Absent = leave unchanged on publish; explicit null clears it” (`packages/contracts/src/profile-policy.ts:297-304`).
- **Merge thực tế (CB-02/profiles service):** `services/orchestrator/src/modules/profiles/profiles.ts:268-276`:
  ```
  policy.callbackPolicy === null ? null
    : has('callbackPolicy') ? parseWriteCallbackPolicy(...)
    : parseStoredCallbackPolicy(previous?.callback_policy)
  ```
  → đúng semantics; đồng thời read schema trả `callbackPolicy` nullable optional (`profile-policy.ts:327-328`) để UI seed.
- **UI khớp semantics:** uncheck sau khi có policy → gửi `null` (clear tường minh, có cảnh báo); chưa cấu hình → omit (server giữ nguyên); không còn trường hợp “checkbox off nhưng policy cũ vẫn sống” do omit.
- Test cross-check: CB suites 38/38 + contracts profile-callback 16/16 (mục 3 #5/#6); probe #2 xác nhận đúng body thực gửi.

## 5. Files & SHA256 (working tree, chưa commit)

| File | SHA256 (16 đầu) |
|---|---|
| `apps/admin-web/src/features/profiles/callback-policy.ts` | `A3BE0E65613A6765` |
| `apps/admin-web/src/features/profiles/callback-policy-editor.tsx` | `4CE0E390453E6862` |
| `apps/admin-web/src/features/profiles/profiles-screen.tsx` | `62D8796BA4596F27` |
| `apps/admin-web/src/features/secrets/value-source-selector.tsx` | `09053E2BA0A15D6C` |
| `tests/browser/admin-web/navigation-completion.spec.ts` | `E8F28A7CF0502B52` |

HEAD không đổi `4308cc5`; **không commit**, không tick task row. Hai spec `admin-web.spec.ts`/`identity-security-settings.spec.ts` đang được test-owner lane khác sửa song song — receipt này không đụng vào chúng.

## 6. OPEN / giới hạn

1. Harness stub không persist policy thật; roundtrip `callbackPolicy` qua DB/profile publish cần VFY/live window (CB VFY-CB-01) — receipt này là owner evidence offline.
2. `generic`/purpose-missing secrets vẫn được chọn (tương thích catalog cũ); nếu coordinator muốn siết exact-purpose tuyệt đối, đổi `purposeMatches` thành so khớp chặt.
3. Các finding còn lại của audit Lane 1 (F5 validation gaps client, F6 vault version NaN, F7 radio a11y) **chưa nằm trong packet này** — giữ mở cho packet sau.
4. Cần chạy lại audit probes + Antigravity UI review trên build này trước cutover.
