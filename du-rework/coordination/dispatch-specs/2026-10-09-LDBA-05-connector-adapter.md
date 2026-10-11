# DISPATCH — LDBA-05 — Adapter connector: `ExternalApiConnection` → `connector_revisions` + `secret_versions`

**Task ID:** `LDBA-05`
**Repo scope:** `D:/Git/dugate` — đọc `lib/db/schema.ts` (root, bảng `ExternalApiConnection` + `ExternalApiOverride`) + `du-rework/orchestrator/services/connector/src/db/migrations/**` (đặc biệt `001_connector.sql` + `006_connector_revision_lifecycle.sql`) + `du-rework/orchestrator/services/connector/src/**`. **VIẾT DUY NHẤT:** module adapter mới (path do bạn tự chọn) + test riêng của module đó + receipt `du-rework/coordination/reports/ldba-05-connector-adapter.md`
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (§3.4 L1/L2, §4.5, §6.1, §7 R5, §8 dòng LDBA-05)
**Owner:** terminal `term_ca784044-5910-4d55-9d41-36c1d90fcf24` (đã đọc màn hình: **IDLE tại prompt**; trước đó làm connector screen `connectors-screen.tsx:485` — đúng domain connector).
**Dependencies:** LDBA-01 **ACCEPTED** (verdict L1..L7) + LDBA-02 **ACCEPTED** (gate đã mở) + LDBA-00 **VERIFIED** (mapping `ExternalApiConnection` → connector)
**Mode:** thiết kế + viết module + test offline. **KHÔNG** chạy migration lên DB thật. **KHÔNG** đọc DB production/legacy để lấy fixture.
**Receipt path:** `du-rework/coordination/reports/ldba-05-connector-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

Legacy `ExternalApiConnection` là **một hàng phẳng**: `authSecret` nằm thẳng trong cột `text` cùng URL, prompt, tên field. Rework tách nó đôi: `connector_revisions` (config) + `secret_versions` (byte mã hoá, bản versioned). Không có chuyển đổi nào tự động đúng — đặc biệt là phần secret.

## 1. Việc cần làm

### 1.1. **Id giữ TEXT — không cast sang uuid**

`001_connector.sql` khai `connector_revisions.connector_id TEXT`, `secret_versions.id TEXT PRIMARY KEY`, `connector_invocations.invocation_id TEXT`, `connector_usage_outbox.event_id TEXT`. Tất cả là TEXT.

§4.2 của plan nói validate id trước khi cast — nhưng luật đó áp dụng cho **cột uuid**. Ở connector, **không có cột nào là uuid**. Mọi id connector phải **giữ nguyên dạng text**.

- Đọc `001_connector.sql` và **xác nhận** điều này bằng file:line trong receipt.
- Nếu bạn thấy chỗ nào trong code connector đang cast id sang uuid — **ghi `Open items for coordinator`**, không sửa.

### 1.2. `authSecret` → `credential_ref` + `secret_versions.encrypted_value`

Legacy `authSecret` là **plaintext trong cột text**. Rework `secret_versions.encrypted_value` là `BYTEA` **đã mã hoá**.

**Không bao giờ** ghi plaintext thẳng vào `encrypted_value` — đó là một giá trị không mã hoá nằm trong cột tưởng là mã hoá, mọi đường đọc sau đó sẽ giải mã sai mà không báo lỗi.

Bạn phải:
- Chốt cách mã hoá: dùng cơ chế mã hoá hiện hữu của connector (đọc `services/connector/src/**` để tìm, đừng tự chế).
- Xác nhận **key** mã hoá lấy ở đâu, và điều gì xảy ra nếu key đó không tồn tại lúc migrate → **báo dừng dòng đó**, không ghi ciphertext rỗng.
- `credential_ref` sinh thế nào (uuid hay chuỗi?) — chốt và ghi rõ.
- `secret_versions` bản versioned: bản đầu là revision nào, `rotated_at` lấy từ đâu.

### 1.3. Gom field config vào `config jsonb` versioned

Legacy có nhiều cột phẳng — `name`, `slug`, `description`, `endpointUrl`, `httpMethod` (default `POST`), `authType` (default `API_KEY_HEADER`), `authKeyHeader` (default `x-api-key`), `promptFieldName` (default `query`), `fileFieldName` (default `files`), `fileUrlFieldName`, `defaultPrompt`, `responseContentPath` (default `content`), `sessionIdResponsePath`, `sessionIdFieldName`.

- Đọc lại `lib/db/schema.ts` để chốt **chính xác** danh sách cột và default.
- Thiết kế shape `config jsonb`: **không** đổi tên field, **không** gộp/lạc bỏ trường, và ghi bảng ánh xạ field legacy → key trong config vào receipt.
- `slug` là unique ở legacy — kiểm tra nó có vai trò gì ở rework (adapter identifier hay cấu hình nghiệp vụ) trước khi map.
- **`revision = 1`** cho hàng đầu tiên.

### 1.4. `state` → ACTIVE / DISABLED

`006_connector_revision_lifecycle.sql:16-21` chỉ cho `ACTIVE` / `DISABLED`. Legacy `state` (default `ENABLED`) không nằm trong union đó.

- Bảng map **tường minh**.
- Trạng thái legacy không map được → **báo dòng**, không tự đoán trạng thái.
- Ghi rõ việc **đổi tên** `ENABLED` → `ACTIVE` là đổi nghĩa tên, không phải đổi nghĩa trạng thái — nếu bạn thấy chỗ nào nghĩa khác, phải nêu ra.

### 1.5. `updatedAt` MISSING trên `connector_revisions`

LDBA-00 ghi `ExternalApiConnection.updatedAt` (`schema.ts:94`) là **MISSING** — bảng `connector_revisions` trong `001_connector.sql` chỉ có `created_at`, không có `updated_at`.

- Xác nhận bằng cách đọc `001_connector.sql`.
- **Không** thêm cột `updated_at` — LDBA-02 đã chốt không cần DDL additive, nên phát hiện của bạn phải được nêu rõ là bằng chứng ngược lại, không tự thêm.
- Nêu cách bù: thời điểm sửa đổi được suy ra từ revision mới nhất (`max(revision)`), hay không suy ra được nữa.

### 1.6. `ExternalApiOverride` → `connector_prompt_overrides`

LDBA-00 map bảng này sang `connector_prompt_overrides`. Bạn phải đọc migration đích, chốt cách gắn override vào revision cụ thể (không gắn vào connector id trần — sẽ mất nghĩa versioned), và ghi rõ `apiKeyId`/`endpointSlug`/`stepId` legacy map thế nào.

## 2. Ranh giới (bắt buộc)

- **KHÔNG** chạy migration lên DB thật. Chỉ test offline với dữ liệu tự dựng.
- **KHÔNG** đọc DB production/legacy để lấy fixture.
- **KHÔNG** sửa `001_connector.sql`, `006_connector_revision_lifecycle.sql` hoặc bất kỳ file migration nào.
- **KHÔNG** thêm cột — kể cả `connector_revisions.updated_at`.
- **KHÔNG** ghi plaintext vào `secret_versions.encrypted_value`.
- **KHÔNG** cast id connector sang uuid.
- **KHÔNG** sửa source connector hiện hữu trừ khi bạn **chủ động** đề xuất và chờ coordinator duyệt lease.
- **KHÔNG** commit, `git add`, push, không tick gate.

## 3. Acceptance criteria

- [ ] Xác nhận bằng file:line rằng id connector (`connector_id`, `secret_versions.id`, invocation, outbox) đều là **TEXT**
- [ ] `authSecret` được mã hoá bằng cơ chế **hiện hữu** của connector; test chứng minh plaintext không bao giờ nằm trong `encrypted_value`
- [ ] Thiếu encryption key → **báo dừng dòng**, không ghi ciphertext rỗng
- [ ] Bảng map field legacy → key trong `config jsonb` ghi trong receipt; không đổi tên, không gộp, không lạc bỏ
- [ ] `revision = 1` cho hàng đầu
- [ ] Bảng map `state` tường minh; giá trị ngoài union **báo dòng**
- [ ] Xác nhận `connector_revisions` **không** có `updated_at`; **không** thêm cột; nêu cách bù thời điểm sửa đổi
- [ ] `ExternalApiOverride` → `connector_prompt_overrides` gắn vào revision cụ thể
- [ ] Test **không** dùng dữ liệu từ DB thật
- [ ] File không có ký tự nháy kép, không trailing whitespace
- [ ] Báo lại: số connector test, số field map, số state ngoài union, mọi `Open items`

## 4. Dispatch proof

- **Request ID:** `LDBA-05-2026-10-09`
- **Owner:** `term_ca784044-5910-4d55-9d41-36c1d90fcf24` — đã đọc màn hình trước khi chọn, **IDLE tại prompt** (trước đó: connector screen `connectors-screen.tsx:485`)
- **Dependency evidence:** LDBA-01 ACCEPTED (L1..L7) + LDBA-02 ACCEPTED (gate đã mở) + LDBA-00 VERIFIED (mapping `ExternalApiConnection` → connector, `updatedAt` MISSING ở `:94`)
- **Acceptance:** giữ TEXT id + mã hoá secret bằng cơ chế có sẵn + config versioned `revision=1` + bảng map state tường minh + không thêm cột + test offline