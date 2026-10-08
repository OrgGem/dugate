# Tenant selection — independent verification receipt (2026-10-08)

- **Task:** verify độc lập tenant selection end-to-end (backend + BFF + UI) cho `du-rework`.
- **Verifier:** OC lane (độc lập với implementation lane `tenant-selection-ui`). **Chỉ chạy test + typecheck + đọc code; KHÔNG sửa product source, KHÔNG commit, KHÔNG push.**
- **Environment:** Windows; Node **v22.16.0** (PATH); jest **30.2.0**; TypeScript **5.9.3** (cả backend và admin-web).
- **Kết luận nhanh:** 4/4 hạng mục **PASS** — 9/9 tests pass, 2 typecheck exit 0, code review sạch. **0 lỗi chặn.** 1 lưu ý informational (OBS-1, không phải lỗi chức năng). Lưu ý về *dạng lệnh*: lệnh literal "chạy từ `du-rework/`" cần thêm `--config` (chi tiết §1).

## 1. Lệnh, cwd, exit code, kết quả

| # | Command | cwd | Exit | Kết quả |
|---|---|---|---:|---|
| 1 | `node orchestrator/services/orchestrator/node_modules/jest/bin/jest.js --runInBand tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts` | `du-rework` | **1** | 2 suites **failed to run**, 0 tests. `SyntaxError: Unexpected token, expected "from"` tại `import type` — jest rơi về Babel transform (không TS) vì cwd `du-rework` không có jest config. **Không phải lỗi test/product** (xem #2–#3). Raw: `raw/tenant-verify-independent-2026-10-08/01-jest-tenant-list.txt` |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts` | `du-rework/orchestrator/services/orchestrator` | **0** | **2 suites passed, 9 tests passed, 0 failed, 0 skipped** (`Time: 3.772 s`). Raw: `02-jest-service-dir-unit-config.txt` |
| 3 | `node orchestrator/services/orchestrator/node_modules/jest/bin/jest.js --config orchestrator/services/orchestrator/jest.unit.config.cjs --runInBand tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts` | `du-rework` | **0** | **2 suites passed, 9 tests passed** — bản "chạy từ `du-rework`" hoạt động khi chỉ định rõ config. Raw: `03-jest-du-rework-with-config.txt` |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/... --json --outputFile=.../07-jest-results.json` | service dir | **0** | `numPassedTests: 9`, `numFailedTests: 0` — danh sách 9 test ở §2. Raw: `07-jest-results.json`, `08-jest-json-console.txt` |
| 5 | `npx tsc --noEmit` (tsc 5.9.3) | `du-rework/orchestrator/services/orchestrator` | **0** | Sạch — output rỗng. Raw: `04-tsc-backend.txt` (0 byte) |
| 6 | `npx tsc --noEmit` (tsc 5.9.3) | `du-rework/orchestrator/apps/admin-web` | **0** | Sạch — output rỗng. Raw: `05-tsc-admin-web.txt` (0 byte) |
| 7 | `node node_modules/jest/bin/jest.js --version` | service dir | **0** | `30.2.0` |

Ghi chú #1: config đúng là `orchestrator/services/orchestrator/jest.unit.config.cjs` (`preset: ts-jest`, `roots: <rootDir>/tests`). Không có thay đổi sản phẩm nào để "làm cho lệnh chạy"; đây thuần là vấn đề cwd/config-resolution của jest.

## 2. Danh sách 9 test đã pass (từ `--json`, trạng thái `passed` từng test)

**Suite `tenant-list cursor codec and SQL fence (offline)` — 6 tests:**
1. round-trips tenant id and **next** direction
2. round-trips tenant id and **prev** direction
3. keeps a long tenant name out of the bounded opaque cursor
4. reuses a cursor under a new scope while fencing rows and count to that scope
5. clamps parsed limits to 1 and ADMIN_LIST_LIMIT_MAX
6. returns null without throwing for forged non-UUID cursors

**Suite `GET /admin/api/tenants BFF route` — 3 tests:**
7. denies anonymous and non-admin viewer sessions before upstream
8. platform session uses platform bearer, sees all rows, forwards pagination, and drops tenantId/sort
9. tenant operator uses its tenant bearer and receives only its tenant row

## 3. Code review (read-only) — kết luận từng file

### 3.1 `orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts` — **PASS**
- **SQL scope predicate**: scope đến từ credential, gắn vào SQL (`if (scope !== null) clauses.push('id = ' + bind(scope))` — `:117-123`); count query dùng cùng `where` và cùng tham số scope (`:153-156`). Rows/count đều bị fence trong DB, không filter bằng JS.
- **Injection**: mọi giá trị đi qua `bind()` → placeholder `$n` (`:119-122, 130-133`); `ORDER BY` lấy từ boolean → literal `ASC|DESC` (`:126-127, 136`); không nội suy input nào vào SQL. Không thấy đường injection.
- **Cursor codec**: `encodeTenantListCursor` chỉ chứa uuid + hậu tố `|p` (`:50-52`); `decodeTenantListCursor` kiểm charset base64url, độ dài ≤ `LIST_CURSOR_MAX_LEN` (128), canonical round-trip, UUID pattern, chuẩn hoá lowercase (`:55-71`) — forged/`long name` cursor trả `null` (được test #3/#6 khóa).
- **Parser**: allowlist `TENANT_LIST_QUERY_PARAMS = ['limit','cursor']` (`contracts/public-api.ts:623`), limit clamp 1..`ADMIN_LIST_LIMIT_MAX`, cursor hỏng → 422 (`:79-98`).
- **OBS-1 (informational, không chặn)**: boundary subquery tại `:131` — `(SELECT lower(name) FROM tenants WHERE id = $cursorId)` — **không kèm scope predicate**, tức boundary name của tenant khác có thể được đọc khi replay cursor dưới scope mới. Đây là *hành vi có chủ đích* (test #4 khóa việc "reuse cursor under a new scope"); rows và count vẫn fence đúng, nên tối đa chỉ còn một "ordering oracle" lý thuyết (cần biết UUID tenant khác). Không phải lỗi chức năng; ghi cho owner cân nhắc.

### 3.2 `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts` — **PASS**
- Mount `GET /admin/api/tenants` → `handleTenantRead` (`:97-100`).
- **Platform fence**: thiếu session → 401 (`:393-396`); principal `unscoped` → 403 (`:398-401`); chỉ cho `role==='admin' && kind==='platform'` hoặc `role==='operator' && kind==='tenant_operator'` (`:402-407`).
- **Credential tách biệt**: `credentialFor` (`upstream.ts:67-73`) → platform dùng `runtime.adminToken`, tenant_operator dùng token tenant (own-entries scan, fail-closed `null` → 503) — không có chuyện operator mượn platform token.
- **Query isolation**: `TENANT_PARAM_ALLOWLIST = ['limit','cursor']` (`:73`); chỉ 2 param này được copy sang upstream (`:419-422`) — `tenantId`, `sort` và mọi param lạ bị bỏ; test #8/#9 assert đúng URL upstream (`?limit=10&cursor=...` và `?limit=10`) + đúng bearer.
- Không log token/cookie; relay nguyên response (`:423-424`), `cache-control: no-store` được test #8 assert.

### 3.3 `orchestrator/apps/admin-web/src/components/ui/tenant-select.tsx` — **PASS**
- **Load error handling**: loop phân trang `limit=100`; `!result.ok` → clear list + `loadState='failed'` (`:56-62`); guard cursor lặp bằng `Set` → failed (`:65-74`); guard unmount `active` (`:49,77-86`); UI failed hiện placeholder "Tenant list unavailable" + `role="alert"` (`:96-97,148`); control `disabled` khi chưa ready (`:124`).
- **Không leak UUID**: option label render `tenant.name` (+ `(state)` khi non-ACTIVE) (`:137-141`); `id` chỉ là `value` nội bộ của `SelectItem`/`SelectRoot` (`:116-122`); nếu `value` không khớp row đã load → map về `null` (hiện placeholder), không render id (`:89-91`). `SelectValue` = `BaseSelect.Value` (`select.tsx:8`), render label của item đang chọn.
- `allowAll` báo `null` qua `ALL_TENANTS_VALUE` sentinel (`:13,118-119`). Types client `TenantRow {id,name,state}` / `TenantPage` 5 trường khớp wire (`lib/api/types.ts:38-51`).

### 3.4 `orchestrator/services/orchestrator/src/http/routes/admin.ts` — **PASS**
- Route `GET /api/v1/admin/tenants` (`:413-431`): `resolveAdminPrincipal` null → **401** (`:414-417`); **scope lấy từ credential** qua `authorizeAuditTenantRead(principal, '')` (`:419`) — không nhận tenant nào từ query; response `listPage({items,nextCursor,prevCursor,total,limit})` (`:421-430`); wire item chỉ `{id,name,state}` qua `toTenantWire`.
- NOTE tại `:403-412` giải thích `''` = platform "không narrowing" (roster toàn bộ) — khớp `rbac.ts:71-83`: platform trả nguyên `requestedTenantId` (=''), tenant_operator trả `principal.tenantId`, foreign tenant → 403.
- `resolveAdminPrincipal` (`rbac.ts:30-58`): platform token + tenant tokens dùng **own-entries + constant-time**, chống prototype-chain/proto-pollution.

## 4. Findings

- **Không có lỗi chặn / lỗi chức năng nào được phát hiện.** Không sửa file nào (đúng yêu cầu read-only).
- **OBS-1 (informational, low):** xem §3.1 — boundary subquery không scope; hành vi được test khóa có chủ đích; rows/count vẫn fence. Đề xuất owner cân nhắc thêm scope vào subquery nếu muốn đóng hẳn kênh thông tin thứ tự; **không tự sửa**.
- **OBS-2 (về dạng lệnh, không phải sản phẩm):** lệnh literal trong yêu cầu verify cần chạy từ thư mục service hoặc thêm `--config ...jest.unit.config.cjs` (đã chạy cả hai dạng, đều pass 9/9).

## 5. Giới hạn coverage (trung thực)

- 9 test này phủ: cursor codec + SQL keyset/fence (tầng module, fake DB) và BFF route (HTTP thật ở shell server + **stub upstream**), gồm các fence auth/role/query.
- **Chưa** phủ: (a) DOM/component test cho `TenantSelect` — UI chỉ được verify bằng đọc code + typecheck; (b) HTTP xuyên BFF → **route admin thật** (BFF test dùng stub; route được verify bằng đọc code + typecheck); (c) browser/live end-to-end; (d) case tenant-operator gửi `cursor` qua BFF (code cho phép forward nhưng không có test case); (e) `usage-screen` chưa dùng `TenantSelect` (theo receipt implementation — TODO thuộc owner khác).
- Không có thay đổi sản phẩm/test nào trong suốt verify: mtimes của 6 file nguồn/test (`01:44`–`03:14`, ngày 08/10) đều **trước** phiên verify này (`03:44+`).

## 6. Raw logs

`du-rework/coordination/reports/raw/tenant-verify-independent-2026-10-08/`:
`01-jest-tenant-list.txt` (lệnh literal, exit 1) · `02-jest-service-dir-unit-config.txt` · `03-jest-du-rework-with-config.txt` · `04-tsc-backend.txt` (rỗng) · `05-tsc-admin-web.txt` (rỗng) · `06-jest-verbose.txt` (summary) · `07-jest-results.json` (9 passed, đủ test names) · `08-jest-json-console.txt`.

**Files touched bởi lane verify:** chỉ receipt này + raw logs trên. Không commit, không push.
