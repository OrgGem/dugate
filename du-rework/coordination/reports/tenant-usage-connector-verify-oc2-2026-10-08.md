# Verify độc lập: tenant roster + usage 422 + connector knownIds (lane oc2, 2026-10-08)

- **Task:** verify độc lập 3 fix — tenant roster, usage 422, connector `knownIds`. Spec được dispatch với tên receipt `...-dsh2-...` rồi gửi lại với tên `...-oc2-...`; receipt này nộp theo yêu cầu mới nhất (oc2). Lane dsh2 song song có raw folder riêng (xem §5).
- **Verifier:** OC lane. **Chỉ chạy test + đọc code; KHÔNG sửa product source; KHÔNG commit, KHÔNG push.**
- **Environment:** Windows; Node **v22.16.0**; jest **30.2.0** (package `orchestrator`).
- **Revision được verify** (mtimes, không đổi trong phiên chạy): `tenant-list.ts 01:44:09`, `operations.ts 01:52:13`, `admin.ts 02:45:48`, `handle.ts 02:49:49`; test files `01:49–03:14` (08/10).
- **Kết luận nhanh: 3/3 PASS — không có test đỏ, không có fail.** Tổng các lần chạy: 9/9, 21/21 (9+12), 12/12 riêng aweb06, 53/53 connector.

## 1. Lệnh, cwd, exit code, kết quả

| # | Command (cwd `du-rework/orchestrator/services/orchestrator`) | Exit | Kết quả |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts` | **0** | 2 suites passed; **9 passed / 9 total** (2.97 s) — đúng kỳ vọng. Raw: `raw/…-oc2-…/01-tenant-list.txt` |
| 2 | … same + `tests/aweb06-bff-operations.test.ts` | **0** | 3 suites passed; **21 passed / 21 total** (3.53 s) = 9 (tenant) + 12 (aweb06). Ghi chú: spec ghi "kỳ vọng 12" cho phần thêm vào — 12 là số test của riêng aweb06 (xác nhận bằng lệnh #3); tổng hợp lệnh này là 21. Raw: `02-tenant-plus-aweb06.txt` |
| 3 | `… tests/aweb06-bff-operations.test.ts` (chạy riêng để chốt số 12) | **0** | **12 passed / 12 total** (3.05 s) — khớp "12 pass (usage 422)". Raw: `03-aweb06-alone.txt` |
| 4 | `rg -l "knownConnectorIds" orchestrator/services/orchestrator/tests/` (cwd `du-rework`) → 4 file; chạy cả 4: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/admin-connector-render.test.ts tests/admin-config-cockpit.test.ts tests/bff-connectors-actions.test.ts tests/p745-connector-management-proxy.test.ts` | **0** | 4 suites passed; **53 passed / 53 total** (3.26 s): `bff-connectors-actions` 17/17 · `p745-connector-management-proxy` 12/12 · `admin-connector-render` 16/16 · `admin-config-cockpit` 8/8. Raw: `04-connector-tests.txt`, `05-connector-results.json`, `06-connector-json-console.txt`, `07-connector-breakdown.txt` |

`rg -l` output (dùng `rg`, không `grep`):
`tests/admin-connector-render.test.ts`, `tests/admin-config-cockpit.test.ts`, `tests/bff-connectors-actions.test.ts`, `tests/p745-connector-management-proxy.test.ts`. Không có test đỏ ở bất kỳ file nào.

## 2. Coverage của các test liên quan (trích từ `--json`)

- **Usage 422 (aweb06)**: `:279` platform usage without tenantId → fail tại BFF, no upstream request; `:288` tenant usage defaults to session scope + rejects foreign tenant; `:299` usage requires from/to → **422 before upstream** + forwards tenant scope. (3 test usage chính nằm trong 12 test đã pass.)
- **Tenant roster**: 6 test codec/SQL fence (`tenant-list-cursor-codec-offline`) + 3 test BFF route (`tenant-list-bff-offline`) — như receipt verify trước, vẫn xanh nguyên.
- **Connector knownIds**: các test liên quan đã pass gồm `renders the picker when knownConnectorIds is supplied`, `list: passthrough keeps redaction; unknown connector fields FAIL CLOSED (strict DTO, never widen)`, `unknown connector action → upstream 404 ACTION_NOT_FOUND, detail dropped`, cùng các case revision/business không fallback dữ liệu khác (chi tiết `07-connector-breakdown.txt`).

## 3. Kiểm tra semantics bằng đọc code (không sửa)

### 3.1 Tenant roster — `src/modules/admin-read/tenant-list.ts:112-163` — **ĐÚNG**
- **SQL scope predicate**: `if (scope !== null) clauses.push('id = ' + bind(scope))` (`:123`); count dùng đúng `where` + tham số scope (`:153-156`) — fence nằm trong SQL, không post-filter JS.
- **Cursor opacity**: chỉ boundary id đi vào token (`encodeTenantListCursor(last.id|first.id, …)` `:150-151`); codec base64url canonical + bound `LIST_CURSOR_MAX_LEN` + UUID validation (`:50-71`) — tên tenant dài không vào token; boundary name đọc bằng scalar subquery (`:131`).
- **Backward probe**: `backwards ? DESC : ASC` + `<`/`>` (`:125-127`), cửa sổ đảo lại về display order (`:142`), quy tắc `nextExists/prevExists` giữ đúng (không tự trỏ prev về chính trang 1) (`:145-151`).
- *(Quan sát cũ mang theo: subquery boundary không kèm scope — hành vi có chủ đích, đã ghi trong `tenant-verify-independent-2026-10-08.md`; không lặp lại ở đây.)*

### 3.2 BFF `/admin/api/tenants` — `src/app/admin/bff/handle.ts:97,384-425` — **ĐÚNG**
- Route: `relative === '/tenants'` → `handleTenantRead` (`:97-99`).
- Principals: không session → **401** (`:393-396`); `unscoped` → **403** (`:398-401`); chỉ `role==='admin' && kind==='platform'` hoặc `role==='operator' && kind==='tenant_operator'` (`:402-407`); credential fail-closed 503 (`:408-416`).
- **Strip `tenantId`/`sort`**: `TENANT_PARAM_ALLOWLIST = ['limit','cursor']` (`:73`); vòng `:419-422` chỉ copy 2 param này sang upstream `/api/v1/admin/tenants` (`:418`) — mọi param khác (kể cả `tenantId`, `sort`) bị bỏ. Test BFF đã khóa đúng URL upstream.

### 3.3 Usage 422 — `src/app/admin/bff/operations.ts:199-227` (điểm `:216`) — **ĐÚNG**
- `from`/`to` thiếu → **422** trước mọi upstream (`:202-205`).
- `authorizeAuditTenantRead` (403/401 cho foreign/unknown) xử lý trước upstream (`:206-215`).
- Platform session không có `tenantId` (`scope === ''`) → **422** `'usage requires a tenantId for platform sessions'` (`:216-218`) — return trước khi `callUpstream` (`:220-224`). Không có request upstream nào trong các nhánh lỗi.

### 3.4 Connector `knownConnectorIds` — `src/http/routes/admin.ts:573-584` — **ĐÚNG**
- `knownConnectorIds: Object.keys(ctx.config.connectorBaseUrls ?? {})` (`:581`) — **chỉ key** (connector ID), không mang URL/value của map.
- `assertAdminAuth(ctx)` trước (`:574`); comment `:570-571` xác nhận "configuration values never leave this route"; nhánh thiếu management store fail-closed 503 (`:587-589`), capabilities vẫn 200 với composition booleans + ids. Không có URL/secret trong response.

## 4. Findings

- **Không có test đỏ, không fail nào bị bỏ qua.** Không sửa product source.
- Không phát hiện lỗi semantics trong 4 điểm đọc code ở §3.
- Lưu ý nhỏ (không phải fail): spec mục #2 ghi "kỳ vọng 12 pass" — con số 12 đúng cho **riêng** `aweb06-bff-operations.test.ts`; chạy gộp cùng 2 file tenant cho tổng **21** (đã chạy riêng để chốt cả hai).

## 5. Raw logs

`du-rework/coordination/reports/raw/tenant-usage-connector-verify-oc2-2026-10-08/` (7 file):
`01-tenant-list.txt` (9/9) · `02-tenant-plus-aweb06.txt` (21/21) · `03-aweb06-alone.txt` (12/12) · `04-connector-tests.txt` (53/53) · `05-connector-results.json` (jest `--json`, 53 passed/0 failed) · `06-connector-json-console.txt` · `07-connector-breakdown.txt` (per-file + test names liên quan `known`).

Lane verify `dsh2` (cùng spec, song song) giữ raw riêng tại `raw/tenant-usage-connector-verify-dsh2-2026-10-08/` — không trùng lặp file với receipt này.

## 6. Files touched

- `du-rework/coordination/reports/tenant-usage-connector-verify-oc2-2026-10-08.md` (receipt này)
- `du-rework/coordination/reports/raw/tenant-usage-connector-verify-oc2-2026-10-08/` (7 log)

Không commit, không push. Không đụng product source.
