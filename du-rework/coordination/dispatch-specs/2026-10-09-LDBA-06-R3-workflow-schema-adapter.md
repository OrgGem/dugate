# DISPATCH — LDBA-06 R3 — Adapter workflow schema (sửa đổi sau receipt 2)

**Task ID:** `LDBA-06-R3`
**Repo scope:** `D:/Git/dugate` — đọc `lib/workflow-builder/loader.ts` (root) + `lib/db/schema.ts` (root, bảng `appSettings`) + `du-rework/orchestrator/services/orchestrator/migrations/0037_legacy_workflow_schema_catalog.sql` + `du-rework/orchestrator/services/orchestrator/src/modules/workflow-schemas/**` + `du-rework/orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts`. **VIẾT DUY NHẤT:** module adapter mới (path do bạn tự chọn) + test riêng của module đó + receipt `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md` (ghi đè bản R2)
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` — **đọc lại §4.1 và §4.6**
**Owner:** terminal `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` (đã đọc màn hình: **IDLE tại prompt**; đúng domain workflow; đã dừng đúng 2 lần)
**Dependencies:** LDBA-01 ACCEPTED · LDBA-02 ACCEPTED · LDBA-03 ACCEPTED · LDBA-04 ACCEPTED · LDBA-05 ACCEPTED-WITH-CONDITIONS · **LDBA-06 R1 + R2 receipt đã review**
**Mode:** thiết kế + viết module + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet R3

R1 và R2 bạn đều **dừng đúng**. R2 dừng vì `parseStoredPin` không được export (`workflow-schemas.ts:116`). Coordinator đã verify độc lập trên source: đúng — `parseStoredPin` (`:116`), `parseStoredEnvelope` (`:84`) và `schemaDigest` (`:70`) đều là **module-private**.

Coordinator **không** chọn phương án export hàm, vì đó phải sửa `workflow-schemas.ts` — file nằm ngoài write set và hiện **không có consumer nào khác** cần export. Thay vào đó coordinator chọn phương án **sửa packet** mà chính bạn đã đề xuất ở Open item 1 của receipt R2.

Bạn **không** cần dừng nữa vì lý do test seam. Nhưng vẫn **phải dừng** nếu gặp xung đột mới.

## 1. Quyết định coordinator đã chốt — áp dụng, không tranh luận

### 1.1. Test seam — dùng `resolveLegacyWorkflowSchema` đã export, **KHÔNG** export `parseStoredPin`

`resolveLegacyWorkflowSchema` (`workflow-schemas.ts:152-199`) **đã export** và nhận `db: Db` làm tham số đầu tiên. Nó gọi `parseStoredPin` thật ở `:198`.

⇒ Test tạo **fake db** có phương thức `query(sql, params)` trả về hàng `CatalogRow` tổng hợp đúng shape, rồi gọi `resolveLegacyWorkflowSchema(fakeDb, query, metadataCrypto)`.

⇒ Đây **mạnh hơn** gọi trực tiếp `parseStoredPin`, vì nó cũng chạy thật: câu SELECT chọn hàng (`:162`), check `status === 'active'` (`:184`), `requireCrypto` (`:187`), và giải mã `readStored(..., false)` (`:190-194`) với đúng AAD triple.

⇒ **KHÔNG** export `parseStoredPin`. **KHÔNG** sửa `workflow-schemas.ts` hay bất kỳ file catalog nào.

### 1.2. AAD triple phải seal đúng — sai thì fail **LOUD**, không bao giờ pass âm thầm

Đọc từ `:58`, `:62-68`, `:190-194`:
- `slot` = `legacy_workflow_schemas.schema_ref`
- `refId` = `${slug}:${revision}` — tức `${slug}:1` cho revision 1
- `tenantId` = UUID đã resolve của `legacy-default`

Nếu test seal sai triple, `crypto.open` ném `CONTEXT_MISMATCH`, bị bắt ở `:195-196` rồi ném `SCHEMA_CRYPTO_UNAVAILABLE`. ⇒ Sai AAD = test **đỏ**, không phải xanh giả. Đây là tính chất cần giữ, không phải điểm yếu.

### 1.3. Tenant — áp **đúng** semantics của LDBA-03 để hai adapter không trôi

LDBA-03 đã implement ở `scripts/ldba-03-backfill.cjs:891-930`. Bạn **phải giống hệt**:
- 0 khớp + preflight → `PREFLIGHT_TENANT_PENDING`, **không** seed
- 0 khớp + execute → `seedTenantByName` chỉ chèn name, rồi resolve lại
- >1 khớp → fail closed (`DUPLICATE_TENANT_NAME`)
- phải resolve đúng 1 UUID khớp pattern

### 1.4. Digest + envelope — giữ nguyên R2 §1.1

1. **Bọc** schema legacy thành envelope đúng 3 khóa: `schema` = object đã parse, `connectorSlotMap` = object rỗng, `approvedEgressOrigins` = mảng rỗng.
2. `digest` = `sha256:` + hex của canonical-pin bytes trên đúng 3 giá trị đó. **Tái dùng nguyên văn hàm digest của catalog** nếu export được; nếu không, **tái tạo đúng công thức** và **ghi rõ** trong receipt là bản sao chứ không phải hàm gốc.
3. `schema_ref` phải **đã seal** qua cơ chế hiện hữu. Read path truyền `allowPlaintext=false` (`:190`) nên plaintext bị từ chối.
4. **KHÔNG** sửa `0037`, **KHÔNG** nới integrity check.

### 1.5. Trùng `updatedAt` — giữ nguyên R2 §1.3

Nếu nhiều hàng cùng slug có `updatedAt` **bằng nhau**, lấy hàng có **`key` lớn nhất theo thứ tự so sánh chuỗi tất định** (byte-order, không phải locale). Cột `key` là PK của `appSettings` nên luôn phân định.
⇒ Nếu cột không có PK/unique, bạn **dừng** và ghi `Open items for coordinator`.
⇒ Mọi hàng bị loại — kể cả hàng bị loại vì trùng `updatedAt` — phải vào **danh sách** trong receipt, kèm lý do loại.

### 1.6. Nguồn chân lý của route — giữ nguyên R2 §1.4

Route `app/api/v1/docs/workflows/schema/route.ts` **tiếp tục đọc** `appSettings` ở v1. Packet này **chỉ** ghi vào catalog. **KHÔNG** sửa route, **KHÔNG** sửa loader.

## 2. Việc còn lại

### 2.1. `revision = 1`, `status = active`, idempotent

- PK `(tenant_id, slug, revision)`; chạy lại không sinh trùng.
- Slug đã tồn tại → **skip**, không ghi đè.
- Test chứng minh chạy 2 lần cho cùng kết quả.

### 2.2. Tiêu chí nghiệm thu — đã chốt cụ thể

Test **không được** chỉ assert format regex `^sha256:[0-9a-f]{64}$`.
Test **phải** gọi `resolveLegacyWorkflowSchema` thật với fake db, và assert nó **trả về pin** cho hàng bạn vừa ghi.

Test **phải** dùng `MetadataCrypto` thật với key provider thật — vì read path truyền `allowPlaintext=false` (`:190`), nên envelope chưa seal sẽ bị từ chối. Tiêu chuẩn này khớp LDBA-04/LDBA-05 đã dùng crypto thật.

Test **phải** có ít nhất 1 case chứng minh rằng hàng **chưa seal** bị từ chối — tức envelope plaintext vào `schema_ref` phải ra `SCHEMA_CRYPTO_UNAVAILABLE`, không phải pin.

Test tự viết reader riêng rồi tự assert bằng nó là **vacuous pass**, không phải bằng chứng.

### 2.3. Báo cáo

- Danh sách slug xử lý, **danh sách** người thua kèm lý do.
- Bảng map: source key → `slug` / `revision` / `status` / `tenant_id` / `digest` / `schema_ref` shape.
- Ghi rõ digest là **tái dùng hàm catalog** hay **bản sao công thức**.
- Mọi `Open items`.

## 3. Ranh giới (bắt buộc)

- **KHÔNG** chạy migration lên DB thật. Chỉ test offline.
- **KHÔNG** đọc DB production/legacy để lấy fixture.
- **KHÔNG** sửa `0037` hay bất kỳ file migration nào.
- **KHÔNG** sửa `lib/workflow-builder/loader.ts` hay `app/api/v1/docs/workflows/schema/route.ts` — chỉ đọc.
- **KHÔNG** sửa `workflow-schemas.ts` hay `metadata-crypto.ts` hiện hữu, **kể cả** để thêm `export`.
- **KHÔNG** hardcode UUID tenant.
- **KHÔNG** commit, `git add`, push, không tick gate.

## 4. Acceptance criteria

- [ ] Đọc lại §4.1 và §4.6 của plan và làm theo
- [ ] Envelope đúng **3 khóa**; `digest` bằng canonical-pin digest, không phải hash raw JSON
- [ ] `schema_ref` **đã seal**; không ghi plaintext
- [ ] `tenant_id` là **UUID resolve theo name**, không phải chuỗi `legacy-default`, không phải UUID dev-fallback
- [ ] `revision = 1`, `status = active`
- [ ] Quy tắc trùng `updatedAt` chạy đúng; **danh sách** người thua kèm lý do
- [ ] Idempotent: chạy 2 lần không sinh trùng; slug đã tồn tại → skip
- [ ] **Test gọi `resolveLegacyWorkflowSchema` thật** với fake db và assert trả về pin — không assert regex đơn thuần
- [ ] **Test có case chứng minh hàng chưa seal bị từ chối** (`SCHEMA_CRYPTO_UNAVAILABLE`)
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số slug test, số người thua, mọi `Open items`

## 5. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu bất kỳ điều nào sau đây xảy ra:
- `resolveLegacyWorkflowSchema` không dùng được như seam (ví dụ: chữ ký đổi, hoặc nó đọc thêm nguồn ngoài `db.query`)
- `metadata-crypto` seal yêu cầu key không có trong môi trường offline
- `appSettings` không có PK/unique để chốt quy tắc trùng `updatedAt`
- Bất kỳ yêu cầu nào ở §3.

**Dừng đúng cách là hành vi được chấp nhận** — R1 và R2 bạn đã làm đúng và R3 này sẽ không phạt.

## 6. Dispatch proof

- **Request ID:** `LDBA-06-R3-2026-10-09`
- **Owner:** `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` — đã đọc màn hình, **IDLE tại prompt**
- **Dependency evidence:** LDBA-06 R2 receipt (stop đúng tại §5) + coordinator verify trên `workflow-schemas.ts:70,84,116` (module-private), `:152-199` (`resolveLegacyWorkflowSchema` đã export, gọi `parseStoredPin` ở `:198`), `:58` (`CATALOG_SLOT`), `:62-68` (`refId` = `${slug}:${revision}`), `:190` (`allowPlaintext=false`) + `scripts/ldba-03-backfill.cjs:891-930` (semantics tenant cần giống hệt)
- **Acceptance:** envelope 3 khóa + canonical-pin digest + tenant UUID theo name + idempotent + **đọc lại được qua `resolveLegacyWorkflowSchema` thật** + case chứng minh hàng chưa seal bị từ chối
