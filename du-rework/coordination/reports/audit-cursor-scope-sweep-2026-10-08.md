# Audit — lớp defect "cursor subquery không có tenant scope" (READ-ONLY) — 2026-10-08

- **Task:** quét toàn bộ `du-rework` orchestrator để tìm các site còn lại của lớp defect: subquery load boundary row **bằng id** (`SELECT … WHERE id = <cursor>` / `SELECT created_at|id FROM operations WHERE id = <token>`) mà **thiếu scope** (`tenant_id` / `api_key_id` / fence tương ứng của outer query).
- **Mode:** READ-ONLY — **không sửa source/test**, không commit/add/push, không tick gate, không đụng `docs/21-openapi.json`. Chỉ tạo receipt này + raw log.
- **Scope:** `du-rework` orchestrator (`services/orchestrator`, `services/connector`, `packages/*`, `apps/*`); cross-check compat/admin-read/operations/runtime.

## Kết quả: **No additional sites found** (không còn site nào unscoped)

3 site từng thuộc lớp defect đều **đã có scope predicate trong cây hiện tại**:

| # | Site (file:line, hiện tại) | Scope nay có trong subquery | Fix cross-ref |
|---|---|---|---|
| 1 | `orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts:123-124,132-133` | `boundaryScope = scopeBind === null ? '' : ' AND id = ' + scopeBind` → tenant operator bị fence (`id = $scope`), platform (`scope===null`) không cần | `f1-cursor-scope-fix-2026-10-08.md`; verified bởi `verify-f1f2-independent-legA/legB-2026-10-08.md` |
| 2 | `orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts:412-438` | `tenantScope = 'tenant_id = $1'` **và** `apiKeyFence` mirror y hệt outer query; token ngoài scope → subquery NULL → trang rỗng (fail-closed) | `fix-section8-low-legacy-cursor-2026-10-08.md` (RED→GREEN 8/8; **independent verify còn treo theo chính receipt đó**) |
| 3 | `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts:1845-1853` (`listOperations`) | `… WHERE id=$2 AND tenant_id=$1` (cùng param với outer; không thêm placeholder) | Cùng receipt `fix-section8-low-legacy-cursor` (site 2); phát hiện gốc: oc_4 review `wfa-section8-security-review-2026-10-08.md` (finding candidate LOW) — đã vá lúc 09:54 trước audit này |

## Đã quét (phương pháp + phạm vi)

Các lệnh (raw đầy đủ: `coordination/reports/raw/audit-cursor-scope-sweep-2026-10-08/sweep-rg.txt`):

| # | Pattern | Phạm vi | Hits | Kết luận từng hit |
|---|---|---|---:|---|
| A | `(SELECT ` | `orchestrator/services/orchestrator/src` | **11 dòng / 7 file** | Tất cả đã phân loại dưới đây — **không còn boundary subquery thiếu scope** |
| B | `(SELECT ` | `orchestrator/services/connector/src` | 2 | `db/repository.ts:893,905` — `EXISTS` có `r.tenant_id = $2 OR r.tenant_id = ''` (scoped) |
| C | `WHERE id = $N)` hoặc `WHERE id = ${` | `orchestrator/services` | 1 | `tenant-list.ts:133` — **có** `boundaryScope` (đã fix) |
| D | `SELECT (created_at\|lower(name)\|count(*)) FROM (operations\|tenants\|artifacts\|tasks)` | `orchestrator/services` | 3 file | `runtime.ts:1853` (scoped ✓), `tenant-list.ts:133` (scoped ✓), `storage-migration.ts:121-131` (counts tooling, không cursor) |
| E | `(SELECT ` / `WHERE id=$` | `orchestrator/packages`, `orchestrator/apps` | **0** | Không có SQL trong packages/apps |
| F | `pageToken\|page_token\|afterOperationId` | `orchestrator/services/orchestrator/src` | 26 dòng | Chỉ 1 consumer SQL: `legacy-http-mount.ts:718` → `legacy-host-adapter.ts:427-438` (đã fix). Còn lại là mapper/serializer/comment (không SQL) |
| G | `page_token\|cursor\|LIMIT` | `orchestrator/services/connector/src` | 15 | Không có page-token/cursor boundary; các `ORDER BY … LIMIT 1` đều scoped `connector_id + tenant_id` |

### Từng hit `(SELECT ` (11 dòng) — phân loại

1. `legacy-host-adapter.ts:438` — **FIXED** (tenantScope + apiKeyFence) — site #2 ở trên.
2. `runtime.ts:1853` — **FIXED** (`AND tenant_id=$1`) — site #3 ở trên.
3. `tenant-list.ts:133` — **FIXED** (`boundaryScope`) — site #1 ở trên.
4. `artifacts.ts:241-245` — `DELETE artifact_blobs … AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id=$3 AND a.tenant_id=$2 AND a.state='ABORTED' …)` — **tenant-scoped**; `$3` là `row.id` nội bộ của cleanup, không phải cursor. **Không thuộc lớp.**
5. `profiles.ts:352-362` — `(SELECT n.profile_name FROM profile_names n WHERE n.profile_id = p.profile_id LIMIT 1)` — tương quan với **chính row đã scope** `p.api_key_id=$1 AND business…`; id đến từ binding của caller, không phải id do caller chọn. **Không thuộc lớp.**
6. `business-list.ts:99` — `(SELECT version FROM business_versions WHERE business_id=$1 AND is_active=true LIMIT 1)` — registry platform (đăng ký business, không dữ liệu tenant), param-scoped. **Không thuộc lớp.**
7. `storage-migration.ts:121-131` — 5 `(SELECT count(*) …)` cho inventory migration (tooling vận hành, không tham số caller, không cursor). **Không thuộc lớp.**

### Các id-load khác đã rà (không phải cursor boundary)

- `modules/admin-read/keyset.ts:159-166, 228-232` — hai executor keyset dùng chung (audit/api-key/business/version lists): shortcut clause so sánh **giá trị mang trong token** `($createdAt::timestamptz, $id::uuid)` — **không load boundary row**, nên không có subquery để scope.
- `modules/operations/list-query.ts:491-501, 564` — canonical operations list: cursor mang `createdAt + id + sort` trong token (`params.push(cursor.createdAt, cursor.id)`), strict decode + sort-identity 422; **không load boundary row**.
- `webhooks/result-projection.ts:248` — `SELECT result_ref FROM operations WHERE id=$1`: id từ `webhook_deliveries.operation_id` (nội bộ, sinh từ chính operation), không phải cursor client.
- `queue/dispatcher.ts:316` — `SELECT tenant_id FROM operations WHERE id=$1`: id từ outbox row nội bộ.
- `lifecycle/lifecycle.ts:37-40` — by-id `FOR UPDATE` nhưng **kiểm `op.tenant_id !== tenantId → 404`** ngay sau; đây là authorized by-id read, không phải boundary load.
- `operations/submission.ts:1387-1395` (`loadOperationView`, unscoped `WHERE id=$1`) — **call sites an toàn**: `submission.ts:362` (id từ idempotency lookup đã scope `tenant_id+api_key_id+route_action+key` tại `:1380`) và `submission.ts:713` (operation vừa tạo trong cùng request). Exported ở `index.ts:89` — **khuyến nghị informational:** consumer tương lai phải tự kiểm tenant (như pattern 404 hiện có); không thuộc lớp cursor.
- `modules/artifacts/multipart-service.ts`, `upload-encryption-gateway.ts`, `legacy-public-artifact.ts`, `artifacts.ts` — các by-id load khác đều kèm `tenant_id=$`/`task_id=$` (đã rà trong lượt grep `WHERE id = $`).
- `modules/operations/ingestion-consumer.ts` — by-id các bảng outbox/artifact, id nội bộ từ sweep.
- `modules/encryption/legacy-payload-migration.ts:889,895` — CAS theo `id + updated_at/result_ref` của row đang migrate (tooling).
- `compat/legacy-operations.ts`, `compat/legacy-operation-serializers.ts` — mapper/serializer **không SQL** (serializer unmounted; không load boundary row).

## Vi phạm còn lại

**Không có.** Vì vậy không có bảng severity (LOW/MED/HIGH) cho site mới. Hai site F-1/LOW đã được fix lane xử lý (cross-ref ở trên); site #3 (runtime `listOperations`) cũng đã vá trong cùng receipt fix LOW (`09:54`).

## Khuyến nghị (informational — KHÔNG tự sửa)

1. **Quy ước cho keyset mới:** boundary subquery (nếu buộc phải load row theo id) phải mirror **đúng scope predicate của outer query** (`tenant_id`, `api_key_id`, business/`deleted_at` visibility tách riêng — như comment `legacy-host-adapter.ts:409-411`); ưu tiên mang giá trị trong token (pattern `keyset.ts`) để tránh cả lớp defect.
2. **Regression guard (đề xuất):** một test source-level nhỏ quét pattern `(SELECT … FROM (operations|tenants|artifacts|tasks) WHERE id = $` trong `src/` và fail nếu câu chứa nó không có `tenant_id`/`api_key` trong cùng subquery — biến lớp defect này thành bất biến kiểm tra tự động.
3. `loadOperationView` (exported, unscoped by-id): giữ nguyên cho hiện tại (call sites an toàn) — nếu có consumer ngoài repo, nên thêm scope param hoặc ghi chú bắt buộc kiểm tenant.

## Revision pin (SHA-256 lúc audit)

`tenant-list.ts f3e6dc9487d8…6756fef7f813` · `legacy-host-adapter.ts 41c5cb4c2a08…6701bb468526` · `runtime.ts 900e2ad60214…15090db8a6a3` · `keyset.ts d841f4722a72…0dbd186d3bdf` · `list-query.ts bde83317e2e4…1498b12e1934`.

## Raw

`coordination/reports/raw/audit-cursor-scope-sweep-2026-10-08/sweep-rg.txt` (output các lệnh A–E).

## Giới hạn

- Audit là **read-only sweep theo pattern + đọc thủ công từng hit**; không chạy test/live. Việc F-1/LOW "đã fix" được ghi nhận ở đây **chỉ là quan sát cây hiện tại** — quyết định verified/closed thuộc review/verify lane độc lập (receipt fix LOW ghi rõ "Verify độc lập: chưa").
- Không quét legacy root (ngoài scope `du-rework`), không quét `tests/`.
- `fix-section8-med1-migration-ledger` là finding khác (không thuộc lớp cursor) — không audit lại ở đây.
