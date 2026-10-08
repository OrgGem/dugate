# F-2 fix — Overview dùng tenant picker roster-backed (server-rendered shell) — 2026-10-08

- **Task:** sửa F-2 (từ receipt `tenant-usage-connector-verify-dsh2-2026-10-08.md` §F-2): overview ở
  surface `/admin` thật (server-rendered shell) dùng **ô free-text `tenantId`**, không roster-backed; khi
  `tenantId` rỗng thì vẫn gọi usage → upstream **422** (`http/routes/public.ts:191-192`).
- **Quyết định phạm vi (user chốt):** phương án **A** — roster-backed `<select>` **ngay trong shell**;
  **không** sửa `apps/admin-web/**` (React `OverviewScreen`), **không** làm phương án C.
- **Compliance:** KHÔNG commit, KHÔNG push, KHÔNG chạm `docs/21-openapi.json`, KHÔNG claim DB window
  (không chạy suite live nào). Scope: `du-rework/` only.
- **Lease đã dùng (đúng 5 file):**
  - `orchestrator/services/orchestrator/src/app/admin/overview-section-data.ts` (M)
  - `orchestrator/services/orchestrator/src/app/admin/overview-section-renderer.ts` (M)
  - `orchestrator/services/orchestrator/tests/admin-overview-render.test.ts` (M — 1 assertion)
  - `orchestrator/services/orchestrator/tests/admin-overview-triage.test.ts` (M — 2 assertion)
  - `orchestrator/services/orchestrator/tests/f2-overview-tenant-select-offline.test.ts` (**NEW**)
  - Receipt này + raw logs. **Không file nào khác bị lane này sửa.**
- **Kiểm chứng "không chạm" (mtime, mốc phiên này ≈ 04:44+ ngày 08/10):**
  - `orchestrator/apps/admin-web/**`: **0 file** có mtime > 04:00 (mọi file `M` ở đó là dirty sẵn của lane
    tenant/usage/connector trước, mtime 02:42–02:49).
  - `docs/21-openapi.json`: mtime **03:06:23** — trước phiên này, **không** bị lane này sửa (vẫn đang `M` sẵn).
  - Chỉ 2 file nguồn trong `src/app/admin/` được ghi trong phiên: `overview-section-data.ts` (05:10),
    `overview-section-renderer.ts` (05:11).
- **Tree pin:** HEAD `df3f955` + working tree dirty. Hai file nguồn của lane này **sạch trước khi sửa**
  (đã kiểm: `git diff HEAD` chỉ chứa đúng các hunk của F-2) → có baseline đối chứng ở §6.
- **Environment:** Windows; Node **v24.21.0** (`engines: ">=24.21.0 <25"`), jest **30.2.0**, tsc 5.x.
- **Raw logs + `SHA256SUMS.txt`:** `coordination/reports/raw/f2-overview-tenantselect-2026-10-08/`.

## 1. Chẩn đoán đã hiệu chỉnh (quan trọng hơn mô tả F-2 ban đầu)

Trong receipt verify tôi ghi F-2 là "pane usage hỏng". Đọc kỹ loader thì **hỏng cả trang**:

- `overview-section-data.ts` gọi `requestJson(usageUrl)` **vô điều kiện** trong `Promise.all`, kể cả khi
  `tenantId` rỗng; 422 của upstream đi qua `parseUsageSummary` → `{ error }` → `return { kind: 'error' }`
  ⇒ **toàn bộ bundle** (usage + audit + health + triage) bị bỏ, chỉ còn pane `overview-section--error`.
- Doc-comment `OverviewFetcherInput.tenantId` ghi *"Empty → loader skips usage + audit"* — **trước fix là
  SAI** (code không skip). Fix này làm câu đó thành đúng (MISMATCH được đóng, không phải sửa doc cho khớp bug).
- Thêm một điểm coverage: React `apps/admin-web/.../overview-screen.tsx` **không có filter tenant và không
  gọi usage** (usage là tile "requires backend"), nên F-2 **chỉ** tồn tại ở shell — đúng như user đã hiệu chỉnh.

## 2. Fail-first (giữ cả log đỏ và xanh)

Suite mới: `tests/f2-overview-tenant-select-offline.test.ts` (offline, `fetchImpl` inject, không listener/DB).

| Bước | Lệnh (cwd `orchestrator/services/orchestrator`) | Exit | Kết quả | Raw |
|---|---|---:|---|---|
| **RED** (trước khi sửa code) | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/f2-overview-tenant-select-offline.test.ts` | **1** | **6 failed / 6** — đỏ vì *assertion thật*, không phải lỗi biên dịch: `placeholder="All tenants"` vẫn render; không có `<select name="tenantId"`; `countOf(calls,'/api/v1/usage') === 1` khi tenant rỗng (đúng gốc 422); không có `data-overview-tenant-required` | `01-fail-first-RED.txt` |
| GREEN (sau khi sửa) | cùng lệnh | **0** | **11 passed / 11** | `03-f2-full-GREEN.txt` |

Bản RED chạy trên file chỉ chứa 6 case hành vi (chỉ dùng export đã tồn tại) để cái đỏ là **assertion**, không
phải "module has no exported member". Sau khi `fetchTenantOptions` tồn tại, tôi **thêm 5 case** cho reader
roster vào cùng file rồi chạy lại — 11/11 xanh. Log đỏ và xanh đều được giữ nguyên.

## 3. Fix đã làm gì

### 3.1 `overview-section-data.ts`

- **Không gọi usage/audit khi chưa chọn tenant** (`fetchOverviewCore`):
  `tenantRequired = tenantId.length === 0`; `Promise.all` dùng `Promise.resolve(null)` cho usage/audit;
  parse cũng bỏ qua; guard `usage !== null && 'error' in usage`. Health + 3 operation-count vẫn đọc
  platform-wide **y như trước**. Kết quả ok mang `tenantRequired: true`.
- **Đọc roster**: `fetchTenantOptions({jsonBaseUrl, adminToken, fetchImpl, timeoutMs})` — **fail-closed**:
  thiếu token/base URL, transport throw, non-2xx, body không đọc được ⇒ trả về options đã đọc (rỗng ở trang
  1), **không throw, không trả message/body/stack của upstream**. Trang roster dùng `limit=ADMIN_LIST_LIMIT_MAX`
  (200), đi theo `nextCursor` tối đa 10 trang, có `Set` chặn cursor lặp. Row thiếu `id` **hoặc** `name` bị
  **loại** (không bao giờ render id trần làm nhãn).
  - **Scope:** reader dùng đúng credential mà route `GET /api/v1/admin/tenants` vốn dùng (bearer admin của
    shell); route lấy scope qua `authorizeAuditTenantRead` ⇒ tenant operator chỉ nhận **row của mình**,
    reader này không thể mở rộng scope. Không có tham số tenant nào từ query đi vào request roster.
- **Gắn roster vào kết quả**: `fetchOverview` = wrapper chạy song song `fetchOverviewCore` +
  `fetchTenantOptions` rồi `switch` theo `kind` để gắn `tenantOptions` vào **cả 4 nhánh** (ok/empty/
  unauthorized/error) — nhờ vậy picker render được ở mọi pane, kể cả pane lỗi.

### 3.2 `overview-section-renderer.ts`

- `renderOverviewFilters` đổi `<input name="tenantId" placeholder="All tenants">` →
  `<select name="tenantId" aria-label="Tenant">` với option đầu `value=""` nhãn **`Select a tenant`**, các
  option sau là **tên tenant** (`Beta (SUSPENDED)` khi state ≠ ACTIVE); id chỉ là `value`.
- **Fail-closed khi roster rỗng/lỗi:** option placeholder được đánh `selected` **khi tenant hiện tại không có
  trong roster** ⇒ submit form không thể âm thầm trỏ sang tenant khác, và **không** hiển thị UUID trần.
- Khi `ok.tenantRequired === true`: render
  `<p class="overview-section__tenant-required" data-overview-tenant-required="true">Select a tenant</p>`
  và **không** render bảng usage/audit; đồng thời bỏ luôn câu "No overview data is currently available"
  (tránh thông điệp mâu thuẫn).
- Không cần CSS mới: `.overview-section__filters select` đã được style sẵn (`shell-render.ts:597,685`), và
  các paragraph empty-state khác (`__usage-empty`, `__audit-empty`) cũng không có CSS riêng.

### 3.3 HTML thực tế sau fix (trích từ log xanh)

```html
<select name="tenantId" aria-label="Tenant">
  <option value="">Select a tenant</option>
  <option value="11111111-1111-4111-8111-111111111111" selected>Alpha</option>
  <option value="22222222-2222-4222-8222-222222222222">Beta (SUSPENDED)</option>
</select>
```

## 4. Lệnh + exit code (literal)

| # | Lệnh | cwd | Exit | Kết quả | Raw |
|---|---|---:|---|---|
| 01 | `… jest … tests/f2-overview-tenant-select-offline.test.ts` (pre-fix) | `services/orchestrator` | **1** | 6 failed / 6 | `01-fail-first-RED.txt` |
| 02 | cùng lệnh (sau fix code, 6 case) | nt | **1** | 5 passed / 1 failed — **lỗi ở chính test của tôi** (bảng usage rỗng không có `data-usage-tenant`); đã sửa stub trả 1 row | `02-f2-behavioural-GREEN.txt` |
| 03 | cùng lệnh (11 case) | nt | **0** | **11 passed / 11** | `03-f2-full-GREEN.txt` |
| 04 | `… jest …` 5 suite overview liên quan | nt | **1** | 3 failed — 2 call-count (6→7 do thêm request roster) + 1 regex `selected` quá rộng; xem §5 | `04-related-overview-suites.txt` |
| 05 | `… jest …` 6 suite overview + F-2 | nt | **0** | **6 suites / 423 passed** | `05-related-overview-suites-GREEN.txt` |
| 06 | `… jest …` 4 suite shell (`admin-shell-server`, `admin-shell-platform-mount`, `admin-crypto-config-shell`, `admin-crypto-config`) | nt | **0** | **4 suites / 189 passed** | `06-shell-suites.txt` |
| 07 | `… jest … --config jest.unit.config.cjs` (**toàn bộ offline suite**) | nt | **1** | 11 suite failed / 12 skipped / 215 passed; 102 failed / 105 skipped / 4993 passed — **toàn bộ là lỗi có sẵn**, chứng minh ở §6 | `07-full-offline-suite.txt` |
| 08 | `pnpm exec tsc --noEmit -p tsconfig.json` | `apps/admin-web` | **0** | sạch (`output_bytes=0`) — chạy dù **không** chạm file admin-web nào | `08-tsc-admin-web.txt` |
| 09 | 11 suite đang fail, chạy **với 2 file nguồn của tôi revert về HEAD** | `services/orchestrator` | **1** | **đúng 11 suite / 102 test failed như #07** → lỗi có sẵn | `09-baseline-11-failing-suites.txt` |
| 10 | 8 suite focused, sau khi restore | nt | **0** | **8 suites / 516 passed** | `10-restored-focused-set-GREEN.txt` |
| 11 | `pnpm exec tsc --noEmit -p tsconfig.json` | `services/orchestrator` | **0** | sạch (`output_bytes=0`) | `11-tsc-orchestrator-final.txt` |

## 5. Ba assertion cũ phải cập nhật — nói rõ, không giấu

| File:line | Trước | Sau | Lý do |
|---|---|---|---|
| `tests/admin-overview-render.test.ts:347` | `calls.length === 6` | `=== 7` + assert **đúng 1** request `/api/v1/admin/tenants` | Overview giờ đọc thêm roster. Assertion **vẫn pin số request chính xác** (7), không nới lỏng; thêm vế thứ hai để chỉ rõ request mới là gì. |
| `tests/admin-overview-triage.test.ts:80` | `calls).toHaveLength(6)` | `7` + assert 1 request tenants | Như trên. |
| `tests/admin-overview-triage.test.ts:574` | `expect(html).not.toMatch(/<option[^>]*\bselected/)` (toàn trang) | scope vào **`<select name="timeRange">`**: `const timeWindow = /<select name="timeRange"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? ''` | Ý định gốc là "preset lạ ⇒ không option nào của **time window** được selected". Trước đây chỉ có 1 select nên regex toàn trang là đủ; F-2 thêm select thứ hai (tenant picker) mà placeholder của nó **hợp lệ** khi roster không chứa tenant hiện tại. Assertion mới **giữ nguyên ý định** và chặt hơn (chỉ soi trong select timeRange). |

Không có assertion nào khác bị sửa. `__probe-c63.test.ts`, `admin-overview-view-model.test.ts`,
`admin-list-contract-conformance.test.ts`, `adm-base-03-safe-error-offline.functional.test.ts`,
`admin-shell-*.test.ts` **pass nguyên trạng**.

## 6. Full offline suite đỏ 11 suite — chứng minh là lỗi có sẵn (không phải do F-2)

Chạy #07: **11 suite failed / 102 test failed**. Danh sách:
`admin-audit-mount`, `admin-audit-query`, `admin-error-boundary-offline`, `admin-operations-sort`,
`admin-operations-sort-http-offline`, `admin-operations-sql`, `admin-shell-session-lifecycle`,
`artifact-read-authorization`, `enc-meta-sentinel-runtime-refs`, `public-upload-encryption-gateway`,
`v1-boot-typed-denial`.

Hai chứng cứ độc lập:

1. **Grep:** không suite nào trong 11 suite trên tham chiếu `overview` / `fetchOverview` /
   `renderOverviewSection` / `tenantOptions` (0 hit). Thay đổi của tôi chỉ nằm trong 2 file overview.
2. **Baseline thực nghiệm (#09):** backup 2 file nguồn của tôi → `git checkout HEAD --` đúng 2 file đó
   (hash xác nhận đã revert) → chạy **đúng 11 suite** → **11 failed / 102 failed tests**, y hệt #07 →
   `finally` copy bản backup trở lại (hash xác nhận restore). Suite focused sau restore: 8/8 xanh (#10).

⇒ 102 test đỏ đó thuộc các subsystem khác (audit mount/query, operations sort/SQL, encryption/artifact,
boot denial) và **đã đỏ trước F-2**. Không tick, không sửa — báo lại cho coordinator.

## 7. Chưa làm / còn mở (trung thực)

- **Chưa có live/browser test** cho picker này: không claim DB window, không chạy suite live; browser spec
  hiện có là spec tĩnh/parse, không boot server. Gate live vẫn mở.
- **Không** sửa React `apps/admin-web/src/features/overview/overview-screen.tsx` (theo yêu cầu): tile
  "Usage rollup … not exposed by the platform BFF yet" ở đó **đã lỗi thời** (route BFF `/admin/api/usage`
  tồn tại) — để lại làm follow-up riêng, không thuộc F-2.
- **Cùng dạng lỗi còn ở surface khác (chưa sửa, ngoài lease):**
  `src/app/admin/api-key-section-renderer.ts:263` vẫn render ô free-text
  `<input id="apiKeyTenantId" name="tenantId" type="text" maxlength="64" required>` cho form cấp API key.
  Cần một task riêng nếu muốn roster-backed.
- Không cập nhật `docs/28-test-inventory.md` / `docs/35-acceptance-baseline.md` (không nằm trong lease;
  owner tài liệu nên bổ sung suite mới `f2-overview-tenant-select-offline.test.ts`).
- Không commit, không push: thay đổi nằm nguyên ở working tree cho coordinator quyết định.

## 8. Ranh giới vai trò

Receipt này là **báo cáo thực thi + bằng chứng**, không phải acceptance. Lane này không tick row, không
claim `VERIFIED`/`ACCEPTED`, không reconcile ledger. F-2 chỉ nên được coi là đóng khi có **verify độc lập**
trên bản code này (và, nếu gate yêu cầu, một lần chạy live/browser trong DB window).
