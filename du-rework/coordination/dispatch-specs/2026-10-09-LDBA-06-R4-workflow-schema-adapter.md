# DISPATCH — LDBA-06 R4 — Adapter workflow schema (sửa đổi sau receipt 3)

**Task ID:** `LDBA-06-R4`
**Repo scope:** `D:/Git/dugate` — đọc `lib/workflow-builder/loader.ts` (root) + `lib/db/schema.ts` (root, bảng `appSettings`) + `du-rework/orchestrator/services/orchestrator/migrations/0037_legacy_workflow_schema_catalog.sql` + `du-rework/orchestrator/services/orchestrator/src/modules/workflow-schemas/**` + `du-rework/orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts` + `du-rework/orchestrator/packages/contracts/src/legacy-workflow.ts` + `du-rework/orchestrator/packages/contracts/src/profile-callback.ts`. **VIẾT DUY NHẤT:** module adapter mới (path do bạn tự chọn) + test riêng của module đó + receipt `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md` (ghi đè bản R3)
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` — **đọc lại §4.1 và §4.6**
**Owner:** terminal `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` (đã đọc màn hình: **IDLE tại prompt**; đúng domain workflow; đã dừng đúng 3 lần)
**Dependencies:** LDBA-01 ACCEPTED · LDBA-02 ACCEPTED · LDBA-03 ACCEPTED · LDBA-04 ACCEPTED · LDBA-05 ACCEPTED-WITH-CONDITIONS · **LDBA-06 R1 + R2 + R3 receipt đã review**
**Mode:** thiết kế + viết module + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet R4

R3 bạn **dừng đúng lần 3**. Coordinator đã verify độc lập trên source; cả 2 claim đều thật:

1. `validateLegacyWorkflowConnectorSlotMap` (`packages/contracts/src/legacy-workflow.ts:164-177`) từ chối map thiếu bất kỳ tên connector nào có trong schema (`:173-175`); tên connector được thu từ `:152-161`. ⇒ Map rỗng **không** đọc lại được cho schema có node connector.
2. `validateLegacyWorkflowEgressOrigins` (`:329-370`) từ chối egress động hoặc mang credential khi approved rỗng (`:352-354`), từ chối URL HTTPS có origin không nằm trong approved (`:355-363`), từ chối egress không có URL và không có approved (`:365-367`). ⇒ Approved rỗng **không** đọc lại được cho schema có node `file_url_download` / `callback`.

Nguồn legacy có thật các node đó: `lib/workflow-builder/types.ts:24-34` khai `connector`, `file_url_download`, `callback`; `:93-118` khai `FileUrlNode` / `CallbackNode` với `urls` / `url` kiểu `Binding` và khối `auth`.

**Nguyên nhân gốc là spec R3 §1.4 của coordinator**: bắt buộc `connectorSlotMap` rỗng và `approvedEgressOrigins` rỗng. Hai giá trị đó chỉ hợp lệ cho schema không connector và không egress. **Spec sai, không phải owner sai.**

## 1. Quyết định coordinator đã chốt — áp dụng, không tranh luận

### 1.1. KHÔNG tự bọc envelope — gọi `provisionLegacyWorkflowSchema`

`provisionLegacyWorkflowSchema` (`workflow-schemas.ts:205-337`) **đã export**, nhận `db: Db` injectable, và là **writer production**. Nó đã làm sẵn toàn bộ việc R3 bắt bạn tự làm:

- parse + validate schema (`:213`)
- **cấp slot map đầy đủ** qua `allocateLegacyWorkflowConnectorSlotMap` (`:266-268`) — chính hàm export từ contracts (`legacy-workflow.ts:179-195`)
- validate approved egress origins (`:277-280`)
- tính digest canonical-pin (`:287`)
- tính `revision = max+1` (`:288-293`) — bằng 1 trên catalog rỗng
- seal với đúng AAD triple (`:294-298`)
- advisory lock + CAS (`:300-316`) + retire row cũ + insert `status='active'` (`:317-326`)

⇒ Adapter **không** tự tính digest, **không** tự seal, **không** tự cấp slot map, **không** tự viết INSERT. Adapter chỉ: liệt kê key, resolve tenant, derive approved origins, skip nếu đã tồn tại, rồi **gọi writer production**.

⇒ Đây **mạnh hơn R3**: output của adapter theo cấu trúc đọc lại được bởi reader production, vì cả hai đều là code production. Không còn rủi ro lệch shape envelope, không còn rủi ro sai công thức digest.

### 1.2. `connectorSlotMap` — tự động, không cần quyết định chính sách

Writer tự cấp đầy đủ map qua `allocateLegacyWorkflowConnectorSlotMap`. **Open item 1 của receipt R3 được đóng bằng cách dùng writer production** — không cần chính sách mới, không cần sửa contract, không cần migration.

### 1.3. `approvedEgressOrigins` — derive từ URL tĩnh HTTPS, cấm bịa

Đây là **phần việc còn lại duy nhất** của adapter. Writer bắt buộc origins hợp lệ nếu schema có egress.

Chính sách (chốt, không tranh luận):

- Thu mọi URL cấu hình từ node `file_url_download` (`urls`) và `callback` (`url`), đệ quy vào nhánh `parallel`.
- URL **tĩnh** (không khớp `^\$[A-Za-z_][A-Za-z0-9_]*`): parse bằng `new URL`. Nếu protocol không phải `https:` hoặc có userinfo → **skip schema, báo cáo**, không ghi.
- URL **động** (khớp `^\$[A-Za-z_][A-Za-z0-9_]*`): **skip schema, báo cáo**. Không được bịa origin.
- Origin hợp lệ = `url.origin` — đúng shape `CallbackApprovedOriginSchema` (`profile-callback.ts:259-277`): https, không userinfo, không path/query/fragment.
- Trộn + sắp xếp origins, tối đa 16 (`legacy-workflow.ts:333`, `:281`).
- Nếu schema có egress nhưng derive ra 0 origin → **skip, báo cáo**.

⇒ Adapter **không bao giờ** tự tạo phê duyệt. Nó chỉ ghi lại origin đã được khai tường minh trong schema legacy. Mọi trường hợp không tường minh đều skip + báo cáo.

### 1.4. Tenant — giữ nguyên R3 §1.3 (giống hệt LDBA-03)

LDBA-03 đã implement ở `scripts/ldba-03-backfill.cjs:891-930`. Bạn **phải giống hệt**:

- 0 khớp + preflight → `PREFLIGHT_TENANT_PENDING`, **không** seed
- 0 khớp + execute → `seedTenantByName` chỉ chèn name, rồi resolve lại
- >1 khớp → fail closed (`DUPLICATE_TENANT_NAME`)
- phải resolve đúng 1 UUID khớp pattern

### 1.5. Trùng `updatedAt` — giữ nguyên R3 §1.5

Nếu nhiều hàng cùng slug có `updatedAt` **bằng nhau**, lấy hàng có **`key` lớn nhất theo thứ tự so sánh chuỗi tất định** (byte-order, không phải locale). Cột `key` là unique ở `lib/db/schema.ts:148` nên luôn phân định.

⇒ Nếu cột không có PK/unique, bạn **dừng** và ghi `Open items for coordinator`.
⇒ Mọi hàng bị loại — kể cả hàng bị loại vì trùng `updatedAt` — phải vào **danh sách** trong receipt, kèm lý do loại.

### 1.6. Idempotency — skip nếu đã có active row

Trước khi gọi writer, adapter query:

`SELECT revision FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 AND status='active'`

- Có row → **skip**, ghi vào danh sách skip kèm lý do.
- Không row → gọi `provisionLegacyWorkflowSchema(db, { tenantId, schema, approvedEgressOrigins, expectedRevision: null })`.

`expectedRevision: null` là semantics **assert-absent** (`workflow-schemas.ts:221-224` cho phép null; `:234` so sánh `null !== null` = false khi chưa có row). Nếu giữa lúc check và lúc provision có row xuất hiện, writer ném `SCHEMA_REVISION_CONFLICT`. Adapter **bắt code đó và coi như skip** — không được bỏ qua hay coi là lỗi hệ thống.

### 1.7. Nguồn chân lý của route — giữ nguyên R3 §1.6

Route `app/api/v1/docs/workflows/schema/route.ts` **tiếp tục đọc** `appSettings` ở v1. Packet này **chỉ** ghi vào catalog. **KHÔNG** sửa route, **KHÔNG** sửa loader.

## 2. Việc còn lại

### 2.1. Module adapter

- Nhận source reader (liệt kê `appSettings` + đọc value theo key) và sink `Db` — **không** tự kết nối DB.
- Mỗi schema: parse → derive origins → skip/gọi writer → verify bằng `resolveLegacyWorkflowSchema`.
- Trả về báo cáo: slug, revision, digest, status, tenant_id, số origin đã approve, danh sách skip kèm lý do.

### 2.2. Tiêu chí nghiệm thu — đã chốt cụ thể

Test **không được** chỉ assert format regex `^sha256:[0-9a-f]{64}$`.

Test **phải** gọi `provisionLegacyWorkflowSchema` thật rồi `resolveLegacyWorkflowSchema` thật trên **cùng** fake db, và assert pin round-trip. Đây là bằng chứng mạnh nhất: writer production → reader production.

Test **phải** dùng `MetadataCrypto` thật với key provider thật — vì cả writer và reader đều `requireCrypto`.

Test **phải** có ít nhất 1 case chứng minh rằng hàng **chưa seal** bị từ chối — tức envelope plaintext vào `schema_ref` phải ra `SCHEMA_CRYPTO_UNAVAILABLE`, không phải pin.

Test **phải** có case schema **có connector** round-trip được — chứng minh slot map được cấp đầy đủ.

Test **phải** có case schema **có egress tĩnh HTTPS** round-trip được với origin đã derive.

Test **phải** có case schema **có egress động** bị skip + báo cáo, **không** ghi row.

Test **phải** có case idempotent: chạy 2 lần, lần 2 skip, không sinh revision 2.

Test tự viết reader riêng rồi tự assert bằng nó là **vacuous pass**, không phải bằng chứng.

### 2.3. Báo cáo

- Danh sách slug xử lý, **danh sách** người thua kèm lý do.
- Bảng map: source key → `slug` / `revision` / `status` / `tenant_id` / `digest` / số origin đã approve.
- Danh sách origin đã approve cho mỗi schema.
- Danh sách schema bị skip vì egress không derive được, kèm lý do cụ thể.
- Mọi `Open items`.

## 3. Ranh giới (bắt buộc)

- **KHÔNG** chạy migration lên DB thật. Chỉ test offline.
- **KHÔNG** đọc DB production/legacy để lấy fixture.
- **KHÔNG** sửa `0037` hay bất kỳ file migration nào.
- **KHÔNG** sửa `lib/workflow-builder/loader.ts` hay `app/api/v1/docs/workflows/schema/route.ts` — chỉ đọc.
- **KHÔNG** sửa `workflow-schemas.ts`, `metadata-crypto.ts`, `packages/contracts/**` — **kể cả** để thêm `export`. Chỉ **gọi** hàm đã export.
- **KHÔNG** hardcode UUID tenant.
- **KHÔNG** bịa approved origin.
- **KHÔNG** commit, `git add`, push, không tick gate.

## 4. Acceptance criteria

- [ ] Gọi `provisionLegacyWorkflowSchema` thật làm writer — **không** tự seal/digest/INSERT
- [ ] `connectorSlotMap` do writer cấp, **không** phải rỗng
- [ ] `approvedEgressOrigins` derive từ URL tĩnh HTTPS; egress động/non-HTTPS → skip + báo cáo
- [ ] `tenant_id` là **UUID resolve theo name**, không phải chuỗi `legacy-default`, không phải UUID dev-fallback
- [ ] Quy tắc trùng `updatedAt` chạy đúng; **danh sách** người thua kèm lý do
- [ ] Idempotent: skip nếu active row đã tồn tại; `SCHEMA_REVISION_CONFLICT` được coi là skip
- [ ] **Test round-trip writer production → reader production** trên cùng fake db
- [ ] **Test có case chứng minh hàng chưa seal bị từ chối** (`SCHEMA_CRYPTO_UNAVAILABLE`)
- [ ] **Test có case connector schema round-trip**
- [ ] **Test có case egress tĩnh round-trip + egress động skip**
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số slug, số skip, mọi origin đã approve, mọi `Open items`

## 5. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu bất kỳ điều nào sau đây xảy ra:

- `provisionLegacyWorkflowSchema` không dùng được như writer (ví dụ: chữ ký đổi, hoặc nó ghi thêm nguồn ngoài `db`)
- `expectedRevision: null` không có semantics assert-absent như mô tả ở §1.6
- `metadata-crypto` seal yêu cầu key không có trong môi trường offline
- `appSettings` không có PK/unique để chốt quy tắc trùng `updatedAt`
- Bất kỳ yêu cầu nào ở §3.

**Dừng đúng cách là hành vi được chấp nhận** — R1, R2, R3 bạn đã đúng và R4 sẽ không phạt.

## 6. Dispatch proof

- **Request ID:** `LDBA-06-R4-2026-10-09`
- **Owner:** `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` — đã đọc màn hình, **IDLE tại prompt**
- **Dependency evidence:** LDBA-06 R3 receipt (stop đúng lần 3) + coordinator verify trên `legacy-workflow.ts:152-177` (slot map), `:329-370` (egress), `:179-195` (allocator export), `workflow-schemas.ts:205-337` (writer production), `:221-224` + `:234` (`expectedRevision: null` = assert-absent), `lib/workflow-builder/types.ts:24-34` + `:93-118` (node legacy), `profile-callback.ts:259-277` (origin shape)
- **Acceptance:** writer production → reader production round-trip + connector case + egress tĩnh/động case + unsealed rejection + idempotent skip
