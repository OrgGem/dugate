# DISPATCH — LDBA-06 R2 — Adapter workflow schema (sửa đổi sau receipt 1)

**Task ID:** `LDBA-06-R2`
**Repo scope:** `D:/Git/dugate` — đọc `lib/workflow-builder/loader.ts` (root) + `lib/db/schema.ts` (root, bảng `appSettings`) + `du-rework/orchestrator/services/orchestrator/migrations/0037_legacy_workflow_schema_catalog.sql` + `du-rework/orchestrator/services/orchestrator/src/modules/workflow-schemas/**` + `du-rework/orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts`. **VIẾT DUY NHẤT:** module adapter mới (path do bạn tự chọn) + test riêng của module đó + receipt `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md` (ghi đè bản R1)
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` — **đọc lại §4.1 và §4.6, cả hai vừa được coordinator đính chính**
**Owner:** terminal `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` (đã đọc màn hình: **IDLE tại prompt**; đúng domain workflow)
**Dependencies:** LDBA-01 ACCEPTED · LDBA-02 ACCEPTED · LDBA-00 VERIFIED · **LDBA-06 R1 receipt đã review + 2 conflict đã chốt**
**Mode:** thiết kế + viết module + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet R2

Packet R1 bạn **dừng đúng** trước khi viết code, và cả hai lý do dừng đều **đã được coordinator verify độc lập trên source** và **đã chốt xong**. Packet này chỉ nhận lại các quyết định đó — **không** phải yêu cầu bạn tự tìm lại.

Bạn **không** cần dừng nữa vì hai lý do này nữa. Nhưng vẫn **phải dừng** nếu gặp xung đột mới.

## 1. Quyết định coordinator đã chốt — áp dụng, không tranh luận

### 1.1. Digest — dùng hàm digest của catalog, bọc envelope 3 khoá

Coordinator đã xác nhận trên `src/modules/workflow-schemas/workflow-schemas.ts`:
- `schemaDigest` (`:70-76`) hash `canonicalLegacyWorkflowPinBytes(schema, connectorSlotMap, approvedEgressOrigins)` — **không** phải raw JSON.
- `parseStoredEnvelope` (`:88-90`) **từ chối** mọi giá trị không có **đúng 3 khoá**.
- `parseStoredPin` (`:116-125`) **tính lại** rồi ném `SCHEMA_INVALID` khi lệch `row.digest`.

⇒ Công thức raw-JSON trong §4.6 cũ **sai** và **đã bị thay**. Bạn làm đúng 4 việc:

1. **Bọc** schema legacy thành envelope đúng 3 khoá: `schema` = object đã parse, `connectorSlotMap` = object rỗng (legacy không có khái niệm tương đương), `approvedEgressOrigins` = mảng rỗng.
2. `digest` = `sha256:` + hex của `canonicalLegacyWorkflowPinBytes(...)` trên **đúng 3 giá trị đó**. **Tái dùng nguyên văn hàm digest của catalog** nếu nó export được; nếu không export được, **tái tạo đúng công thức** và **ghi rõ** trong receipt là bản sao chứ không phải hàm gốc.
3. `schema_ref` phải **đã seal** qua cơ chế hiện hữu (`metadata-crypto` seal). Read path từ chối plaintext — bạn đã tự chứng minh điều này ở R1, giữ nguyên kết luận.
4. **KHÔNG** sửa `0037`, **KHÔNG** nới integrity check.

### 1.2. Tenant — `legacy-default` là TÊN, không phải UUID

`tenants` có **cả hai**: `id uuid PK DEFAULT gen_random_uuid()` và `name text NOT NULL` (`0001_platform_v1.sql:7-12`), không có UNIQUE trên `name`.

⇒ `legacy-default` là **tên logic**, **không bao giờ** ghi chuỗi này vào cột `tenant_id`.
⇒ **Chốt:** seed `INSERT INTO tenants (name) VALUES (legacy-default)` để `id` do `gen_random_uuid()` sinh; adapter **resolve UUID theo name tại runtime** (`SELECT id FROM tenants WHERE name = ...`), **không hardcode UUID**.
⇒ **KHÔNG** tái dùng `00000000-0000-0000-0000-000000000001` — đó là dev/fixture fallback trong `create-app.ts:290-295`.

### 1.3. Trùng `updatedAt` — chốt quy tắc, không đoán

Nếu nhiều hàng cùng slug có `updatedAt` **bằng nhau**, quy tắc **chốt**: lấy hàng có **`key` lớn nhất theo thứ tự so sánh chuỗi tất định** (byte-order, không phải locale). Cột `key` là PK của `appSettings` nên luôn phân định.
⇒ **Nếu cột không có PK/unique**, bạn **dừng** và ghi `Open items for coordinator`.
⇒ Mọi hàng bị loại — kể cả hàng bị loại vì trùng `updatedAt` — phải vào **danh sách** trong receipt, kèm lý do loại.

### 1.4. Nguồn chân lý của route — chốt: giữ nguyên, tách lease

Coordinator chọn **phương án 1**: route `app/api/v1/docs/workflows/schema/route.ts` **tiếp tục đọc** `appSettings` ở v1. Lý do: route không có ngữ cảnh tenant, và đổi nó là thay đổi **wire behaviour** nằm ngoài scope backfill.
⇒ Packet này **chỉ** ghi vào catalog. **KHÔNG** sửa route, **KHÔNG** sửa loader. Việc chuyển route sang catalog mở packet riêng, sau khi LDBA-06 có dữ liệu thật.

## 2. Việc còn lại

### 2.1. `revision = 1`, `status = active`, idempotent

- PK `(tenant_id, slug, revision)`; chạy lại không sinh trùng.
- Slug đã tồn tại → **skip**, không ghi đè.
- Test chứng minh chạy 2 lần cho cùng kết quả.

### 2.2. Tiêu chí nghiệm thu đã nâng cấp

Test **không được** chỉ assert format regex `^sha256:[0-9a-f]{64}$`.
Test **phải** chứng minh hàng ghi ra **đọc lại được bằng chính `parseStoredPin` của catalog**. Đây là tiêu chí mới, R1 chưa có.

Nếu `parseStoredPin` không export được, bạn **dừng** và ghi `Open items for coordinator` — **không** tự viết lại một bản reader riêng rồi tự assert bằng nó. Test tự viết reader riêng là **vacuous pass**, không phải bằng chứng.

### 2.3. Báo cáo

- Danh sách slug xử lý, **danh sách** người thua kèm lý do.
- Bảng map: source key → `slug` / `revision` / `status` / `tenant_id` / `digest` / `schema_ref` shape.
- Mọi `Open items`.

## 3. Ranh giới (bắt buộc)

- **KHÔNG** chạy migration lên DB thật. Chỉ test offline.
- **KHÔNG** đọc DB production/legacy để lấy fixture.
- **KHÔNG** sửa `0037` hay bất kỳ file migration nào.
- **KHÔNG** sửa `lib/workflow-builder/loader.ts` hay `app/api/v1/docs/workflows/schema/route.ts` — chỉ đọc.
- **KHÔNG** sửa `workflow-schemas.ts` hay `metadata-crypto.ts` hiện hữu, **trừ khi** bạn **chủ động** đề xuất và chờ coordinator duyệt lease.
- **KHÔNG** hardcode UUID tenant.
- **KHÔNG** commit, `git add`, push, không tick gate.

## 4. Acceptance criteria

- [ ] Đọc lại §4.1 và §4.6 của plan (đã đính chính) và làm theo
- [ ] Envelope đúng **3 khoá**; `digest` bằng canonical-pin digest, không phải hash raw JSON
- [ ] `schema_ref` **đã seal**; không ghi plaintext
- [ ] `tenant_id` là **UUID resolve theo name**, không phải chuỗi `legacy-default`, không phải UUID dev-fallback
- [ ] `revision = 1`, `status = active`
- [ ] Quy tắc trùng `updatedAt` chạy đúng; **danh sách** người thua kèm lý do
- [ ] Idempotent: chạy 2 lần không sinh trùng; slug đã tồn tại → skip
- [ ] **Test chứng minh đọc lại được bằng `parseStoredPin` thật** — không assert regex đơn thuần
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số slug test, số người thua, mọi `Open items`

## 5. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu bất kỳ điều nào sau đây xảy ra:
- `parseStoredPin` không export được, hoặc cần sửa `workflow-schemas.ts` để tái dùng
- `metadata-crypto` seal yêu cầu key không có trong môi trường offline
- `appSettings` không có PK/unique để chốt quy tắc trùng `updatedAt`
- Bất kỳ yêu cầu nào ở §3.

**Dừng đúng cách là hành vi được chấp nhận** — R1 bạn đã làm đúng và R2 này sẽ không phạt.

## 6. Dispatch proof

- **Request ID:** `LDBA-06-R2-2026-10-09`
- **Owner:** `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` — đã đọc màn hình, **IDLE tại prompt**
- **Dependency evidence:** LDBA-06 R1 receipt (2 conflict) + coordinator verify trên `workflow-schemas.ts:70-76, 88-90, 116-125` + `0037:5` + `0001:7-12` + `metadata-crypto.ts`
- **Acceptance:** envelope 3 khoá + canonical-pin digest + tenant UUID theo name + idempotent + **đọc lại được bằng `parseStoredPin` thật**