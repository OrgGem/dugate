# Independent verification (dsh2) — tenant roster / usage 422 / connector knownConnectorIds — 2026-10-08

- **Task:** verify độc lập 3 mặt trận đã sửa: (1) tenant roster + tenant selection, (2) usage 422 cho
  platform session, (3) connector `knownConnectorIds`. Lane: **dsh2** (độc lập với lane implementation
  `tenant-selection-ui` và với receipt review `tenant-usage-connector-review-2026-10-08.md`).
- **Compliance:** chỉ đọc + chạy test/typecheck/browser. **Không sửa product source, không sửa test,
  không commit, không push, không claim DB window.** Artifact của lane này: receipt này + raw logs.
- **Scope:** `du-rework/` only.
- **Tree pin:** HEAD `df3f955` (2026-10-07 11:23:09 +0700) + working tree **dirty** (nhiều file `M`).
  Không có commit digest cho nội dung đã verify → xem §6. Mtimes nguồn liên quan: `tenant-list.ts` 01:44,
  `bff/operations.ts` 01:52, `connector-management.ts` 02:42, `admin.ts`/`usage-screen.tsx` 02:45,
  `handle.ts`/`tenant-select.tsx` 02:49 (08/10) — đều **trước** mọi lần chạy trong receipt này (04:44+).
- **Environment:** Windows; Node **v24.21.0** (đúng `engines: ">=24.21.0 <25"` của package) cho các lần
  chạy 09–12; Node v22.23.3 (PATH mặc định) cho 04–06 — **ngoài khoảng engines khai báo**, nên 04–06 chỉ
  là corroboration, 10–12 là bản chạy chuẩn. jest **30.2.0** thực cài (`node_modules/jest/bin/jest.js
  --version`; `package.json` khai báo `^29.7.0` — **lệch declared/installed**, ghi nhận, không phải FAIL
  của 3 mặt trận này), tsc 5.x, Playwright 1.63.0.
- **Method:** đọc source với file:line, rồi chạy lại suite offline + typecheck + browser spec; raw logs
  dưới `coordination/reports/raw/tenant-usage-connector-verify-dsh2-2026-10-08/` (+ `SHA256SUMS.txt`).

## 0. Kết luận ngắn (đọc kỹ phần này)

**3 hàng rào bảo mật trọng tâm: PASS** (tenant scope theo credential, usage 422 trước upstream,
connector chỉ trả ID) — bằng chứng ở §2. **Nhưng KHÔNG phải "3/3 PASS, no FAIL findings"** như receipt
review cùng ngày kết luận. Receipt này ghi **6 FAIL** (F-1..F-6), trong đó **F-1 là lỗi thật trong code**
và **F-3/F-4/F-5 là lỗ hổng coverage** khiến F-1 lọt qua. Verdict: **PASS có điều kiện — còn FAIL mở.**

- Số FAIL: **6** (1 lỗi code + 3 coverage + 1 lỗi quy trình verify + 1 sai lệch tài liệu giữa receipt).
- Không có FAIL nào là rò rỉ **hàng dữ liệu** (row) hay bypass xác thực.
- Receipt này **không tick row, không claim ACCEPTED, không claim VERIFIED** — chỉ là bằng chứng.

## 1. DANH SÁCH FAIL (ghi rõ từng cái)

### F-1 — FAIL (code, severity **LOW–MEDIUM**): subquery biên cursor **không có scope** → cross-tenant ordering oracle

- **Bằng chứng:** `orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts:131`
  ```
  cursorClause = `${clauses.length ? ' AND' : ' WHERE'} (lower(name), id) ${boundaryOp}
                  ((SELECT lower(name) FROM tenants WHERE id = ${cursorId}), ${cursorId}::uuid)`
  ```
  Scope chỉ nằm ở `clauses` (`:123` — `id = $scope`), tức **ngoài** query; subquery chỉ lọc `id = $cursorId`.
- **Chính test của repo xác nhận SQL sinh ra:** `tests/tenant-list-cursor-codec-offline.test.ts:126-127`
  assert `calls[0].sql` khớp `/FROM tenants WHERE id = \$1 AND \(lower\(name\), id\) >/` và
  `calls[0].params === [TENANT_B, TENANT_A, 3]` — **`TENANT_A` là tenant ngoài scope** vẫn được bind làm
  biên. Fake DB của test (`:54-71`) tra biên trên **toàn bộ population** (`:57`), y như PostgreSQL thật.
- **Hệ quả (đúng ngữ nghĩa SQL đang chạy):** tenant operator scope = B, gửi `cursor` trỏ tenant ngoài C →
  - `lower(B.name) > lower(C.name)` → page = `[B]`, `total = 1`
  - `lower(B.name) < lower(C.name)` → page = `[]`, `total = 1`
  
  Tức operator đọc được **1 bit thứ tự tên** của tenant mình không được phép đọc. **Không rò row/không rò
  tên**, nhưng là đọc dữ liệu ngoài tenant.
- **Đường đi tới được (reachability):** BFF cho `cursor` qua nguyên vẹn — `bff/handle.ts:73`
  (`TENANT_PARAM_ALLOWLIST = ['limit','cursor']`) + `:419-422`; route lấy scope từ credential
  (`http/routes/admin.ts:419-420`). Không cần quyền gì thêm.
- **Điều kiện khai thác:** cần **biết trước UUID** của tenant ngoài (API này không trả UUID ngoài scope:
  roster scoped, foreign → 403/empty). Vì vậy severity LOW–MEDIUM, không phải HIGH.
- **MISMATCH tài liệu ↔ code (cùng file):** doc-comment khẳng định điều ngược lại —
  `:12-14` "a tenant operator's foreign rows never leave the database";
  `:106-108` "a cursor replayed under a different scope can only ever name rows that scope already allows".
  Câu thứ hai **sai** với chính `:131`. Đây là mismatch theo `du-rework/AGENTS.md` §2.
- **Vì sao receipt review bỏ sót:** receipt review xếp đúng hiện tượng này vào §8.1 "advisory LOW" và
  verdict vẫn "3/3 PASS, no FAIL findings"; suite mới thêm sau đó (`tenant-list-cursor-codec-offline.test.ts`)
  dùng fake DB **mô phỏng lại đúng subquery thiếu scope**, nên về cấu trúc **không thể** phát hiện F-1.
- **Đóng F-1 bằng:** (a) thêm scope vào subquery khi `scope !== null`
  (`... FROM tenants WHERE id = $cursorId AND id = $scope`), hoặc (b) từ chối cursor ngoài scope mà không
  đọc tên tenant đó; (c) test hồi quy: biên là tenant ngoài, tên tenant mình xếp **trước** biên → page rỗng
  **và** không đọc tên ngoài scope. **Chưa có live-PG test** (xem F-3).

### F-2 — FAIL (chức năng/UX, severity **LOW**): overview của platform session gọi usage **không có tenantId** → luôn 422

- **Bằng chứng:** `src/app/admin/section-dispatch.ts:459` lấy `?tenantId=` từ query (free text);
  `overview-section-renderer.ts:279` render `<input name="tenantId" placeholder="All tenants">` — overview
  **không dùng `TenantSelect`** (khác 5 màn usage/api-keys/operations/secrets/security);
  `overview-section-data.ts:627,630` chỉ set `tenantId` khi `tenantId.length > 0`;
  `http/routes/public.ts:191-192` trả **422** cho admin principal thiếu `tenantId`;
  `overview-section-data.ts:738,742` biến lỗi đó thành `kind:'error'`.
- **Hệ quả:** platform admin mở overview mặc định → pane usage ở trạng thái error/unavailable; muốn xem
  phải **tự gõ UUID tenant** vào ô free-text (không có picker theo roster). Fail-closed, **không rò dữ liệu**.
- **Vì sao receipt review bỏ sót:** xếp vào §8.4 "adjacency — noted for completeness only". Với một surface
  **reachable và user-visible** nhưng hành vi hỏng mặc định, receipt này ghi là **FAIL** (không phải note).
- **Đóng F-2 bằng:** đưa `TenantSelect` (roster-backed) vào filter overview, hoặc chặn rõ ràng ở UI
  ("chọn tenant để xem usage") thay vì để upstream 422.

### F-3 — FAIL (coverage): **không có test live/real-DB** cho roster SQL và route `/api/v1/admin/tenants`

- **Bằng chứng:** `listTenantPage` chỉ được tham chiếu bởi `http/routes/admin.ts:420` và
  `tests/tenant-list-cursor-codec-offline.test.ts:121` (**fake DB in-memory**). Grep `admin/tenants` toàn
  `tests/` chỉ ra 2 suite offline: `tenant-list-bff-offline.test.ts:49` (**stub upstream**) và codec test.
  Các suite live (`admin-base-routes`, `admin-audit`, `admin-action-rbac-live`, `usage-summary`…) bị
  `jest.unit.config.cjs` loại khỏi lần chạy offline và **không** phủ route tenants.
- **Hệ quả:** scope predicate, keyset biên và count chỉ được chứng minh bằng **fake DB do chính tác giả
  viết lại theo SQL production** — đúng cơ chế đã che F-1. Theo `du-rework/AGENTS.md` §4: "offline pass
  không thay live/browser/deployment gate".
- **Đóng F-3 bằng:** 1 suite isolated-PG cho `listTenantPage` + `GET /api/v1/admin/tenants` (scope, cursor
  replay ngoài scope, clamp limit, `total` scoped).

### F-4 — FAIL (coverage): `TenantSelect` **không có test component/DOM**

- **Bằng chứng:** `tests/usage-screen-offline.cjs:10` thay component bằng mock
  (`const TenantSelect = function TenantSelectMock() {}`); mọi tham chiếu `TenantSelect` trong test đều là
  mock này. Không có render test nào.
- **Hệ quả:** các khẳng định "hiển thị **tên**, không hiển thị UUID", "trạng thái failed", sentinel
  `All tenants` (`tenant-select.tsx:89-100,136-140`) chỉ được chứng minh bằng **đọc code** + props trên mock.
- **Đóng F-4 bằng:** render test nhỏ cho nhãn tên + trạng thái failed/empty.

### F-5 — FAIL (coverage): chưa test **tenant-operator gửi `cursor` qua BFF**

- **Bằng chứng:** allowlist cho `cursor` đi qua (`handle.ts:73,419-422`) nhưng 2 case BFF
  (`tenant-list-bff-offline.test.ts:166-170`, `:186-190`) chỉ assert đường đi **không** cursor
  (`?limit=10`). Đây cũng chính là đường khai thác F-1.
- **Đóng F-5 bằng:** case operator + `cursor` trỏ tenant ngoài → assert page rỗng **và** không đọc tên ngoài scope.

### F-6 — FAIL (quy trình/evidence của lần verify trước, không phải lỗi sản phẩm)

- **Bằng chứng:** lần chạy dsh2 trước để lại **3 raw log** (`01-tenant-list.txt`, `02-tenant-plus-aweb06.txt`,
  `03-aweb06-alone.txt`, 04:44–04:45) nhưng **receipt `.md` được chỉ định không tồn tại ở đâu trong repo**
  (glob toàn workspace + quét `D:\Git` đều không có) → lần verify đó **không thể dùng làm bằng chứng**.
- **Thiếu sót khác của lần trước:** log **không ghi exit code**; **không chạy suite connector nào**;
  không typecheck; không browser test. (03 log = 9 test tenant, 21 test tenant+aweb06, 12 test aweb06.)
- **Đóng F-6 bằng:** receipt này (bảng lệnh + exit code literal ở §3) thay thế; raw log cũ giữ nguyên
  làm lịch sử.

### Không phải FAIL (cảnh báo dễ đọc nhầm — ghi rõ để không bị tính là FAIL)

| Hiện tượng trong raw log | Thực tế |
|---|---|
| Khối `node : ... NativeCommandError / RemoteException` ở **mọi** log | jest in dòng `PASS …` ra **stderr**, PowerShell bọc thành lỗi hiển thị. **Không phải test fail**; kết quả thật ở các dòng `Tests: N passed` và `EXIT=`. |
| `[admin-shell] admin web mount enabled but bundle is missing` (warn) | Môi trường test offline không có bundle admin-web đã build. **Không phải FAIL.** |
| `[admin-bff] upstream call failed` (warn) | Do chính case âm (assert 502/upstream failure) sinh ra. **Không phải FAIL.** |
| `grep` không có trong PowerShell (receipt Codex trước) | Thiếu công cụ, không phải lỗi sản phẩm. |
| `connectors-wire.spec.ts:218,220` có `.skipped` | Là assert về **số row không đọc được** của reader, **không** phải test bị skip. |

## 2. PASS — phần thực sự đạt (kèm bằng chứng)

| # | Tiêu chí | Verdict | Bằng chứng đã đọc |
|---|---|---|---|
| P1 | Scope roster lấy từ credential, không từ query | **PASS** | `admin.ts:419-420` (`authorizeAuditTenantRead(principal,'')` → `listTenantPage(db, scope===''?null:scope, …)`); `rbac.ts:71-83`: platform trả `requestedTenantId` (=''), operator trả `principal.tenantId`, foreign → **403** `:79-81`. |
| P2 | Scope là **SQL**, không post-filter JS | **PASS** | `tenant-list.ts:117-138` (`clauses.push('id = '+bind(scope))` `:123`; count dùng cùng `where` `:153-156`). Rows trả thẳng từ query. |
| P3 | Chống injection limit/cursor | **PASS** | `:83-87` parseInt + clamp 1..`ADMIN_LIST_LIMIT_MAX`; `:55-71` base64url canonical + UUID regex; allowlist `TENANT_LIST_QUERY_PARAMS=['limit','cursor']`; toán tử `>`/`<` từ boolean, không từ input. |
| P4 | BFF chỉ forward allowlist, fence 401/403 trước upstream | **PASS** | `handle.ts:73` (`['limit','cursor']`), `:398-407` (unscoped → 403), `:419-422` (chỉ copy allowlist); credential theo principal `upstream.ts:67-73`. |
| P5 | Usage: platform thiếu `tenantId` → 422 **trước** upstream | **PASS** | `bff/operations.ts:216-219` (return 422 trước `callUpstream` ở `:224`); test `aweb06-bff-operations.test.ts:279-286` assert 422 + **zero** upstream request. Phòng thủ tầng 2: `public.ts:191-192`. |
| P6 | Connector chỉ trả **ID**, không trả value/secret | **PASS** | `admin.ts:581` `knownConnectorIds: Object.keys(ctx.config.connectorBaseUrls ?? {})`; schema `.strict()` `connector-management.ts:49-56`; test bơm URL có userinfo + token (`p745…:181-184`) và assert response **không** chứa `private.example`/`do-not-leak` (`:198-199`). |
| P7 | `TenantSelect` render **tên**, không render UUID | **PASS** (source-read, xem F-4) | `tenant-select.tsx:136-140` label = `tenant.name` (+ state); value chỉ là id nội bộ `:116-122`; value không khớp roster → `null` `:89-91`. |
| P8 | usage-screen **có** dùng `TenantSelect` + khoá Load khi All | **PASS** | `usage-screen.tsx:8,89-94` (`allowAll={!tenantScoped}`), `:112-114` (Load disabled + `role="alert"`), `:46` guard auto-load. |

## 3. Lệnh, cwd, exit code (literal)

| # | Lệnh | cwd | Node | Exit | Kết quả | Raw |
|---|---|---|---:|---:|---|---|
| 04 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-bff-offline.test.ts tests/tenant-list-cursor-codec-offline.test.ts` | `orchestrator/services/orchestrator` | 22.23.3 | **0** | 2 suites / **9 passed**, 0 failed, 0 skipped | `04-tenant-list-suites.txt` |
| 05 | `… jest … tests/aweb06-bff-operations.test.ts tests/p745-connector-management-proxy.test.ts tests/bff-connectors-actions.test.ts tests/admin-config-cockpit.test.ts tests/admin-connector-render.test.ts` | nt | 22.23.3 | **0** | 5 suites / **65 passed** | `05-usage-connector-suites.txt` |
| 06 | `node orchestrator/services/orchestrator/tests/usage-screen-offline.cjs` | `du-rework` | 22.23.3 | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` | `06-usage-screen-offline.txt` |
| 07 | `pnpm exec tsc --noEmit -p tsconfig.json` | `orchestrator/services/orchestrator` | 22.23.3 | **0** | sạch (`output_bytes=0`) | `07-tsc-orchestrator.txt` |
| 08 | `pnpm exec tsc --noEmit -p tsconfig.json` | `orchestrator/apps/admin-web` | 22.23.3 | **0** | sạch (`output_bytes=0`) | `08-tsc-admin-web.txt` |
| 09 | `npx playwright test --config admin-web/playwright.config.ts admin-web/connectors-wire.spec.ts` | `tests/browser` | **24.21.0** | **0** | **17 passed** (524 ms) | `09-playwright-connectors-wire.txt` |
| 10 | (04) chạy lại | nt | **24.21.0** | **0** | 2 suites / **9 passed** | `10-node24-tenant-list-suites.txt` |
| 11 | (05) chạy lại | nt | **24.21.0** | **0** | 5 suites / **65 passed** | `11-node24-usage-connector-suites.txt` |
| 12 | (06) chạy lại | `du-rework` | **24.21.0** | **0** | PASS (như 06) | `12-node24-usage-screen-offline.txt` |

- **Không** test nào bị skip/TODO trong 6 suite đã chạy (grep `test.skip|xit|describe.skip|TODO|FIXME`
  trên đúng các file đó: 0 hit; hit duy nhất trong `tests/` là `operation-tenant-fence.test.ts:99`, ngoài scope).
- `jest.unit.config.cjs` **loại** các suite live (PG :5433/Redis :6380) — mọi suite ở bảng trên là **offline**.
  Đây là lý do F-3 tồn tại; **không** có lần chạy live nào trong receipt này.

## 4. Đính chính receipt trước

1. `tenant-usage-connector-review-2026-10-08.md` kết luận **"3/3 fixes PASS (no FAIL findings)"**. Receipt
   này **không tái lập được** kết luận đó khi F-1 (lỗi code thật) và F-3/F-4/F-5 (coverage) được tính là
   FAIL theo `du-rework/AGENTS.md` §4 ("skipped không phải pass"; offline không thay live gate). Phần
   **bảng PASS của họ vẫn đúng** — sai ở *verdict tổng* và ở việc hạ F-1 thành "advisory".
2. `tenant-verify-independent-2026-10-08.md` §5(e) ghi "`usage-screen` chưa dùng `TenantSelect`". Trên cây
   hiện tại điều này **sai**: `usage-screen.tsx:8,89-94` đã dùng `TenantSelect` (mtime 02:45 08/10). Ghi
   nhận là **thông tin cũ**, không phải FAIL của sản phẩm.
3. Lần chạy dsh2 trước: xem **F-6**.

## 5. Gate còn mở / chưa verify (trung thực)

- **Chưa** chạy live/real-DB bất kỳ suite nào (không claim DB window): roster SQL + route tenants thật,
  usage 422 trên route thật xuyên BFF → **chưa** có bằng chứng live (F-3).
- **Chưa** có browser/live E2E cho tenant roster & usage 422. Browser spec đã chạy (09) là spec **tĩnh/parse
  + wiring guard**, không boot server thật (không đọc `AWEB01B_URL`/harness).
- **Chưa** có component test cho `TenantSelect` (F-4); chưa có case operator + `cursor` (F-5).
- **Không** kiểm chứng được "commit digest" vì working tree dirty (HEAD `df3f955` ≠ nội dung đã verify).

## 6. Raw logs + integrity

`du-rework/coordination/reports/raw/tenant-usage-connector-verify-dsh2-2026-10-08/`:
`01-…`/`02-…`/`03-…` (lần chạy trước, không có exit code — xem F-6) ·
`04-tenant-list-suites.txt` · `05-usage-connector-suites.txt` · `06-usage-screen-offline.txt` ·
`07-tsc-orchestrator.txt` · `08-tsc-admin-web.txt` · `09-playwright-connectors-wire.txt` ·
`10-node24-tenant-list-suites.txt` · `11-node24-usage-connector-suites.txt` · `12-node24-usage-screen-offline.txt` ·
`SHA256SUMS.txt` (SHA-256 của 04–12).

**Ranh giới vai trò:** receipt này là **bằng chứng verify độc lập**, không phải acceptance. Lane này
**không** sửa product/test, **không** tick row, **không** claim `VERIFIED`/`ACCEPTED`, **không** reconcile
ledger — việc đó thuộc coordinator. F-1..F-6 giữ gate mở cho tới khi có owner xử lý + verify lại.
