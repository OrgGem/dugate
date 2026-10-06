# UI Frontend Audit — Lane 1 (Admin Portal Web)

- **Phạm vi:** Secret Catalog UI (SC-03) + Callback Policy Editor (CB-04) trong Orchestrator Portal: `apps/admin-web/src/**` và phần BFF liên quan `services/orchestrator/src/app/admin/bff/secrets.ts` (admin route allowlist `shell-server.ts`).
- **Người thực hiện:** OpenCode 4 (`oc_4`), UI Frontend Audit Lane 1.
- **Thời điểm / mốc:** HEAD `4308cc5` (snapshot application code) + working-tree fix `SC-04-M02` trong `bff/secrets.ts` (chưa commit). Audit ngày 2026-10-06.
- **Nguyên tắc:** KHÔNG sửa code trong lượt này. Mọi kết luận dựa trên đọc source tại chỗ + build + probe read-only trên harness thật; bằng chứng raw lưu trong `coordination/reports/raw/ui-frontend-audit-lane1-*`.
- **Verdict tóm tắt:** **CHANGES_REQUIRED (không có bằng chứng rò plaintext secret)**. Không tìm thấy đường đọc ngược plaintext/leak ra DOM; các vấn đề còn lại là correctness/a11y/validation: 1 finding HIGH **đã được lane khác sửa trong working tree** (cần regression chính thức), 3 MEDIUM, 4 LOW/INFO.

## 1. Phương pháp kiểm tra

| Hoạt động | Lệnh / cách làm | Kết quả |
|---|---|---|
| Build + typecheck UI | `pnpm --filter @du/admin-web run build` (tsc strict + vite) | **exit 0** |
| Typecheck BFF | `pnpm --filter @du/orchestrator run typecheck` | **exit 0** |
| Static review | đọc toàn bộ `features/secrets/**`, `features/profiles/callback-policy*`, `profiles/state.ts`, `lib/api/{types,client}.ts`, `bff/secrets.ts`; grep leak vectors | xem §2–§5 |
| BFF HTTP probe | harness thật + `ui-frontend-audit-lane1-bff-probe.cjs` | **12/12 PASS** |
| DOM/browser probe | harness thật + `ui-frontend-audit-lane1-dom-probe.cjs` (2 profile rows, honest-error) | **PASS + ID-COUNTS** |
| Grep leak vectors | `localStorage/sessionStorage/document.cookie/console.log/dangerouslySetInnerHTML` trong `apps/admin-web/src` | **0 match** |

## 2. Plaintext secret leak — KHÔNG phát hiện rò

| Hạng mục | Kết luận | Bằng chứng |
|---|---|---|
| Readback catalog | Read parser từ chối **toàn bộ row nếu có key `value`**; wire types không có trường value | `features/secrets/state.ts:97`; `lib/api/types.ts` (`SecretCatalogEntryRead`) |
| Managed value form | Input `type="password"`, `autocomplete="off"`, state bị reset ngay sau create/rotate thành công; notice chỉ chứa tên secret (server metadata) | `features/secrets/secrets-screen.tsx` (create/rotate handlers), probe `secrets: sentinel never re-enters the DOM`, `rotated sentinel never…` |
| Callback credentials | Chỉ có đường secret reference; `ValueSourceSelector secretOnly` nên **không có input literal** cho client secret/header credential | `callback-policy-editor.tsx:129-150,245-262`; probe `callback: secret-only selector renders no literal input` |
| Error paths | 422 của BFF project `{pointer,message}` từ Zod, không echo giá trị; response 422/rotate không mang sentinel | BFF probe: `422 response never echoes…`, `rotate 422 never echoes…` |
| Browser persistence/log | Không `localStorage/sessionStorage/cookie`, không `console.log`, không `dangerouslySetInnerHTML` | grep 0 match toàn `apps/admin-web/src` |
| DOM sau thao tác | Sentinel literal không quay lại DOM ở create/rotate và không xuất hiện trong upsert callback | probe SC-03/CB-04 (raw cũ) + DOM probe hôm nay |

**Ghi chú boundary (không phải lỗi):** literal đi qua JSON body nội bộ tới BFF/upstream — đúng user transport exception; nghĩa vụ mã hóa khi lưu thuộc SC-01/SC-02 (chưa có trong working tree). Probe xác nhận không lộ ở tầng UI/BFF response.

## 3. Findings

### F1 — HIGH (đã được lane khác sửa trong working tree; cần regression chính thức)
**`POST /admin/api/secrets` (create) từng bị chặn 405 vì dispatch sai trước fix SC-04-M02.**

- **Expected:** POST `/admin/api/secrets` → nhánh create (validate `SecretCatalogCreateSchema`, proxy `/api/v1/admin/secrets`).
- **Actual (bản trước fix, committed blob `11b4796`):** `const expectedMethod = route.kind === 'list' ? 'GET' : 'POST'; if (method !== expectedMethod) → 405`, trong khi `matchSecretsRoute('/secrets')` luôn trả `{kind:'list'}` cho cả GET/POST → nhánh `kind:'create'` **chết**, create không bao giờ chạy.
- **Current working tree:** fix `SC-04-M02` dispatch method-aware tại `services/orchestrator/src/app/admin/bff/secrets.ts:79-100`; audit BFF probe xác nhận hợp lệ: `valid create is not 405 (create dispatch reached upstream)`.
- **Gap kèm theo:** browser probe owner của SC-03 (`coordination/reports/raw/sc-03-cb-04-browser-probe.cjs`) **mock `/admin/api/secrets**` ngay tại browser** nên không chạm BFF → bug này lọt lưới evidence cũ. Đề xuất: giữ BFF probe này làm regression + bổ sung test BFF chính thức (dispatch GET/POST/rotate/disable/test + CSRF/422).

### F2 — MEDIUM: Trùng DOM `id` khi nhiều Profile row cùng mở Callback Editor
- **File:line:** `callback-policy-editor.tsx:61-64, 72-75, 189-191, 198-200, 206-208, 232-243, 333-345`; `value-source-selector.tsx:129-130` (idPrefix) và `:245-262`.
- **Expected:** id duy nhất toàn document; label/aria gắn đúng control của row.
- **Actual:** 2 row → `callback-token-url`, `callback-client-id`, `callback-client-auth`, `callback-scope`, `callback-approved-origins`, `callback-path-prefixes`, `callback-mode-*`, `callback-auth-*`, `callback-client-secret-secret`… đều xuất hiện 2 lần; `label[for="callback-token-url"]` cũng 2 lần.
- **Bằng chứng:** DOM probe `ID-COUNTS {"callback-token-url":2,...,"labelFor":2}` (raw).
- **Ảnh hưởng:** HTML invalid; label/screen-reader/focus gắn nhầm row đầu; bulk save nhiều row dễ thao tác sai field.
- **Đề xuất (chưa sửa):** truyền `idPrefix` chứa `rowIndex` (hoặc `useId`) vào `CallbackPolicyEditor` và mọi field bên trong.

### F3 — MEDIUM: Secret ref đã lưu có thể “tàng hình” và không có đường Clear
- **File:line:** `callback-policy-editor.tsx:49-52` (chỉ nạp ACTIVE), `value-source-selector.tsx:101` (`selected = secrets.find(...) ?? null`), `:225-242` (options), `callback-policy.ts:283-293` (build vẫn dùng `draft.clientSecretId`).
- **Expected:** field đã cấu hình hiển thị configured + Replace/Clear, không bao giờ “trống giả”.
- **Actual:** nếu ref trỏ secret DISABLED/REVOKED, hoặc nằm ngoài 100 item đã nạp (`profiles-screen.tsx` list `limit=100`, không phân trang), thì:
  - `<select>` không có option khớp `value=secretId` → hiển thị “Select a secret…”;
  - dòng metadata không render (`selected === null`);
  - nhưng `buildCallbackPolicy` vẫn gửi ref cũ → save “thành công” với credential operator tưởng là chưa đặt; **không có nút Clear**.
- **Phụ:** props `stored`/`replacing`/`onRequestReplace`/`onClear` (`value-source-selector.tsx:47-52,119-157`) **không được caller nào sử dụng** (grep: chỉ match trong chính component) → UX configured/replace/clear đã thiết kế nhưng chưa nối.
- **Đề xuất:** inject option “(hiện tại — disabled/ngoài trang)” khi ref không có trong list; truyền `stored`/`replacing`; thêm Clear (gửi explicit clear theo contract).

### F4 — MEDIUM: Không lọc `purpose` cho callback secrets
- **File:line:** `callback-policy-editor.tsx:49-52` (chỉ lọc `state === 'ACTIVE'`); `SecretOption.purpose` có dữ liệu nhưng không dùng.
- **Expected:** catalog phân purpose (`profile.callback_header`, `profile.callback_oauth2_client_secret` — `packages/contracts/src/secret-catalog.ts:37-45`); selector nên giới hạn theo field để tránh cấu hình sai.
- **Actual:** mọi secret ACTIVE đều chọn được cho client secret/header credential; resolver SC-02 (`PURPOSE_DENIED`) sẽ fail ở lúc delivery, không phải lúc cấu hình.
- **Đề xuất:** prop `purposeFilter`/`purposes` cho `ValueSourceSelector`; oauth2 → `profile.callback_oauth2_client_secret`, headers → `profile.callback_header`; hoặc cảnh báo mismatch rõ ràng.

### F5 — LOW: Khoảng trống validation client so với schema đã đóng băng
- `callback-policy.ts:188` chỉ check độ dài prefix, **không check CR/LF/NUL** (contract `profile-callback.ts:112-114` từ chối).
- Không check độ dài: `clientId` ≤256 (`:200` chỉ check rỗng), `scope`/`audience`/`resource` ≤512 ($\neq$ check), `additionalHeaders` contract cho phép nhưng UI không có (tùy chọn — ghi nhận).
- `:180` đếm **cả hàng trống** khi giới hạn 8 headers → hiển thị sai “at most 8” trong khi server đếm entry thực.
- Secret name regex (`^[A-Za-z0-9][A-Za-z0-9 ._/-]*$`), vault mount/path/field/namespace bounds, literal ≤64 KiB chưa validate client (server 422 là authority) — chỉ là UX.

### F6 — LOW: Tạo vault link có thể gửi version `NaN`
- **File:line:** `features/secrets/secrets-screen.tsx:155-156` `Number(draft.version)` khi input rỗng → `NaN` → `JSON.stringify` thành `null`; nút Save không disable theo version hợp lệ. Tương tự name regex/literal max chưa chặn ở client (server sẽ 422).

### F7 — LOW: WAI-ARIA radio pattern chưa đủ
- `value-source-selector.tsx:164-188`: `role="radiogroup"` + `<button role="radio">` nhưng không roving `tabindex`/arrow-key; `FormField` label `htmlFor` trỏ vào `<div>` không labelable. Tương tự nhóm provider ở `secrets-screen.tsx`. Keyboard dùng Tab qua từng nút, không theo chuẩn radio.

### F8 — LOW/INFO
- `parseSecretListPage` fail **cả trang** khi 1 row enum lạ (`features/secrets/state.ts`) — fail-closed đúng hướng nhưng giòn khi catalog thêm state/purpose mới.
- `parsePolicyRead`/`callbackPolicyFromRead` gặp `auth.method` lạ → draft null → checkbox unchecked; save sẽ **omitted** `callbackPolicy`. Cần xác nhận semantics “omitted = preserve” của CB-01/CB-02 trước khi coi là an toàn.
- Filter trong selector có thể che option đang chọn (cùng lớp F3), chỉ xuất hiện khi >8 secrets.
- Build warning chunk >500 kB (bundle 869.6 kB / gzip 217.3 kB) — warning, không phải lỗi.
- `apps/admin-web` **không có ESLint** (không có config/script); “lint” hiện chỉ là `tsc --noEmit` trong build.

## 4. Kiểm chứng tích cực (PASS)

1. **Build/TS:** admin-web build exit 0; orchestrator typecheck exit 0.
2. **BFF fences (12/12):** login/session; create thiếu CSRF → 403 `CSRF_REJECTED`; body sai → 422 `INVALID_SCHEMA`; 422 không echo sentinel; create hợp lệ không 405 (dispatch SC-04-M02 chạy); list không 401/405; `GET /test` → 405; `POST /test` ≠ 405; rotate thiếu `expectedRevision` → 422 và không echo sentinel.
3. **Honest error path:** khi upstream catalog vắng, `/admin/web/secrets` render error state, không bịa row, không page error, không plaintext.
4. **Không rò plaintext** theo §2; không có browser storage/log.

## 5. Bằng chứng raw

| File | Nội dung |
|---|---|
| `coordination/reports/raw/ui-frontend-audit-lane1-build-2026-10-06.txt` | admin-web build (exit 0) |
| `coordination/reports/raw/ui-frontend-audit-lane1-orchestrator-typecheck-2026-10-06.txt` | orchestrator typecheck (exit 0) |
| `coordination/reports/raw/ui-frontend-audit-lane1-bff-probe.cjs` + `...-2026-10-06.txt` | BFF HTTP probe 12/12 PASS (harness thật) |
| `coordination/reports/raw/ui-frontend-audit-lane1-dom-probe.cjs` + `...-2026-10-06.txt` | DOM probe: honest error + ID-COUNTS (duplicate ids ×2) |
| `coordination/evidence/sc-03-cb-04/01..04-*.png` | ảnh màn Secrets + Profile callback (owner evidence cũ, đã đối chiếu lại qua probe hôm nay) |

## 6. Giới hạn của audit

- Không chạy live DB/S3/Vault; harness + stub + mock `/admin/api/secrets` cho phần UI; BFF probe dùng stub upstream (không có admin API SC-01 thật).
- Không đánh giá runtime resolution (SC-02) hay tính mã hóa khi lưu (thuộc SC-01/02).
- Không sửa bất kỳ dòng code nào; các đề xuất ở §3 chờ owner/coordinator phân việc.

## 7. Đề xuất cho coordinator

1. Giao owner SC-03 sửa **F2/F3/F4** (duplicate ids, stale-ref UX/Clear, purpose filter) trên cùng lease `apps/admin-web/src/**`; thêm regression BFF cho **F1** (không mock ở browser).
2. Xác nhận semantics omitted/preserve của `callbackPolicy` (CB-01/CB-02) trước khi coi F8 trung tính.
3. Cập nhật test-owner cho các stale spec đã nêu trong receipt SC-03 (heading/aria-label/nav count 14→15).
4. Sau khi sửa, chạy lại 2 probe của audit này + Antigravity UI review trước cutover.
