# Independent verification — tenant roster + usage 422 (DSH lane) — 2026-10-08

**Packet:** independent verification for `du-rework` (tenant roster + usage 422), requested by the user.
**Vai trò:** verifier độc lập, read-only trên product source. **Không sửa product source, không commit, không push.**
**Scope:** `du-rework` only. **Không** claim ACCEPTED, **không** tick ledger, **không** reconcile task row.
**Tree:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5` (branch `codex/fix-workflow-builder`), working tree DIRTY
(nhiều file của các lane khác đang mở). Bằng chứng dưới đây đọc trên working tree hiện tại, không phải trên HEAD sạch.
**Môi trường:** Windows, Node **v22.23.3** (workspace khai báo `>=24.21.0 <25` → engine warning, không chặn run).
**cwd mọi lệnh jest:** `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`
(packet ghi `orchestrator/services/orchestrator`; trên đĩa đường dẫn thật nằm dưới `du-rework/` —
`D:\Git\dugate\orchestrator` **không tồn tại**).
**Raw evidence:** `coordination/reports/raw/tenant-verify-dsh-2026-10-08/` (log + `RESULTS.txt` + `SHA256SUMS.txt`).
Log jest gốc là UTF-16LE kèm ANSI escape; đã re-encode UTF-8 và strip ANSI (nội dung text không đổi).

---

## 1. Lệnh bắt buộc của packet — PASS

```powershell
# cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent `
  tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts
```

| Kết quả | Giá trị |
|---|---|
| exit code | **0** |
| Test Suites | 2 passed, 2 total |
| Tests | **9 passed, 9 total** (kỳ vọng của packet: 9 pass) |
| Time | 2.649 s (elapsed 3177 ms) |
| Raw | `step1-tenant-tests.log` |

→ **ĐẠT đúng kỳ vọng 9 pass.**

## 2. Test cho tenant UUID query param (bước grep + chạy thêm)

**Bằng chứng grep:** `grep -rln 'tenants\|TenantList' orchestrator/services/orchestrator/tests/ | head`
→ tương đương đã chạy bằng content search của harness: **48 file** `.ts` khớp (dump: `grep-tenant-hits.txt`).
Vì `head` phụ thuộc thứ tự duyệt của grep, lane này chạy **cả hai** tập: (2a) các suite offline trực tiếp pin
tenant-UUID-param + usage 422, và (2b) tập offline chạy được của 10 file đầu theo thứ tự alphabet.

### 2a. Nhóm offline trực tiếp — 8/8 exit 0, 115 passed

| File (config `jest.unit.config.cjs`) | exit | Tests |
|---|---|---|
| `tests/usage-drilldown.test.ts` | 0 | 10 passed / 10 |
| `tests/usage-contracts-integration-offline.test.ts` | 0 | 19 passed / 19 |
| `tests/usage-aggregation.test.ts` | 0 | 2 passed / 2 |
| `tests/admin-list-contract-conformance.test.ts` | 0 | 23 passed / 23 |
| `tests/admin-audit-scope.test.ts` | 0 | 21 passed / 21 |
| `tests/aweb06-bff-operations.test.ts` | 0 | 12 passed / 12 |
| `tests/oidc03-role-action-tenant-offline.test.ts` | 0 | 17 passed / 17 |
| `tests/admin-oidc04-claims-tenant-offline.test.ts` | 0 | 11 passed / 11 |

### 2b. Tập offline của grep-head-10

| File | exit | Tests | Ghi chú |
|---|---|---|---|
| `admin-actions-vault04-offline.functional.test.ts` | 0 | 24 passed | |
| `admin-overview-view-model.test.ts` | 0 | 193 passed | |
| `admin-crypto-config.test.ts` | 0 | 84 passed | |
| `aweb02b-tenant-token-env.test.ts` | 0 | 8 passed | |
| `admin-operations-sort-http-offline.test.ts` | **1** | **29 failed, 3 passed / 32** | **FAIL — xem F1** |
| `admin-keyset-explain.test.ts` | 0 | 13 skipped, 5 passed | gate `DU_LIVE_INFRA=1` (:62-65) → **skip ≠ pass** |
| `admin-local-users-migration.test.ts` | 0 | 1 skipped | gate `DU_LOCAL01_LIVE_MIGRATION=1` (:11-12) → **skip ≠ pass** |
| `admin-action-rbac-live.test.ts`, `admin-audit.test.ts`, `admin-error-boundary.test.ts` | — | — | live DB-window suite, bị `jest.unit.config.cjs` ignore; lane không giữ window nên không chạy |

### 2c. UI harness tenant picker

```powershell
node tests/usage-screen-offline.cjs        # exit 0
```
`PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock`
(`usage-screen-offline.log`).

### 2d. Live probe ngoài packet (không claim DB window)

`tests/usage-summary.test.ts` với `jest.config.cjs` → **exit 0 nhưng 1 suite skipped, 10 tests skipped**:
toàn bộ suite nằm trong `liveDescribe` gate `DU_LIVE_INFRA=1` (:143-149). **SKIPPED KHÔNG PHẢI PASS** —
nơi duy nhất pin 422 cho `/api/v1/usage/summary` (missing/đảo window, :286-295) **chưa được thực thi** trong lane này.

---

## 3. Đọc code xác nhận semantics (bước 3)

### 3.1 `src/modules/admin-read/tenant-list.ts:112-163` — ĐẠT cả 3 điểm

| Yêu cầu | Kết luận | Bằng chứng |
|---|---|---|
| Scope predicate là SQL, không JS filter | **ĐẠT** | `:123` `if (scope !== null) clauses.push(\`id = ${bind(scope)}\`)` → tham số bind, vào `WHERE` (`:134`); count cũng scope (`:153-156` `WHERE id = $1`). Rows trả thẳng từ `db.query` (`:139-141`), **không có filter JS sau fetch**. |
| Cursor opacity — chỉ boundary ID, name resolve qua subquery | **ĐẠT** | `encodeTenantListCursor` `:50-52` = `base64url(uuid)` (+`\|p` cho prev), **không nhúng name**; decode strict canonical + `UUID_PARAM_PATTERN` (`:55-71`). Boundary name lấy bằng **scalar subquery** `(SELECT lower(name) FROM tenants WHERE id = $n)` (`:131`), id bind lại `$n::uuid`. Token luôn ≤ `LIST_CURSOR_MAX_LEN` kể cả tenant name rất dài (test `tenant-list-cursor-codec-offline.test.ts:100-109`). |
| Backward probe DESC rồi reverse về ASC display order | **ĐẠT** | `:125-127` `backwards = cursor.direction === 'prev'` → `scanOrder='DESC'`, `boundaryOp='<'`; `:136` `ORDER BY lower(name) DESC, id DESC`; `:142` `pageRows = window.slice().reverse()`; quy tắc cursor tồn tại `:148-151` (`nextExists = backwards ? cursor!==null : hasMore`) **khớp bản mẫu dùng chung** `keyset.ts:152-156,166,172,184-187`. |

Phụ: `parseTenantListQuery` `:79-98` allow-list `['limit','cursor']`; `limit` clamp `1..ADMIN_LIST_LIMIT_MAX`
(`:83-87`); cursor sai → **422** `INVALID_SCHEMA` (`:93-95`); **tham số lạ (`tenantId`, `sort`) bị BỎ QUA, không 422**
(đúng chủ ý allow-list, xem 3.3/F4).

### 3.2 `src/app/admin/bff/handle.ts` — route `GET /admin/api/tenants` — ĐẠT

| Yêu cầu | Kết luận | Bằng chứng |
|---|---|---|
| Nhận cả platform (adminToken) **và** tenant_operator (credentialFor) | **ĐẠT** | Dispatch `:97-100`; auth `:402-407` `platformAdmin = role==='admin' && principal.kind==='platform'`, `tenantOperator = role==='operator' && principal.kind==='tenant_operator'`, còn lại 403 trước upstream (`:398-401` viewer/unscoped); credential `:408` `credentialFor(principal, runtime)` → `upstream.ts:67-73`: platform → `runtime.adminToken`, tenant_operator → `credentialForTenant(runtime.tenantAdminTokens, tenantId)`. |
| Strip `tenantId`/`sort` | **ĐẠT** | `TENANT_PARAM_ALLOWLIST = ['limit','cursor']` (`:73`); vòng copy `:419-422` chỉ set 2 tên này → `tenantId`/`sort` không bao giờ tới upstream. |
| Forward `limit`/`cursor` | **ĐẠT** | `:418-424` `new URL('/api/v1/admin/tenants', jsonBaseUrl)` + allowlist + `callUpstream(..., {method:'GET', credential})`. Test BFF pin nguyên văn path upstream và bearer: `tenant-list-bff-offline.test.ts:166-170` (platform) và `:186-190` (operator, dù caller gửi `tenantId` nước ngoài). |

### 3.3 Usage 422 (acceptance ghi tại `usage-422-fix-2026-10-08.md`) — ĐẠT ở tầng offline

| Điểm acceptance | Kết luận | Bằng chứng |
|---|---|---|
| BFF: scope rỗng → 422 `INVALID_SCHEMA` "usage requires a tenantId for platform sessions", **không** gọi upstream | **ĐẠT** | `src/app/admin/bff/operations.ts:216-219`; test `aweb06-bff-operations.test.ts:279-286` (422 + `stub.requests` length 0) — đã chạy xanh trong 2a. |
| BFF: thiếu `from`/`to` → 422 trước upstream | **ĐẠT** | `operations.ts:202-205`; test `aweb06…:299-303`. |
| Tenant operator: default scope của mình, foreign `tenantId` → 403, không upstream | **ĐẠT** | `rbac.ts:71-83` (foreign → 403 wording đồng nhất); test `aweb06…:288-297`; `admin-audit-scope.test.ts` (:202) xanh. |
| Upstream defense-in-depth: admin principal thiếu `tenantId` → 422 | **ĐẠT (code)** | `src/http/routes/public.ts:189-193` (`/api/v1/usage`) và `:146-147` (`/api/v1/usage/events`). |
| UI: platform phải chọn tenant UUID hợp lệ; "All tenants" không phát request | **ĐẠT** | `apps/admin-web/src/features/usage/usage-screen.tsx:26` (regex UUID), `:46` (guard load), `:112-114` (Load disabled + alert "Usage summaries require a single tenant…"); harness `usage-screen-offline.cjs` exit 0. |
| `/api/v1/usage/summary` 422 khi thiếu/đảo window | **CODE-CONFIRMED, TEST SKIPPED** | `public.ts:110-111` (thiếu from/to → 422) + `usage.ts:383` (from > to → 422 `INVALID_ARGUMENT`); test duy nhất: `usage-summary.test.ts:286-295` — **skipped** vì `DU_LIVE_INFRA` (2d). |

---

## 4. Findings

### F1 — **FAIL (đỏ, exit 1)**: cụm suite operations-list đỏ sẵn ở HEAD, KHÔNG phải regression của tenant/usage

| Suite (offline) | exit | Kết quả |
|---|---|---|
| `tests/admin-operations-sort-http-offline.test.ts` | **1** | 29 failed, 3 passed / 32 |
| `tests/admin-operations-sql.test.ts` | **1** | 18 failed, 24 passed / 42 |
| `tests/admin-operations-sort.test.ts` | **1** | 11 failed / 11 |

**Root cause (file:line):** module phát câu SQL có thêm projection sắp xếp
`SELECT *, to_char(<sortKey> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS __cursor_sort_key FROM operations …`
(`src/modules/operations/list-query.ts:563-566`), trong khi fake-DB parser của các suite chỉ nhận dạng
`/^SELECT \* FROM operations/i` (`admin-operations-sort-http-offline.test.ts:181`; tương tự `admin-operations-sql.test.ts`,
`admin-operations-sort.test.ts`), nên rơi vào nhánh `throw new Error('unexpected operations-list SQL: …')`
(`admin-operations-sort-http-offline.test.ts:245`, `admin-operations-sql.test.ts:110`, `admin-operations-sort.test.ts:225`)
→ route trả **500** (`ops-sort-verbose.log`: Expected 200 / Received 500; `admin-operations-sql.test.log` ghi nguyên văn SQL bị từ chối).

**Phân loại pre-existing (bằng chứng):**
- `git show HEAD:<list-query.ts>` **đã chứa** `__cursor_sort_key` (2 hits) → câu SQL gây lỗi có sẵn trong revision HEAD.
- `git status --porcelain` **không** liệt kê `src/modules/operations/list-query.ts` lẫn 3 test file trên → cả hai phía đều là bản HEAD.
- Đường đi của tenant roster/usage **không** dùng `list-query.ts`: `handle.ts:418` → `/api/v1/admin/tenants` → `admin.ts:413-431`
  → `tenant-list.ts`; các thay đổi working tree của packet nằm ở `handle.ts`, `bff/operations.ts`, `public.ts:494+`, `admin.ts`,
  `create-app.ts`, `runtime.ts` — không file nào chạm `list-query.ts`.
- Hai suite cùng module vẫn xanh (`operations-list-contract-conformance.test.ts` 19 passed; `operations-list-cursor-sort-binding.test.ts` 54 passed),
  cho thấy logic module không hỏng — chỉ các harness SQL-shape bị lệch.
- Matcher grep chỉ bắt 3 suite này qua **comment** ("tenants" trong mô tả tie/tenant-scope), không phải qua hành vi tenant roster.

→ **Vẫn ghi ĐỎ trên board** (offline lane hiện không xanh ở HEAD), nhưng **không tính là FAIL của tenant roster/usage 422**
và không chặn verdict của packet này.

### F2 — Coverage gap (không phải FAIL): nhánh backward (`prev`) của `listTenantPage` không có test chạy

`tenant-list-cursor-codec-offline.test.ts` chỉ test round-trip codec `next`/`prev` (`:94-98`, `:102`) và một lần replay
con trỏ `next` dưới scope khác (`:111-133`). **Không test nào** gọi `listTenantPage` với cursor `direction='prev'`, nên các
dòng `:125-126` (DESC/<), `:136` (`ORDER BY … DESC`) và `:142` (reverse về ASC) cùng nhánh `:148-151` chỉ được xác nhận
bằng **đọc code**, không bằng thực thi. Fake DB trong test **có** hỗ trợ nhánh DESC nên chỉ cần thêm case là pin được.

### F3 — Coverage gap (không phải FAIL): nhánh 422 và route thật của tenant roster không được pin

- `parseTenantListQuery` ném 422 khi cursor sai (`tenant-list.ts:93-95`) nhưng không test nào assert nhánh này
  (test chỉ pin clamp limit `:135-139` và decode trả `null` `:141-151`).
- Route thật `GET /api/v1/admin/tenants` (`admin.ts:413-431`: scope từ credential, wire `{id,name,state}`) không có test:
  suite BFF dùng **stub upstream**, nên tầng BFF được chứng minh còn tầng route+SQL chỉ được xác nhận bằng đọc code
  (khớp advisory #2 của `tenant-usage-connector-review-2026-10-08.md`; F2/F3 là phần còn thiếu của advisory đó).

### F4 — Robustness (LOW/MEDIUM, không rò rỉ dữ liệu): usage route không 422 `tenantId` sai định dạng

- `/api/v1/usage/events`: `tenantId` chỉ qua `SafeIdSchema` (`packages/contracts/src/usage-reconciliation.ts:117`), pattern
  `USAGE_ATTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,127}$/` (`usage-metrics.ts:33`) → `not-a-uuid` **hợp lệ**;
  `authorizeAuditTenantRead` **không** kiểm tra format (`rbac.ts:78` trả thẳng giá trị cho platform); giá trị được bind thẳng
  vào cột `uuid` (`usage.ts:559-560` `o.tenant_id = $1`). `/api/v1/usage` cũng vậy (`public.ts:191-193` → `usage.ts:392`).
- Hệ quả: request platform-admin với `tenantId` không phải UUID **không** trả 422 mà fail ở tầng DB; lỗi không map → 500
  `TEMPORARY_UNAVAILABLE` sanitized (`http/errors.ts:98-106`). **Không có rò rỉ dữ liệu** (fail-closed, tenant operator vẫn 403).
- Khác biệt có chủ đích/không chủ ý với hai route chị em: audit và api-keys **422** `tenantId` sai (`audit-list.ts:65`,
  `api-key-list.ts:57`; pin bởi `admin-list-contract-conformance.test.ts:225`).
- Không test nào phủ; muốn pin status thật phải chạy live (ngoài lane này). **Không** nằm trong acceptance usage-422 đã ghi,
  nên ghi nhận là finding robustness, không phải FAIL acceptance.

### F5 — SKIPPED ≠ PASS (ghi rõ, không tính pass)

`usage-summary.test.ts` (10 skipped), `admin-local-users-migration.test.ts` (1 skipped), `admin-keyset-explain.test.ts`
(13 skipped) đều bị env gate (`DU_LIVE_INFRA=1` / `DU_LOCAL01_LIVE_MIGRATION=1`). Lane này **không** giữ DB window nên
không set các biến đó; mọi kết luận live (bao gồm 422 của `/api/v1/usage/summary`) **chưa được xác minh độc lập**.

---

## 5. Verdict

| Hạng mục | Verdict | Cơ sở |
|---|---|---|
| Tenant roster — BFF (platform + tenant_operator, credentialFor, strip tenantId/sort, forward limit/cursor) | **PASS (offline)** | 2 suite / 9 passed exit 0 + source `handle.ts:402-424`, `upstream.ts:67-73`, test `tenant-list-bff-offline.test.ts:134-191` |
| Tenant roster — SQL scope + cursor semantics (SQL predicate, opacity, backward probe) | **PASS (source + offline codec/SQL test)** | `tenant-list.ts:112-163` khớp từng điểm; F2/F3 là coverage gap, không phải sai hành vi |
| Usage 422 theo acceptance đã ghi | **PASS (offline)** cho BFF empty-scope/from-to/foreign + UI gate | `aweb06-bff-operations.test.ts:279-311` (12 passed), `usage-screen-offline.cjs` exit 0 |
| Usage 422 upstream (`/api/v1/usage`, `/api/v1/usage/summary`) | **CODE-CONFIRMED, LIVE UNVERIFIED (skip)** | F5; `public.ts:180-193`, `usage.ts:383` |
| Cụm operations-list đỏ (F1) | **FAIL (pre-existing tại HEAD, ngoài scope packet)** | 3 suite exit 1, root cause `list-query.ts:564` vs parser `:181` |

**Kết luận:** phần **tenant roster + usage 422 trong packet này PASS ở mức offline evidence + source reading**,
đúng như kỳ vọng 9 pass của lệnh bắt buộc. **Không có FAIL nào thuộc tenant roster/usage 422.**
Ba suite đỏ ở F1 là **pre-existing tại HEAD**, phải giữ đỏ trên board và thuộc owner khác (operations list / admin UX);
F2–F4 là coverage/robustness advisory. **Không claim ACCEPTED**, không tick ledger, không reconcile task row —
quyết định acceptance thuộc coordinator/main verifier.

## 6. Artifact & tính toàn vẹn

- Receipt này: `coordination/reports/tenant-verify-dsh-2026-10-08.md` (**mới**).
- Raw: `coordination/reports/raw/tenant-verify-dsh-2026-10-08/` (**mới**) — 25 log/dump + `RESULTS.txt` + `SHA256SUMS.txt`.
- Thư mục tạm `du-rework/_verify-step1.log`, `du-rework/_verify-step2*/` đã **xóa** sau khi hợp nhất log.
- **Không** file product source/test nào bị sửa, tạo hay xóa bởi lane này; **không** commit, **không** push.
- Digest (SHA256) của các file nguồn đã đọc trong báo cáo này:

| File | SHA256 |
|---|---|
| `.../src/modules/admin-read/tenant-list.ts` | `857817f56f204c1ce102721442998a2406cdad3917a6855cef6b6a859ea41ca5` |
| `.../src/app/admin/bff/handle.ts` | `6fd84ef3d11971403e67f0e050288315acc1f4f786f8c72c1f135d6fd8001840` |
| `.../src/app/admin/bff/operations.ts` | `63689f23bf9d48c7c41c468664ed943c9c0ea67687cf420751ae6c22e0bb4d58` |
| `.../src/app/admin/bff/upstream.ts` | `f951b3b37c5f1f52fd7723604309432e87c9341f7675aa92f20ae905ee5b4bee` |
| `.../src/modules/admin-actions/rbac.ts` | `d219fd4ca50cb6f884a0962372d91f84a5b518644ed015090bab6a64c2fb98b6` |
| `.../src/http/routes/public.ts` | `36e96502b155c1148514166a5f8f991c8f956c22dc725e040a88da8dddb0925b` |
