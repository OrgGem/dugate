# VERIFY ĐỘC LẬP — connector knownIds · F-1 cursor scope · MED-1 half-2 — lane B — 2026-10-08

**Vai trò:** leg verify độc lập (lane B, terminal DSH — khác lane A).
**Quy tắc:** KHÔNG sửa source, KHÔNG sửa test, KHÔNG commit/add/push, KHÔNG tick gate, KHÔNG hand-edit `docs/21-openapi.json`, KHÔNG claim DB window — offline only. Scope: `du-rework`.
**Revision:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5` (branch `codex/fix-workflow-builder`), working tree dirty.
**cwd mọi lệnh:** `D:\Git\dugate\du-rework\orchestrator\services\orchestrator` · Node `v22.23.3`.
**Raw:** `coordination/reports/raw/verify-tenant-connector-med1-INDEPENDENT-oc-b-2026-10-08/` (mỗi suite 1 log + `med1-combined.log`, `supporting-tenant-list-cursor-codec.log`, `SHA256SUMS.txt`).

---

## Phần 1 — connector knownIds

Tìm bằng ripgrep (grep tool của harness = rg): pattern `knownConnectorIds`, path `tests/` → **4 suite** (8 match):
`admin-config-cockpit.test.ts:158`, `admin-connector-render.test.ts:134,137`, `bff-connectors-actions.test.ts:156,368`, `p745-connector-management-proxy.test.ts:195,206,214`.

Chạy **từng suite** (đúng lệnh packet, `--config jest.unit.config.cjs`, mỗi file chạy 1 lần, không retry):

| Suite | Exit | Literal `Tests:` |
|---|---:|---|
| `tests/admin-config-cockpit.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 8 passed, 8 total`** |
| `tests/admin-connector-render.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 16 passed, 16 total`** |
| `tests/bff-connectors-actions.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 17 passed, 17 total`** |
| `tests/p745-connector-management-proxy.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 12 passed, 12 total`** |

**Tổng Phần 1: 4 suite / 53 test passed, tất cả exit 0.** Không có FAIL.

## Phần 2 — F-1 cursor scope trong `tenant-list.ts`

Đọc `src/modules/admin-read/tenant-list.ts:117-140` (digest SHA-256 `f3e6dc9487d84e1c654d93cebbd844a949cce30d4f4201bbcca26756fef7f813`, **sạch so với HEAD**):

```ts
123:   const scopeBind = scope === null ? null : bind(scope);
124:   if (scopeBind !== null) clauses.push(`id = ${scopeBind}`);
...
130:   if (query.cursor) {
131:     const cursorId = bind(query.cursor.id);
132:     const boundaryScope = scopeBind === null ? '' : ` AND id = ${scopeBind}`;
133:     cursorClause = `${clauses.length ? ' AND' : ' WHERE'} (lower(name), id) ${boundaryOp} ((SELECT lower(name) FROM tenants WHERE id = ${cursorId}${boundaryScope}), ${cursorId}::uuid)`;
134:   }
```

**Kết luận: cursor subquery CÓ scope tenant** — khi `scope !== null` (tenant operator), subquery biên nhận thêm ` AND id = $scope` (`:132-133`), tức boundary row phải nằm trong scope của credential; cursor trỏ tenant khác ⇒ subquery trả `NULL` ⇒ row-value comparison `NULL` ⇒ **trang rỗng, fail-closed**. Vì `scope` lấy từ **credential** chứ không từ query param (`src/http/routes/admin.ts:419-420`), không có đường nào để tenant operator đưa boundary ngoài scope.

- **KHÔNG có cross-tenant ordering oracle** cho principal bị scope (tenant operator) — lo ngại F-1 không tái hiện ở revision này.
- Trường hợp `scope === null` (platform admin) subquery **không** kèm scope — **đúng thiết kế**: platform được đọc toàn bộ roster (`docs`/`admin.ts:403-412`: scope đến từ credential; platform không bị narrow), nên không có ranh giới tenant nào để rò.
- Thứ tự bind khớp: `params = [scope, cursorId, limit+1]` (`:119-124`, `:131`, `:135`).
- **Bằng chứng hỗ trợ (chạy thêm, không thay thế đọc code):** `tests/tenant-list-cursor-codec-offline.test.ts` → **exit 0**, `Test Suites: 1 passed` · **`Tests: 6 passed, 6 total`** — suite này pin đúng hành vi replay cursor dưới scope khác (`FROM tenants WHERE id = $1 AND (lower(name), id) > …`) và count bị scope.

## Phần 3 — MED-1 half-2: `verifyMigrations` gọi `recordedMigrationsMissingObjects`

Đọc `src/db/migrations.ts` (digest SHA-256 `519fd20731acac579acde4f5908844ddf98c4948661e408ad64e1c74852d5eed`):

- **`:154-173`** — `async function recordedMigrationsMissingObjects(db, files, done)`: duyệt các migration **đã ghi ledger** (`if (!done.has(file.sequence)) continue;` `:161`), lấy object DDL khai báo qua `declaredSchemaObjects(file.sql)` (`:162`), kiểm tra tồn tại (`schemaObjectExists`, `:166`) và gom `{sequence, filename, objects}` (`:168-170`). Trả `RecordedMigrationDrift[]`.
- **`:307-318`** (trong `verifyMigrations`) — **CÓ gọi**: `:307` `const drifted = await recordedMigrationsMissingObjects(db, files, done);` → nếu `drifted.length > 0` thì `:312-317` ném lỗi fail-closed ("schema verification failed: recorded migrations have missing table/index objects: …").
- Ghi nhận thêm: diff working tree của file này (104 insertions, 3 hunk: `@@ -104,0 +105,70 @@`, `@@ -114,0 +185,21 @@`, `@@ -214,0 +306,13 @@`) chứa **toàn bộ** MED-1 half-2 (`declaredSchemaObjects`, `RecordedMigrationDrift`, `recordedMigrationsMissingObjects`) và **cả** lời gọi trong `migrate()` (`:185+` hunk) lẫn `verifyMigrations()` (`:306+` hunk) ⇒ đây là **thay đổi chưa commit**; verification này là trên **working tree** (digest ở trên), không phải bản HEAD.

Chạy test (mỗi file 1 lần, không retry) + đúng lệnh gộp của packet:

| Lệnh | Exit | Literal `Tests:` |
|---|---:|---|
| `… tests/med1-verify-migrations-object-drift.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 1 passed, 1 total`** |
| `… tests/med1-migration-ledger-object-drift.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 12 passed, 12 total`** |
| `… tests/med1-verify-migrations-object-drift.test.ts tests/med1-migration-ledger-object-drift.test.ts` (lệnh gộp nguyên văn của packet) | **0** | `Test Suites: 2 passed, 2 total` · **`Tests: 13 passed, 13 total`** |

**Tổng Phần 3: 13 test passed, exit 0.** Không có FAIL.

---

## (b) FAIL — không có

Không suite nào FAIL trong cả 6 suite của Phần 1+3, suite hỗ trợ Phần 2, và lệnh gộp MED-1. **Không có tên test/expected/received nào để báo**; không retry để lấy xanh, không sửa test, không bỏ qua test nào.

## (c) cwd + exit code

Mọi lệnh đều chạy tại `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`; mỗi log raw có dòng cuối ghi `EXIT_CODE=<n>  CWD=…  CMD=…` (7 log + 1 log gộp). Exit code: 0 cho toàn bộ (6 suite lẻ + 1 lệnh gộp + 1 suite hỗ trợ).

## Kết luận

- **Phần 1:** 4/4 suite knownConnectorIds xanh, 53/53 test, exit 0.
- **Phần 2:** cursor subquery **có** scope tenant (`tenant-list.ts:132-133`) ⇒ **không** phải cross-tenant ordering oracle cho principal bị scope; platform (scope null) không kèm scope là đúng thiết kế; suite codec xác nhận 6/6.
- **Phần 3:** `verifyMigrations` **có** gọi `recordedMigrationsMissingObjects` (`migrations.ts:307`, helper `:154-173`), fail-closed khi drift; 13/13 test xanh, exit 0.
- **Không tick gate nào** (VERIFIED/ACCEPTED thuộc coordinator). Không sửa file nào ngoài receipt + raw log của lượt này.

## Giới hạn

- MED-1 half-2 là **thay đổi chưa commit** trong working tree; kết luận gắn với digest `519fd207…5eed`, không phải HEAD.
- Offline: các suite knownIds dùng element-tree/proxy stub, MED-1 dùng fake `Db`; **không** chạy PostgreSQL thật, không browser gate, không claim DB window.
- Phần 2 là **đọc code + 1 suite offline**; chưa chạy live PG cho hành vi cursor thật (không claim).
