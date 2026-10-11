# DISPATCH — LDBA-06 — Adapter workflow schema: `wb_schema:*` → `legacy_workflow_schemas`

**Task ID:** `LDBA-06`
**Repo scope:** `D:/Git/dugate` — đọc `lib/workflow-builder/loader.ts` (root) + `lib/db/schema.ts` (bảng `appSettings`) + `du-rework/orchestrator/services/orchestrator/migrations/0037_legacy_workflow_schema_catalog.sql` + `du-rework/orchestrator/services/orchestrator/src/**` (provisioning hiện hữu). **VIẾT DUY NHẤT:** module adapter mới (path do bạn tự chọn) + test riêng của module đó + receipt `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md`
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (§4.6, §6.1, §7 R5, §8 dòng LDBA-06)
**Owner:** terminal `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` (đã đọc màn hình: **IDLE tại prompt**; trước đó làm workflow investigation `investigate-node-version-red` — đúng domain workflow).
**Dependencies:** LDBA-01 **ACCEPTED** (verdict L1..L7) + LDBA-02 **ACCEPTED** (gate đã mở) + LDBA-00 **VERIFIED** (mapping workflow)
**Mode:** thiết kế + viết module + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-06-workflow-schema-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

Legacy lưu workflow schema dưới dạng **JSON plaintext** trong bảng `appSettings` với key `wb_schema:<slug>`. Rework có bảng riêng `legacy_workflow_schemas` với `revision`, `digest`, `status`, và `schema_ref jsonb` phải chứa **envelope đã seal** — provisioning **từ chối ghi plaintext**.

Đây là packet có **tension cần chứng minh**, không phải chuyển đổi thẳng.

## 1. Việc cần làm

### 1.1. Chốt tension seal vs plaintext

`0037_legacy_workflow_schema_catalog.sql` khai `schema_ref jsonb NOT NULL CHECK (jsonb_typeof(schema_ref) = object)` và comment nêu rõ: `schema_ref` luôn chứa **envelope đã seal**; provisioning **từ chối ghi plaintext**.

Legacy blob là **plaintext JSON**. Nên:

- Đọc `0037` nguyên văn, trích **chính xác** câu comment về seal.
- Đọc code provisioning hiện hữn trong `services/orchestrator/src/**` để xác nhận nó **thực sự** từ chối plaintext (không chỉ comment).
- Trong receipt, **tuyên bố rõ**: packet này ghi plaintext vào `schema_ref` là **vi phạm** ràng buộc của `0037`, hay là `0037` cần được sửa để cho phép plaintext trong backfill window?

**Đây là quyết định của coordinator, không phải của bạn.** Bạn phải:
- Nếu kết luận cần sửa `0037` → **dừng và ghi `Open items for coordinator`**, không tự sửa.
- Nếu kết luận có thể ghi plaintext mà không vi phạm (ví dụ: envelope seal có thể được tạo từ plaintext bằng cơ chế hiện hữn) → chứng minh bằng test.

### 1.2. `revision = 1`, `status = active`

§4.6: mỗi slug legacy thành **một** hàng `legacy_workflow_schemas` với `revision = 1`, `status = 'active'`.

- Chốt `tenant_id` = `legacy-default` (§4.1).
- Chốt `slug` lấy từ phần sau `wb_schema:` trong key `appSettings`.
- Chốt `digest` = `sha256:` + hex của **chuỗi JSON gốc** (không phải của envelope seal). Ghi rõ bạn digest cái gì, vì `0037` CHECK `^sha256:[0-9a-f]{64}$`.

### 1.3. Giữ mới nhất theo `updatedAt`, báo người thua

Legacy `appSettings` có `updatedAt`. Nếu cùng một slug có **nhiều** hàng (lạ nhưng có thể xảy ra nếu key bị ghi đè nhiều lần), §4.6 chốt: **giữ mới nhất theo `updatedAt`**, **báo người thua**.

- Chốt cách chọn người thắng.
- Chốt cách báo người thua: **danh sách** trong receipt, không chỉ số đếm.
- **Không** ghi đè người thua — chỉ ghi người thắng.

### 1.4. `app/api/v1/docs/workflows/schema/route.ts` đọc cùng key

Legacy route này (`route.ts:24`) đọc `wb_schema:<slug>` từ `appSettings`. Bạn phải:

- Đọc route đó, xác nhận nó đọc đúng key mà `loader.ts` ghi.
- Chốt: sau khi migrate, route đó có còn đọc từ `appSettings` (vẫn là nguồn chân lý cho legacy) hay chuyển sang `legacy_workflow_schemas`? **Đây là quyết định của coordinator** — bạn chỉ cần nêu rõ hai lựa chọn và hệ quả.

### 1.5. Idempotency

- PK `(tenant_id, slug, revision)` — chạy lại phải không sinh trùng.
- Nếu slug đã tồn tại → **skip**, không ghi đè.
- Test chứng minh: chạy 2 lần cho cùng kết quả.

## 2. Ranh giới (bắt buộc)

- **KHÔNG** chạy migration lên DB thật. Chỉ test offline với dữ liệu tự dựng.
- **KHÔNG** đọc DB production/legacy để lấy fixture.
- **KHÔNG** sửa `0037` hoặc bất kỳ file migration nào.
- **KHÔNG** sửa `lib/workflow-builder/loader.ts` hoặc `app/api/v1/docs/workflows/schema/route.ts` — chỉ đọc.
- **KHÔNG** tự quyết việc sửa `0037` cho phép plaintext — ghi `Open items for coordinator`.
- **KHÔNG** commit, `git add`, push, không tick gate.

## 3. Acceptance criteria

- [ ] Trích **chính xăc** câu comment về seal trong `0037`
- [ ] Xác nhận bằng file:line rằng provisioning **thực sự** từ chối plaintext
- [ ] Receipt tuyên bố rõ: ghi plaintext vào `schema_ref` là vi phạm `0037` hay cần sửa `0037`
- [ ] `revision = 1`, `status = 'active'`, `tenant_id = 'legacy-default'`
- [ ] `digest` = `sha256:` + hex của chuỗi JSON gốc; test chứng minh format đúng CHECK
- [ ] Giữ mới nhất theo `updatedAt`; **danh sách** người thua trong receipt, không chỉ số đếm
- [ ] Không ghi đè người thua
- [ ] Đọc `route.ts:24`, xác nhận đọc đúng key; nêu hai lựa chọn chân lý + hệ quả
- [ ] Test chứng minh: chạy 2 lần không sinh trùng; slug đã tồn tại → skip
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số slug test, số người thua, mọi `Open items`

## 4. Dispatch proof

- **Request ID:** `LDBA-06-2026-10-09`
- **Owner:** `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` — đã đọc màn hình trước khi chọn, **IDLE tại prompt** (trước đó: workflow investigation `investigate-node-version-red`)
- **Dependency evidence:** LDBA-01 ACCEPTED (L1..L7) + LDBA-02 ACCEPTED (gate đã mở) + LDBA-00 VERIFIED (mapping workflow)
- **Acceptance:** chốt tension seal vs plaintext + `revision=1` + digest đúng format + giữ mới nhất có danh sách người thua + idempotent + test offline