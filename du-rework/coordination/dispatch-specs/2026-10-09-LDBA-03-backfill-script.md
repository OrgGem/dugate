# DISPATCH — LDBA-03 — Lớp B: backfill/transform script idempotent

**Task ID:** `LDBA-03`
**Repo scope:** `D:/Git/dugate` — đọc `lib/db/schema.ts` (root, drizzle legacy) + `du-rework/orchestrator/services/orchestrator/migrations/**` + `du-rework/orchestrator/services/connector/src/db/migrations/**` + tài liệu §4 của plan. **VIẾT DUY NHẤT:** script backfill mới (path do bạn tự chọn, đặt ngoài `migrations/` để không lẫn với DDL) + test riêng của script đó + receipt `du-rework/coordination/reports/ldba-03-backfill.md`
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (§4.1 đến §4.6, §5 Lớp B, §7 R2/R4/R6, §8 dòng LDBA-03)
**Owner:** `codex_worker_4` — terminal `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (đã đọc màn hình: **IDLE tại prompt**, vừa xong LDBA-02, 7m 22s). Giữ nguyên vai trò chủ schema sâu nhất của chuỗi LDBA-00/01/02.
**Dependencies:** LDBA-02 **ACCEPTED** 2026-10-09 (gate đã mở) + LDBA-01 **ACCEPTED** (verdict L1..L7 + 6 transform) + LDBA-00 **VERIFIED** (9 bảng mapping)
**Mode:** thiết kế + viết script + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-03-backfill.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

LDBA-02 đã chốt: **không cần thêm cột nào**. Điều đó không có nghĩa là dữ liệu đã nằm đúng chỗ — còn tám bảng legacy viết bằng Drizzle với tên vật lý PascalCase, kiểu `text`, JSON lưu dạng chuỗi, không có tenant. Lớp B là chỗ duy nhất biến chúng thành hàng của rework.

**Đây là packet rủi ro cao nhất của cả chuỗi LDBA.** Ba luật không được nới:

1. **Idempotent + chạy lại được.** Không có down-migration. Chạy 2 lần phải cho kết quả giống hệt lần 1.
2. **Fail rõ, không nuốt.** JSON hỏng, id không parse được uuid, giá trị ngoài miền — phải **báo từng dòng**, không ghi NULL im lặng. Suy ra từ R2 trong §7.
3. **Không đọc DB thật để lấy fixture.** Dữ liệu test phải là dữ liệu bạn tự dựng trong test.

## 1. Việc cần làm

### 1.1. Chốt **diễn giải timestamp UTC** trước tiên

Đây là điểm dễ sai nhất và là **tiền đề** cho mọi phép ghi timestamp còn lại. Legacy Drizzle khai `timestamp(createdAt, { mode: date, precision: 3 })` — **không có** `withTimezone`, tức vật lý là `timestamp without time zone`. Rework dùng `timestamptz`.

LDBA-00 đã ghi vấn đề này ở 6 chỗ (`ldba-00-schema-mapping.md`, các dòng nêu `:44`, `:61`, `:73`, `:87`, `:131`, `:146`, `:157` của `lib/db/schema.ts`) và chưa chốt. Bạn phải:

- Đọc lại đúng 6 cột đó trên `lib/db/schema.ts` và xác nhận danh sách.
- Kiểm tra timezone server mà app legacy thực sự chạy (đọc config/compose, không cần DB).
- **Chốt một quy ước duy nhất** cho toàn bộ backfill: ví dụ coi mọi `timestamp without time zone` của DB cũ là **UTC**, và ghi vào cột `timestamptz` bằng `at time zone UTC`.
- Nêu rõ **hệ quả** nếu quy ước sai: mọi operation cũ lệch một lượng offset cố định, và lệch đó **không tự hiện** trên báo cáo nào.

Quy ước này áp dụng cho: `Operation.createdAt/updatedAt/deletedAt`, `ApiKey.createdAt/updatedAt`, `ExternalApiConnection`, `ExternalApiOverride`, `ProfileEndpoint`, `AppSetting`, `User`, `UserProfileAssignment`.

### 1.2. Map `state` và `status`

- `Operation.state` cũ (chuỗi tự do trong text) sang từ vựng trạng thái rework. **Đọc kỹ trước phần chuyển:** rework lưu `state` là `text` chứ không phải PostgreSQL enum, và `done` chỉ là **projection** suy ra qua `isTerminalState()` (`legacy-host-adapter.ts:474`) — đã xác minh trong LDBA-02. Vậy đừng cố ép giá trị lạ vào miền hẹp; hãy chốt: giá trị nào map thẳng, giá trị nào không map thì **báo và dừng dòng đó**, không tự đoán.
- `ApiKey.status` cũ (`active` chữ thường, `schema.ts:62`) sang `api_keys.status` (`0001:19`) — LDBA-00 ghi rõ **PARTIAL: normalize values và case**, phải validate allowed statuses.
- `ExternalApiConnection.state` cũ (`ENABLED`/khác, `schema.ts:92`) sang union trạng thái revision connector (`006_connector_revision_lifecycle.sql:16-21` chỉ cho `ACTIVE`/`DISABLED`). Cần bảng map **tường minh**, trạng thái legacy không có trong union thì báo.

### 1.3. JSON: mặc định parse, **hai ngoại lệ đã chốt**

Theo §4.5. Parse `pipelineJson`, `stepsResultJson`, `extractedData`, `usageBreakdown`, `parameters`, `connectionsOverride`, `staticFormFields`, `extraHeaders`.

**Hai ngoại lệ — tuyệt đối không parse JSON:**
- `allowedFileExtensions` là **CSV text** (`0026_profile_policy.sql:54-60`) sang `allowed_file_extensions text`. Giữ nguyên chuỗi CSV.
- `fileUrlAuthConfig` là chuỗi mã hoá ba phần `iv:tag:ciphertext` sang `file_url_auth_cipher text`. Validate đúng 3 phần, giữ nguyên dạng cipher.

Quy tắc: danh sách ngoại lệ phải **tường minh trong code**, không suy diễn từ tên cột.

### 1.4. Trường suy ra, không copy thẳng

- **Tenant:** seed **một** tenant `legacy-default`; mọi hàng backfill trỏ về tenant này (§4.1).
- **Business/action/correlation:** `operations` rework có `business_id`, `business_version`, `action`, `correlation_id` (`0001:38,40-42,50`) mà legacy `Operation` **không có**. Suy ra qua bảng mapping `endpointSlug` → `business`/`action` từ registry hiện có. **Nếu một `endpointSlug` không map được thì báo dòng đó, không tự bịa** — đây là R5 trong §7.
- **`FileCache.refCount`** và **`lastAccessedAt`** (`schema.ts:163,165`) không có cột đích — LDBA-00 ghi MISSING/DERIVED. Không copy số liệu cũ làm số đích không có chủ sở hữu. Ghi `refCount` chỉ khi bạn **định nghĩa được** cách đếm lại từ tham chiếu còn sống; nếu không thì để null và **tuyên bố** điều đó trong receipt.
- **`FileCache.s3Key`** (`schema.ts:159`) trỏ tới nội dung S3 bên ngoài; rework có `artifacts.storage_key` (`0001:141`) và `artifact_blobs.bytes` (`0003:9`). Chọn và **ghi rõ** backend/version nào là chân lý, và điều gì xảy ra với byte thật.
- **Chi phí:** `operations.total_cost_usd` giữ **USD thập phân** `numeric(20,6)` (`0024:61`). Khi cần budget mới quy đổi sang micro-USD **tại điểm ghi**. **Không** coalesce NULL → 0 cho operation SUCCEEDED — luật `0024:21-23` viết rõ đó là dối.

### 1.5. Id: validate rồi mới cast

§4.2 + R6. Mọi id legacy là `text` chứa uuid hợp lệ. **Validate toàn bộ giá trị cũ parse được uuid trước khi ghi.** Giá trị lạ phải **fail rõ theo danh sách**, không tự sinh id mới, không nuốt.

**Ngoại lệ phải giữ text:** `connector_revisions.connector_id`, `secret_versions.id` và mọi invocation id trong connector là `TEXT` theo `001_connector.sql` — **không cast sang uuid** cho các cột đó.

### 1.6. Idempotency + báo cáo

- Script phải chạy lại được không sinh trùng. Nghĩ tới khoá tự nhiên: `operations.id`, `api_keys.id`, `legacy_workflow_schemas (tenant_id, slug, revision)`, connector theo `(connector_id, revision)`.
- Xuất báo cáo: **bao nhiêu hàng đọc / ghi / skip / fail**, và **danh sách dòng lỗi** (không chỉ số đếm).
- **Không xoá dữ liệu cũ.** Một chiều.

### 1.7. Ràng buộc A1

§5: **A1 (view đối chiếu) chạy trước A2**. Script này là A2. Nếu bạn thấy chỗ nào bắt buộc phải sửa trước khi A1 xanh — **ghi vào receipt, không tự quyết**.

## 2. Ranh giới (bắt buộc)

- **KHÔNG** chạy script lên bất kỳ DB thật nào (kể cả DB rehearsal). Chỉ chạy test với dữ liệu bạn tự dựng.
- **KHÔNG** viết file migration DDL. Nếu phát hiện thiếu cột/index/constraint thật, ghi `Open items for coordinator` — LDBA-02 đã chốt là **không cần cột nào**, nên phát hiện của bạn sẽ là bằng chứng ngược lại và phải được nêu rõ, không tự thêm.
- **KHÔNG** sửa source, test hiện hữu, migration, plan, docs của lane khác.
- **KHÔNG** commit, `git add`, push, không tick gate.
- **KHÔNG** đụng `services/orchestrator/src/**` trừ khi bạn **chủ động** đề xuất và chờ coordinator duyệt lease — mặc định script + test của bạn phải tự chứa.

## 3. Acceptance criteria

- [ ] Quy ước UTC cho 6+ cột timestamp được **chốt bằng lý do**, ghi cả hệ quả nếu sai
- [ ] Bảng map `state` và `status` tường minh; giá trị ngoài miền **báo dòng**, không tự đoán
- [ ] JSON parse mặc định + **2 ngoại lệ** (CSV `allowedFileExtensions`, cipher `fileUrlAuthConfig`) nằm trong danh sách tường minh trong code
- [ ] `total_cost_usd` giữ USD thập phân; **không** coalesce NULL → 0 cho SUCCEEDED (trích `0024:21-23`)
- [ ] Mọi id cast uuid đều đã validate; **connector id / secret_versions.id giữ TEXT**
- [ ] Tenant `legacy-default` seed một lần, mọi hàng trỏ về tenant đó
- [ ] Test chứng minh: chạy 2 lần cho kết quả giống hệt; JSON hỏng **fail rõ** chứ không ghi NULL; id lạ **fail rõ**
- [ ] Báo cáo skip/fail **có danh sách dòng lỗi**, không chỉ số đếm
- [ ] Receipt nêu rõ `refCount` / `lastAccessedAt` / `s3Key` xử lý thế nào và vì sao
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số bảng xử lý, số quy tắc chuyển đổi, mọi `Open items`

## 4. Dispatch proof

- **Request ID:** `LDBA-03-2026-10-09`
- **Owner:** `codex_worker_4` / `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` — đã đọc màn hình trước khi chọn, **IDLE tại prompt** (vừa xong LDBA-02, 7m 22s)
- **Dependency evidence:** LDBA-02 ACCEPTED (§8.1.3, gate LDBA-03 đã mở) + LDBA-01 ACCEPTED (L1..L7 + 6 transform, `0023` trích sai đã sửa qua LDBA-01-C1) + LDBA-00 VERIFIED (9 bảng, timestamp issue ở 6 dòng)
- **Acceptance:** script idempotent + transform §4.1..§4.6 + test offline + báo cáo skip/fail có danh sách dòng
