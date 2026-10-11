# PLAN — Adapter cho rework chạy trên DB cũ + bổ sung field — 2026-10-09

**Task:** `LDBA-00..07` (legacy-database adapter). **Trạng thái:** SPECIFIED — **đã chốt quyết định 2026-10-09** (xem `## 9`), **đang được thực thi** (xem `## 8.1`). **2026-10-09:** §6 field list đã **rút toàn bộ** sau quét consumer (§6.1, D6/§9.2) — LDBA-02 không còn sinh DDL; §3.4 chốt L6 (không thêm cột limit/concurrency).
Adapter: chưa IMPLEMENTED, chưa VERIFIED, chưa ACCEPTED. Plan này **không** tự kích hoạt migration lên bất kỳ DB nào.
**Repo scope:** phân tích đọc cả `D:/Git/dugate` (root, read-only) và `du-rework`; mọi thay đổi đề xuất nằm trong `du-rework`.
**Canonical plan cho yêu cầu này:** file này. Bổ trợ, không thay thế: `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`, `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` (CFGADM), `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md`.
**Dispatcher:** Claude Code theo `COORDINATOR-CONTRACT.md` — plan này là metadata, không phải product code.
**Sổ tay mở duy nhất:** [`PLAN-OPEN-2026-10-09.md`](PLAN-OPEN-2026-10-09.md) — tổng hợp mọi mục còn mở (LDBA + các plan khác + `tasks/` + coordination). Rà soát tiến độ thì đọc file đó, không đọc lần lượt từng plan.

---

## 0. Yêu cầu và kết luận điều chỉnh

User yêu cầu: kiểm tra chức năng portal + schema DB của DUGate cũ ở root, phân tích thành chức năng UI cho rework, **bổ sung adapter để rework chạy trên DB cũ và có thể bổ sung field trên DB**.

**Đây là một đảo ngược giả định có chủ đích so với thiết kế hiện hành.** Migration `0024_legacy_parity_columns.sql:26-30` và `docs/14-reference-compatibility.md:3` ghi rõ: *"legacy database is a separate deployment; rework is a fresh project with no data/credential migration."* Rework hiện coi DB cũ là **read-only reference**. Yêu cầu mới biến DB cũ thành **DB vận hành thật của rework**.

Hệ quả bắt buộc phải ghi nhận trước khi code:
1. `0024` **không** còn là "projection surface tuỳ chọn" — nó trở thành một phần của đường ghi thật.
2. Chính sách "additive-only, no down-migrations" (`0024:4-5`) phải giữ, vì giờ nó chạy trên DB có dữ liệu sống.
3. Cần một tầng **adapter schema** vì hai schema **không cùng tên bảng/cột** (§3), không chỉ khác kiểu dữ liệu.

Plan này KHÔNG tự quyết định chạy migration lên DB thật nào. Nó chốt mapping, chỉ ra 6 mismatch cứng, đề xuất kiến trúc adapter 3 lớp, và liệt kê field cần bổ sung — để owner thực thi dưới lease riêng.

**ĐIỀU CHỈNH 2026-10-09 (quét consumer thật):** danh sách "field cần bổ sung" ở §6 đã được **rút hết**. Kết quả quét toàn bộ `services/orchestrator/src` + `apps/admin-web/src`: **0/8 cột cũ đề xuất có consumer** trong rework. Mọi field legacy đều thuộc một trong: (a) không consumer, (b) đã có cơ chế thay thế rework-native (`artifacts`, `deleted_at`, `state` enum, bearer-token admin), (c) bị rework từ chối có chủ đích (`createdByUserId`). ⇒ **KHÔNG có DDL additive nào cần viết**; việc "bổ sung field trên db" của user không cần thiết ở lớp DB — adapter A1 (view/translation) là đủ. Chi tiết + bằng chứng từng cột: **§6.1**. Hành vi bị mất (per-user scoping, key-level admin) được nói thẳng ở **§6.2** để user quyết có mở packet riêng hay không.

---

## 1. Phương pháp

1. Đọc schema cũ: `lib/db/schema.ts` (211 dòng, 9 bảng, drizzle `pgTable`).
2. Đọc schema rework: `services/orchestrator/migrations/0001..0037` (37 file) + `services/connector/src/db/migrations/001..009`.
3. Đối chiếu bảng↔bảng, cột↔cột; đánh dấu khớp / thiếu / khác kiểu.
4. Đọc `docs/14-reference-compatibility.md`, receipt `0024`, `0026`, `0037`, `docs/04-data-state.md` để hiểu ý định thiết kế.
5. Đối chiếu chức năng portal cũ (`DUGATE_ADMIN_UI_FUNCTIONS.md`, `app/api/**`, `components/**`) với UI rework (`apps/admin-web/src/features/**`).
6. Không chạy DB/build/test (coordinator read-only). Đây là phân tích tĩnh trên working tree.

---

## 2. Inventory chức năng portal cũ → UI rework

Nguồn cũ: `DUGATE_ADMIN_UI_FUNCTIONS.md` (9 mục) + `app/api/**`. Đối chiếu route rework `apps/admin-web/src/routes/*.tsx` + `features/**`.
Trạng thái cột cuối là **đánh giá tĩnh của plan**, không phải verdict IMPLEMENTED/VERIFIED.

| # | Chức năng portal cũ (root) | Route cũ | UI rework tương ứng | Khoảng trống so với DB cũ |
|---|---|---|---|---|
| 1 | Dashboard giám sát (24h/7d/30d, requests/success/tokens/cost, breakdown profile) | `/dashboard`, `app/api/internal/analytics` | `features/overview` (`operations-monitor-dashboard.tsx`, `overview-metrics.ts`) + `features/usage` (`usage-screen.tsx`) | Cần `usage_events` — bảng cũ **không có**; aggregation phải dựng từ `Operation` |
| 2 | Lịch sử + chi tiết Operations (search/status/cancel/delete/HITL resume/download) | `/history`, `/operations/{id}` | `features/operations` (`operations-screen.tsx`, `state.ts`) | Khớp phần lớn qua `0024`; HITL cần map `WAITING_USER_INPUT`↔`WAITING_INPUT` |
| 3 | Profiles + API keys (create/rotate/delete, note, endpoint config, parameters lock/raw, cURL, AI Wizard, Test) | `/profiles`, `app/api/internal/apikeys`, `profile-endpoints`, `prompt-wizard`, `test-profile-endpoint` | `features/profiles` + `features/api-keys` | `ProfileEndpoint` 1 hàng → rework tách `profile_bindings` + `profile_names` + policy cols (`0026`); UI có `callback-policy`, `request-redaction` là **mới** |
| 4 | External API Connections (CRUD, import cURL, auth modes, multipart fields, dot-path, timeout, test) | `/api-connections`, `app/api/internal/ext-connections` | `features/connectors` (`connectors-screen.tsx`, `curl-import.ts`) | `ExternalApiConnection` (bảng phẳng) → `connector_revisions` (config jsonb) + `secret_versions`; adapter id phải suy từ auth/format |
| 5 | Workflow Builder (list/import JSON-XML/detail/override/run) | `/workflow-builder`, `app/api/internal/workflow-schemas` | `features/workflows` (`workflows-screen.tsx` — hiện chỉ banner Δ-DEV-03) | Schema cũ nằm trong `AppSetting` key `wb_schema:<slug>` → rework `legacy_workflow_schemas` (revision+digest+status) |
| 6 | Settings hệ thống (theme, S3 + cache, AI provider, prompts) | `/settings`, `app/api/settings` | `features/settings` (`catalog.ts` 17 key + `settings-screen.tsx`) | `AppSetting` KV → không có bảng 1-1; một phần vào `admin_crypto_config`, phần còn lại deployment-mechanism |
| 7 | Quản lý người dùng (CRUD/password/role/profile assignment, SSO) | `/settings/users`, `app/api/users`, `user-profiles` | `features/identity` (`identity-screen.tsx`, `identity-api.ts`) | `User` (bcrypt) → `admin_local_users` (scrypt, CHECK cứng) — **xung đột hash**, §4.3 |
| 8 | API Docs trên UI (Swagger) | `/api-docs`, `app/api/swagger` | `features/api-docs` (`api-docs-screen.tsx`) | Không đụng DB; chỉ đọc artifact OpenAPI |
| 9 | (không có ở cũ) Secrets catalog, Security, Businesses registry | — | `features/secrets`, `features/security`, `features/businesses` | Là **năng lực mới**, không map từ DB cũ |

**Kết luận mục 2:** mọi chức năng portal cũ đều có màn UI tương ứng ở rework. Khác biệt không nằm ở feature mà ở **hình dạng dữ liệu đứng sau**. Vì vậy trọng tâm plan là §3–§6 (schema adapter), không phải dựng thêm màn.

## 2b. Portal rework đã dời mount `/admin/web/` → `/admin/` (2026-10-09)

User báo đã cập nhật portal mới dùng path `/admin` và bổ sung tính năng UI. Đối chiếu working tree:

**a) Mount path** — `vite.config.ts` đổi `base: '/admin/web/'` → `base: '/admin/'`; `router.tsx` lấy `basename` từ `import.meta.env.BASE_URL` nên tự theo. Phía server **đã hỗ trợ cả ba** prefix: `shell-server.ts:493-497` nhận `/admin`, `/admin/web`, `/admin/portal`; `:601-605` rewrite về `effectiveBase`. ⇒ **Khớp, không có handoff lệch.**

**b) Tính năng UI mới** (đo bằng `git diff --numstat`, không suy từ tên file):

| Màn | Thay đổi | API mới |
|---|---|---|
| Toàn portal | **Global tenant selector** (`lib/tenant-context.tsx`, `components/ui/global-tenant-selector.tsx`) + Toast + GlobalErrorBoundary — tenant scope lên app-shell, không chỉ từng màn | — |
| Overview | +205/-55: rollup usage, audit 25 dòng, operations 100, businesses, **health**; `DataAgeLabel` báo tuổi dữ liệu; auto-refresh 10s | `getHealth()` |
| Operations | +421/-104: **bulk cancel** (chọn nhiều), filter **từ/ngày đến ngày** UTC, search theo id, correlation id, task list trong detail | `operationAction(id,'cancel',key)` |
| Usage / Secrets / Security / API keys | sửa nhỏ (96/-25, 20/-22, 19/-25, 26/-27) | `types.ts` +15 |

**c) Ảnh hưởng tới adapter (điểm mới, chưa nằm ở §3):**

1. **Tenant scoping toàn cục làm §4.1 nặng hơn.** UI đã có GlobalTenantSelector + localStorage `du_global_tenant_id`, tức UI **đã giả định có nhiều tenant**. Adapter seed **một** tenant `legacy-default` sẽ khiến selector chỉ có 1 lựa chọn — chấp nhận được (đúng bản chất DB cũ), nhưng **phải ghi rõ** trong receipt LDBA-02 để không ai hiểu nhầm là đã hỗ trợ multi-tenant.
2. **`getHealth()` cần DB thật.** `health.ts:79-96` đọc db/redis/queueIntegrity/outboxBacklog; DB cũ **không có** bảng `tasks`/`outbox` cho queueIntegrity. ⇒ Health phải fail-closed: DB probe hỏng ⇒ `status = degraded` + HTTP 503 (`health.ts:83`, nhánh `db === false`); `unknown` chỉ dành cho khi `db`/`redis` là `null` (`health.ts:84`), **không** được trả `0` để UI hiện "xanh giả". Đây là điều kiện bắt buộc cho LDBA-07. **Đính chính 2026-10-09** (theo receipt `reports/ldba-07-verify.md` §4 lưu ý 2): câu trước đây ghi kỳ vọng nhãn `unknown` là **sai nhãn** so với code thật; điều kiện cốt lõi (fail-closed, **không** ok) vẫn đạt. **Coordinator chốt: giữ nguyên hành vi BFF, sửa câu chữ plan** — `degraded` mô tả đúng hơn cho DB đã probe và hỏng; `unknown` là khi không xác định được trạng thái. Ngoài ra `activeLeases` đã có guard `db === true ? ... : null` (`health.ts:91`) ⇒ không thể trả `0` giả.
3. **Bulk cancel + date filter là đường ghi vào `operations`.** Bulk cancel dùng `operationAction` với idempotency key. Trên DB cũ chưa backfill, các state machine cũ (`done`/`state`) không tương đương `ACCEPTED/RUNNING/...`. ⇒ LDBA-02 phải map state **trước** khi UI này dùng được; nếu không, bulk cancel có nguy cơ cancel sai tập hàng.
4. **`workflows` vẫn chưa có trong `ADMIN_WEB_ROUTE_NAMES`** (`shell-server.ts:335-351`), nên màn Workflows vẫn 404 dù UI đã có. Không nằm trong scope plan này nhưng ảnh hưởng LDBA-06 (schema adapter) — workflow schema adapter **không thể nghiệm thu qua UI** cho tới khi route mở.

---

## 3. Đối chiếu schema cũ ↔ rework

### 3.1. Cảnh báo tên bảng — vấn đề gốc

`lib/db/schema.ts` dùng `pgTable('Operation', ...)`, `pgTable('ApiKey', ...)` — drizzle tạo **bảng có tên PascalCase** (`"Operation"`, quoted). Rework dùng `CREATE TABLE IF NOT EXISTS operations` — **lowercase**. Trên PostgreSQL hai tên này **là hai bảng khác nhau**.

⇒ Khi chạy migration rework lên DB cũ, bảng rework sẽ được tạo **song song**, không ghi đè. Đây là lý do bắt buộc cần tầng bridge (§5), không thể chỉ "trỏ connection string sang DB cũ" là xong.

**SỬA theo ADR LDBA-01 L1 — tenant KHÔNG đồng nhất toàn cục.** Giả định "mọi bảng rework đều có `tenant_id NOT NULL`" là **sai**; adapter phải xử lý từng bảng:

| Nhóm | Bảng | Thực tế |
|---|---|---|
| `tenant_id uuid NOT NULL` | `tenants`(id), `api_keys` (`0001:16`), `operations` (`0001:38`), `submission_keys` (`0001:59`), `admin_local_users` (`0023`) | gán tenant bình thường |
| **Không có cột tenant** | `business_versions`, `tasks`, `task_dependencies`, `step_checkpoints`, `outbox` (`0001:24,70,94,102,114`), `artifacts` | **không gán gì**; tenant suy ra qua JOIN `operations` |
| `tenant_id` **nullable** | `admin_audit_events` (`0010:25-27`) | để NULL = event platform-global |
| `tenant_id` kiểu **text** | `admin_crypto_config` (`0020:5-7`), `budget_reservations` (`0022:3-5`) | **text, không phải uuid** — đừng cast UUID vào |
| Connector service | tenant id kiểu **text** (`001:24-27`) | khác core rework (uuid) |

⇒ Bắt buộc: adapter **không** áp một quy tắc tenant duy nhất cho mọi bảng. Mỗi bảng phải khai cách gán riêng trong backfill report.

### 3.2. Bảng↔bảng

| Bảng cũ (drizzle) | Bảng rework | Kiểu map | Ghi chú |
|---|---|---|---|
| `Operation` | `operations` (+ cột `0024`) | **Bridge + backfill** | Khác tên; rework cần `tenant_id/business_id/business_version/action/correlation_id` mà cũ **không có** |
| `ApiKey` | `api_keys` (+ `0024` name/spending_limit/total_used) | **Bridge + backfill** | Cũ có `role`,`note` — rework `api_keys` **không có** `role`/`note` (§6) |
| `ExternalApiConnection` | `connector_revisions` + `secret_versions` | **Transform** | Cũ 1 hàng phẳng → rework 1 revision `config jsonb` + 1 secret row |
| `ExternalApiOverride` | `connector_prompt_overrides` | **Gần 1-1** | Cần thêm `tenant_id`, `is_active` |
| `ProfileEndpoint` | `profile_bindings` (+ policy cols `0026`) + `profile_names` | **Transform** | Cũ key `(apiKeyId, endpointSlug)`; rework key `(profile_id, revision)` + `(tenant_id, api_key_id, business, action)` |
| `AppSetting` | `admin_crypto_config` / `legacy_workflow_schemas` / deployment | **Tách nhánh** | `wb_schema:*` → `legacy_workflow_schemas`; AI/S3 → config/deployment |
| `FileCache` | `artifacts` + `artifact_blobs` | **Transform** | `md5Hash/s3Key/refCount` ↔ `sha256/storage_key/state` |
| `User` | `admin_local_users` | **Transform + re-hash** | bcrypt → scrypt CHECK (§4.3) |
| `UserProfileAssignment` | `user_profile_assignments` | **1-1, KHÔNG có cột tenant** | PK `(user_id, api_key_id)` (`0026:161-165`). Tenant suy ra qua `user_id → admin_local_users.tenant_id`. **Sửa theo ADR LDBA-01 L2** |

### 3.3. Bảng rework **không có nguồn từ DB cũ** (phải sinh mới)

`tenants`, `business_versions`, `tasks`, `task_dependencies`, `step_checkpoints`, `outbox`, `artifacts` (state machine), `invocation_grants`, `usage_events`, `budget_reservations`, `admin_audit_events`, `admin_idempotency`, `human_waits`.
⇒ Không backfill được — chúng rỗng khi khởi tạo, chỉ `tenants` cần seed 1 hàng mặc định (§4.1).

**Sửa theo ADR LDBA-01 L4 — hai bảng sau KHÔNG thuộc danh sách này**, chúng có nguồn legacy **một phần**:

| Bảng rework | Nguồn legacy một phần | Ghi chú |
|---|---|---|
| `submission_keys` | `Operation.idempotencyKey` | chỉ chuỗi idempotency; không có request hash, expiry hay tenant cũ — **chỉ backfill được nếu** LDBA-03 tái dựng request hash từ `pipelineJson`+`filesJson`; nếu không tái dựng được thì để rỗng và ghi rõ trong backfill report |
| `webhook_deliveries` | `Operation.webhookUrl`, `Operation.webhookSentAt` | **chỉ** chứa dấu vết đã gửi, không có payload/markdown ký/attempt count — backfill rỗng về mặt nghiệp vụ, điền `status` từ `webhookSentAt` |

Danh sách rework bảng mới chưa có ở §3.3 (ADR LDBA-01 L7, chưa xử lý — cần packet riêng): `artifact_multipart_parts`, `connector_invocations`, `connector_usage_outbox`.

### 3.4 L6 — `rateLimitPerMin` / `maxConcurrent` / `updated_at`: **KHÔNG thêm cột** (quyết định coordinator 2026-10-09, theo uỷ quyền "tự quyết")

ADR LDBA-01 verdict L6 là **CẦN packet riêng** và chặn LDBA-02. Coordinator đã dò thật trước khi chốt:

| Câu hỏi | Đo được | Nguồn |
|---|---|---|
| Rework có enforce rate limit / concurrency không? | **0 hit** cho `rateLimitPerMin` / `maxConcurrent` / `rate_limit` / `max_concurrent` trong `orchestrator/services/orchestrator/migrations/` **và** `src/` | grep toàn 2 cây |
| Portal mới `/admin` có expose 2 field này không? | **0 hit** trong `apps/admin-web/src/features/profiles/` | grep |
| Consumer inventory COMP-01 có yêu cầu này không? | **0 mention** rate limit / concurrency trong `reports/qwen-comp01-q15-consumer-inventory-2026-10-02.md` (207 dòng) | grep |
| Có đường enforce nào khác trong rework không? | hit duy nhất là `modules/encryption/legacy-payload-migration.ts` — không liên quan | grep |
| Consumer legacy là ai? | `app/profiles/page.tsx:771-775,894-895,1026-1027,1557,1577` + `app/api/internal/profile-endpoints/route.ts:117-118,178-202`; default lấy từ env `RATE_LIMIT_API_KEY` / `MAX_CONCURRENT_PER_PROFILE_ENDPOINT` | `lib/config.ts:22-40` |

**Quyết định: retirement — KHÔNG thêm `rate_limit_per_min`, `max_concurrent`, `updated_at` vào bất kỳ bảng nào của rework.**

Lý do:
1. **Không có consumer.** Thêm cột mà không có đường đọc là dữ liệu chết — vi phạm §6 của chính plan này: *"không thêm cột chỉ vì có ở bảng cũ"*.
2. **Rework không có cơ chế enforce.** Không có limiter nào thì cột có giá trị gì? Muốn có hành vi limit thì phải **xây** limiter + concurrency gate — đó là **feature mới của rework**, không phải việc adapter. Nằm ngoài scope LDBA.
3. **Consumer cũ đang bị thay thế.** UI duy nhất đọc 2 field này là `app/profiles/page.tsx` (app legacy root) — chính là thứ bị thay bằng portal `/admin` mới, và portal mới không có chỗ nhập chúng.
4. **`updated_at` vô nghĩa ở đích.** `profile_bindings` bất biến từ lúc ghi (PK `(profile_id, revision)`, `0004_profile_bindings.sql:14-28`) — không có cập nhật nên không có mốc thời gian cập nhật. ADR đã ghi nhận đúng: không có `updated_at` đích cho bindings/tên.

**Hệ quả phải nói thẳng (không giấu):** rework **không có rate limiting theo profile và không giới hạn concurrency theo endpoint**. Đây là **khoảng trống năng lực sẵn có của rework**, không phải hậu quả của việc adapter bỏ sót — rework đã không có từ đầu. Nếu deployment cũ đang dựa vào limit này để chống một profile chiếm hết worker, cutover sang rework sẽ **mất lớp bảo vệ đó**.

→ Ghi thành **follow-up, không chặn LDBA**: `RATE-CONCURRENCY-FEATURE` — packet tính năng riêng cho rework (limiter + concurrency gate + 2 cột + UI `/admin`), chỉ mở khi nhu cầu thật. Không được mở trong LDBA-02 vì không có consumer.

---

## 4. Sáu mismatch cứng (đã chốt xử lý)

### 4.1. DB cũ không có tenant — **ĐÃ CHỐT: một tenant chung**
Mọi bảng lõi rework có `tenant_id uuid NOT NULL REFERENCES tenants(id)` (`0001:16,38`). DB cũ **không có khái niệm tenant**.
**Chốt:** seed **một** tenant mặc định `legacy-default`, mọi bảng backfill trỏ về tenant này.
*Lý do:* DB cũ là **một deployment** không có tenant; tách tenant theo `ApiKey` sẽ phải bịa ranh giới nghiệp vụ mà dữ liệu cũ không có, và làm mọi câu hỏi vận hành phải thêm chiều tenant vô nghĩa. Tenant thật sẽ được tạo khi tách khách hàng — không phải lúc cắt DB.

> **BỔ SUNG 2026-10-09 (sau LDBA-06 receipt) — `legacy-default` là NAME, không phải UUID.**
> `tenants` có **cả hai**: `id uuid PK DEFAULT gen_random_uuid()` và `name text NOT NULL` (`0001_platform_v1.sql:7-12`). Không có UNIQUE trên `name`.
> ⇒ `legacy-default` là **tên logic**, không phải giá trị khóa. Không bao giờ ghi chuỗi `legacy-default` vào cột `tenant_id`.
> **Chốt:** seed `INSERT INTO tenants (name) VALUES ('legacy-default')` để `id` do `gen_random_uuid()` sinh; mọi packet backfill **resolve UUID theo name tại runtime** (`SELECT id FROM tenants WHERE name = 'legacy-default'`), không hardcode UUID.
> **KHÔNG** tái dùng `00000000-0000-0000-0000-000000000001` — đó là dev/fixture fallback trong `create-app.ts:290-295`, không phải bằng chứng mapping đã duyệt.
> **Hệ quả chéo:** đây là định nghĩa **toàn cục** của §4.1 — LDBA-03/04/05 đều kế thừa. Nếu một trong ba packet đang chạy gặp tường `uuid` cùng loại, đây là **một** khiếm khuyết plan, không phải ba phát hiện độc lập.

> **BỔ SUNG 2026-10-09 (sau LDBA-05 receipt) — service connector có TỪ VỰC tenant RIÊNG, không dùng `legacy-default`.**
> `connector_revisions.tenant_id` là **`TEXT NOT NULL DEFAULT ''`** (`008_connector_revision_binding.sql:16-20`), **không phải uuid**, **không có FK** tới `tenants`. `008:3-8` nêu rõ: mọi hàng legacy được normalize về `tenant_id = ''` (UNBOUND) **để backfill không bao giờ bị đọc là một tenant claim**; hàng legacy giữ nguyên semantics pre-binding tới khi VAULT-06 migrate.
> ⇒ **Chốt:** connector backfill **giữ `tenant_id = ''`**, **không** gán `legacy-default`. Đây là **ngoại lệ có chủ đích** của §4.1, không phải vi phạm.
> **Hệ quả:** hai service hai mô hình tenant — orchestrator (uuid + FK) dùng `legacy-default`; connector (text, không FK) dùng `''`. Mọi câu hỏi vận hành cross-service phải biết ranh giới này.
> **Đính chính theo hướng ngược lại (đã bác bỏ):** `0026_profile_policy.sql:118-120` comment tường minh — `connector_prompt_overrides.connection_id` giữ **uuid-only**, **cấm** nới thành text để chứa id text của legacy. LDBA-05 đã đọc đúng và không tự sửa.

### 4.2. Kiểu ID: `text` vs `uuid`
Cũ lưu `text` (giá trị là `crypto.randomUUID()`). Rework dùng `uuid`.
**Tin tốt:** giá trị cũ là UUID hợp lệ ⇒ cast `::uuid` được, không mất định danh. Nhưng cột cũ dài vô hạn ⇒ cần validate toàn bộ giá trị cũ parse được `uuid` trước khi bridge; giá trị lạ phải fail rõ, không nuốt.

### 4.3. Password hash: bcrypt vs scrypt — **ĐÃ CHỐT: re-hash lần đăng nhập đầu, không nới CHECK**
Cũ: `bcryptjs` (`lib/auth.ts:4,34`). Rework: `admin_local_users.password_hash` có `CHECK (password_hash ~ E'^scrypt\$32768\$8\$1\$...')` (`0023:13-14`).
⇒ Hash bcrypt cũ **không thể insert** vào bảng rework — vi phạm CHECK.
**Chốt:** adapter đọc bcrypt cũ → verify ở lần đăng nhập đầu → re-hash sang scrypt → ghi lại. **Không** nới CHECK, **không** thêm cột bcrypt song song.
*Lý do:* Giữ CHECK là ranh giới bảo mật đã chốt ở `0023`; thêm cột bcrypt tạo đường nâng quyền cục bộ không cần thiết. Re-hash on-login là đường chuẩn, và người dùng OIDC vốn không có password cục bộ nên không bị ảnh hưởng.
**Hệ quả cần chấp nhận tường minh:** user cũ **chưa từng đăng nhập lần nào** trên rework sẽ không đăng nhập được cho tới khi reset mật khẩu. Số lượng phải báo cáo từ backfill, không đoán.

### 4.4. Đơn vị tiền — **ĐÃ CHỐT: giữ `numeric(20,6)` USD ở `operations`, micro-USD chỉ cho budget**
Cũ: `totalCostUsd doublePrecision`, `spendingLimit/totalUsed doublePrecision`. Rework: `0024:61` dùng `total_cost_usd numeric(20,6)`, còn `budget_reservations.reserved_cost_micro_usd` là **integer micro-USD** (`budget-reservations.ts:72`).
**Chốt:** `operations.total_cost_usd` giữ đơn vị **USD thập phân** (khớp `0024` và khớp wire cũ). Khi cần budget, adapter quy đổi `×1e6` sang micro-USD **tại điểm ghi**, không đổi cột.
*Lý do:* `0024` đã chốt `numeric(20,6)` cho cột này và comment `0024:54-55` giải thích lý do (tránh drift khi cộng nhiều hàng). Đổi sang micro-USD sẽ phá wire parity với client cũ đang đọc `totalCostUsd`. Hai đơn vị cùng tồn tại là đúng, miễn adapter không lẫn.
**Luật không đổi:** không được coalesce NULL → 0 cho operation SUCCEEDED (`0024:21-23`).

### 4.5. JSON lưu dạng `text` (cũ) vs `jsonb` (rework) — **SỬA theo ADR LDBA-01 L5: không phải lúc nào cũng là JSON**

Cũ: `pipelineJson`, `stepsResultJson`, `extractedData`, `usageBreakdown`, `parameters`, `connectionsOverride`, `staticFormFields`, `extraHeaders` đều là `text` chứa JSON string.
Rework: jsonb.
⇒ Adapter phải parse; row có JSON hỏng phải fail rõ (không ghi NULL im lặng làm mất dữ liệu).

**Hai ngoại lệ — KHÔNG phải JSON, không được cast mù:**

| Trường cũ | Thực tế | Đích rework | Xử lý |
|---|---|---|---|
| `allowedFileExtensions` | **CSV text** (`0026:54-60`), không phải JSON | `allowed_file_extensions text NOT NULL DEFAULT ''` | Giữ nguyên chuỗi CSV, **không** parse JSON. Split theo `,` + trim chỉ ở tầng đọc |
| `fileUrlAuthConfig` | chuỗi mã hoá có điều kiện dạng `iv:tag:ciphertext` | `file_url_auth_cipher text` | Validate dạng 3 phần; giữ nguyên dạng cipher. **Không** cast JSON. Chỉ mở khi đi qua đường crypto đã duyệt |

⇒ Quy tắc: **mặc định parse JSON**, nhưng hai trường trên là ngoại lệ đã chốt. Adapter phải có danh sách ngoại lệ tường minh, không suy diện từ tên cột.

### 4.6. Workflow schema: KV blob vs bảng có revision/digest — **ĐÃ CHỐT: `revision=1`, giữ bản `updatedAt` mới nhất**
Cũ: JSON blob trong `AppSetting` key `wb_schema:<slug>` (`lib/workflow-builder/loader.ts:5-7`), không version, không digest.
Rework: `legacy_workflow_schemas` có `(tenant_id, slug, revision)`, `digest CHECK sha256:...`, `status active|retired`, unique index one-active (`0037`).
**Chốt:** adapter parse blob → tính `sha256:` digest → chèn `revision=1, status='active'`. Nếu nhiều blob cùng slug (chỉ xảy ra nếu `AppSetting` bị ghi ngoài `saveSchema`), giữ bản có `updatedAt` mới nhất và **log danh sách slug bị loại** — không silent overwrite.
*Lý do:* Cũ không có version, nên `revision=1` là giá trị trung thực duy nhất. Bịa revision cao hơn sẽ làm UI hiển thị lịch sử revision không tồn tại. `0037` đã có index one-active nên mỗi slug chỉ được một bản active — giữ bản mới nhất là hành vi đúng.

> **ĐÍNH CHÍNH 2026-10-09 (sau LDBA-06 receipt) — CÔNG THỨC DIGEST Ở TRÊN LÀ SAI, đã bị thay thế.**
> Dòng trên nói `digest` = hash của **chuỗi JSON gốc**. Điều đó **không thỏa** hợp đồng đọc thật:
> - `schemaDigest` (`modules/workflow-schemas/workflow-schemas.ts:70-76`) hash `canonicalLegacyWorkflowPinBytes(schema, connectorSlotMap, approvedEgressOrigins)` — **không** phải raw JSON.
> - `parseStoredEnvelope` (`:88-90`) **từ chối** mọi giá trị không có **đúng 3 khóa** (`schema`, `connectorSlotMap`, `approvedEgressOrigins`).
> - `parseStoredPin` (`:116-125`) **tính lại** digest và ném `SCHEMA_INVALID` khi lệch `row.digest`.
>
> ⇒ Blob JSON thô của legacy **không lưu được vào bảng này** dưới bất kỳ hình thức nào — không phải chỉ sai con số digest, mà sai **cấu trúc cột**.
>
> **CHỐT MỚI (đè lên công thức cũ):**
> 1. Adapter **bọc** schema legacy thành envelope đúng 3 khóa: `schema` = object đã parse, `connectorSlotMap` = map rỗng (không có khái niệm tương đương ở legacy), `approvedEgressOrigins` = mảng rỗng.
> 2. `digest` = `sha256:` + hex của `canonicalLegacyWorkflowPinBytes(...)` trên đúng 3 giá trị đó — tức **tái dùng nguyên văn hàm digest của catalog**, không tự đặt công thức.
> 3. `schema_ref` phải **đã seal** qua cơ chế hiện hữu (`metadata-crypto.seal`); provisioning hiện tại seal trước transaction rồi insert (`:294-298`, `:323-325`), và read path từ chối plaintext (`readStored(..., false)` `:187-198`).
> 4. **Không** sửa `0037`, **không** nới integrity check.
>
> **Tiêu chí nghiệm thu:** test phải chứng minh hàng ghi ra **đọc lại được bằng chính `parseStoredPin` của catalog** — không chỉ assert format regex `^sha256:[0-9a-f]{64}$`.

---

## 5. Kiến trúc adapter đề xuất (3 lớp)

Không có cách "chỉ đổi DATABASE_URL". Đề xuất 3 lớp, mỗi lớp một lease riêng:

**Lớp A — Name/shape bridge. ĐÃ CHỐT: cả hai theo giai đoạn, A1 trước A2.**

| Giai đoạn | Cơ chế | Mục đích | Điều kiện thoát |
|---|---|---|---|
| **A1 — đọc/đối chiếu** | `CREATE VIEW operations AS SELECT ... FROM "Operation"` (và tương tự) | Verify mapping toàn bộ §3–§4 trên DB thật **trước** khi cam kết cutover. App cũ vẫn chạy bình thường. | Số hàng đọc khớp số hàng nguồn; không row nào bị parse lỗi |
| **A2 — cutover thật** | Backfill có kiểm soát vào bảng rework đúng tên chuẩn, một chiều | Rework vận hành trên bảng của chính nó — đúng index, đúng FK, ghi được | Cửa sổ migrate riêng; app cũ đã dừng; có rollback |

*Lý do chọn cả hai:* A1 trả lời "mapping có đúng không" với chi phí gần như bằng 0 và không đụng app cũ. A2 là đích vận hành nhưng không thể đảo ngược dễ dàng. Làm A2 trước khi A1 xanh là mù cắt DB.
*View không dùng để ghi trong A1* — nếu cần ghi thì phải qua lớp B/backfill, không `INSTEAD OF` trigger (chậm và khó kiểm chứng trên DB có dữ liệu sống).

**Lớp B — Row transform (backfill script, additive).**
Script idempotent đọc bảng cũ → ghi bảng rework, áp §4.1–§4.6. Chạy được nhiều lần, có báo cáo số hàng skip/fail. Không xoá dữ liệu cũ.

**Lớp C — Additive field additions.**
Migration mới `0038+` bổ sung các cột còn thiếu (§6) — additive-only như contract hiện hành.

**Ràng buộc chung:** mọi lớp tuân `0024:4-5` (re-runnable, no down-migration). Bridge không được tạo "registry song song" (`PLAN-UI-BUSINESS-WORKFLOW:17` cảnh báo).

---

## 6. Field cần bổ sung trên DB — **SỬA 2026-10-09: danh sách rỗng, KHÔNG cần DDL additive**

> **Trạng thái mới (coordinator, 2026-10-09):** danh sách cột đề xuất bên dưới đã được **rút hết** sau khi quét consumer thật. **LDBA-02 không sinh file migration nào.** Lý do từng cột nằm ở bảng quét bên dưới.

### 6.1. Danh sách cột đề xuất cũ — đã rút từng cột

| Cột đề xuất | Nguồn cœ | Quét consumer thật | Quyết định |
|---|---|---|---|
| `api_keys.role` | `ApiKey.role` (`STANDARD/ADMIN`) | Rework `api_keys` (`0001:11-19`) **không có** cột; 0 hit `apiKey.role` trong `orchestrator/src` + `apps/admin-web/src`; portal mới chỉ có `session.role` (local-user role — khác concept) | **BỎ.** Rework dùng **bearer token** cho admin (`assertAdminAuth`), không có key-level role. Thêm cột = dữ liệu chết |
| `api_keys.note` | `ApiKey.note` | 0 hit trong cả 2 cây | **BỎ.** Không consumer |
| `operations.files_json` | `Operation.filesJson` | 0 hit trong rework. Legacy dùng để cleanup file (`lib/cleanup.ts:48,80`); rework thay bằng `artifacts.storage_key` + `artifact_blobs` (`0001:141`, `0003:9`) | **BỎ.** Rework có cơ chế artifact riêng |
| `operations.created_by_user_id` | `Operation.createdByUserId` | Rework **cấm** field này như identity header (`src/compat/legacy-input-decoders.ts:151,177` trong `FORBIDDEN_IDENTITY_HEADERS`); 0 consumer DB | **BỎ.** Rework không hỗ trợ per-user scoping; compat mount từ chối |
| `operations.files_deleted` | `Operation.filesDeleted` | 0 hit. Rework dùng `deleted_at` soft-delete (`0024`, `legacy-host-adapter.ts:398`) | **BỎ.** `deleted_at` đã thay thế |
| `operations.done` | `Operation.done` | 0 hit. Rework `state` là `text NOT NULL DEFAULT 'ACCEPTED'` (`0001:43`) — **không** phải PostgreSQL enum: toàn bộ `migrations/` không có `CREATE TYPE` và không có CHECK trên `state`. `done` được **suy ra** từ state qua `isTerminalState()` (`legacy-host-adapter.ts:474`) | **BỎ.** Suy ra từ `state`, không cần cờ riêng |
| `operations.webhook_url` | `Operation.webhookUrl` | — | **BỎ** theo ADR L3 — `operations.callback_url` đã tồn tại (`0007:7`) |
| `operations.webhook_sent_at` | `Operation.webhookSentAt` | — | **BỎ** theo ADR L3 — thuộc về `webhook_deliveries`, không thuộc operation |

### 6.2. Kết luận

**Không có cột nào cần thêm.** Mọi field legacy đều thuộc một trong ba loại: (a) **không consumer** trong rework, (b) **đã có cơ chế thay thế** (`artifacts`, `deleted_at`, `state` enum, bearer-token admin), (c) **bị rework từ chối có chủ đích** (`createdByUserId`).

⇒ **LDBA-02 = packet xác nhận + tài liệu hoá, không phải packet viết migration.** Việc "bổ sung field trên db" mà user yêu cầu **không cần thiết** ở lớp DDL — adapter A1 (view/translation) là đủ.

**Hai hệ quả phải nói thẳng:**
1. **Mất hành vi per-user scoping.** Legacy `app/api/operations/route.ts:24` lọc theo `createdByUserId`; rework không có. User cũ sẽ thấy **tất** operation của tenant thay vì chỉ của mình. Đây là **thay đổi hành vi cần user biết trước cutover**, không phải chi tiết kỹ thuật.
2. **Mất key-level admin.** Legacy key `role=ADMIN` có quyền admin; rework không phân biệt key. Cần user xác nhận đây là chấp nhận được.

**Nếu user muốn giữ 2 hành vi trên:** mở packet riêng `LEGACY-OP-SCOPE` (thêm `created_by_user_id` + per-user filter) và `API-KEY-ROLE` (thêm `role` + key-level authz). **Không** mở trong LDBA-02 vì không có consumer — mở khi có yêu cầu thật.

### 6.3. Cột `0024` đã thêm cho `operations` (giữ nguyên, không ảnh hưởng quyết định trên)

`deleted_at, pipeline_json, steps_result_json, current_step, progress_percent, progress_message, endpoint_slug, output_format, output_content, extracted_data, output_file_path, declared_filename, total_input_tokens, total_output_tokens, pages_processed, model_used, total_cost_usd, usage_breakdown, error_message, failed_at_step` — đã có sẵn, không cần làm gì thêm.

---

## 7. Rủi ro

| ID | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | Chạy migration rework lên DB cũ khi app cũ còn chạy → tranh chấp ghi | Cao | A1 chỉ đọc trước; cutover A2 theo cửa sổ riêng, có rollback |
| R2 | Mất dữ liệu do JSON `text` hỏng bị nuốt thành NULL | Cao | Fail rõ từng row; báo cáo skip; không silent NULL |
| R3 | Hash bcrypt không convert được → user cũ không đăng nhập được | Cao | Re-hash on-first-login; decision cho user không login |
| R4 | Lẫn đơn vị cost (USD ↔ micro-USD) làm sai billing | Cao | Adapter quy đổi tường minh; test round-trip; không coalesce NULL→0 (đã có luật `0024:21-23`) |
| R5 | Bridge tạo registry song song với business manifest | Trung | Map `endpointSlug`→`business/action` qua bảng duy nhất, không bảng thứ hai |
| R6 | ID cũ không phải UUID hợp lệ | Trung | Pre-validate toàn bộ; fail danh sách, không tự sinh ID mới |
| R7 | Plan bị đọc thành lệnh chạy migration | Trung | Ghi rõ ở §0 và `## 9` — cần packet + lease riêng |
| R8 | Sau khi §6 rút danh sách field, user mất **per-user operation scoping** | Cao | Đã ghi thẳng §6.2; nếu user không chấp nhận thì mở packet `LEGACY-OP-SCOPE` **trước** khi cutover, không phải sau |
| R9 | Mất **key-level admin** (`ApiKey.role=ADMIN`) sau cutover | Trung | §6.2; rework chỉ có bearer token — cần user xác nhận chấp nhận, hoặc mở `API-KEY-ROLE` |
| R10 | Không có rate limit / per-endpoint concurrency ở rework | Cao | §3.4; đây là thiếu năng lực có sẵn của rework, **không phải** hồi quy do adapter — packet `RATE-CONCURRENCY-FEATURE` |

---

## 8. Packet đề xuất (chưa dispatch)

| ID | Deliverable | Owner đề xuất | Dependency | Vùng lease | Receipt | Trạng thái |
|---|---|---|---|---|---|---|
| LDBA-00 | Inventory + mapping schema đầy đủ file:line, chốt A1/A2 | analyst | none | read-only, report riêng | `reports/ldba-00-schema-mapping.md` | **VERIFIED** 2026-10-09 |
| LDBA-01 | Quyết định kiến trúc bridge (A1 view vs A2 backfill) + ADR | architect + user | LDBA-00 | plan metadata | `reports/ldba-01-adapter-adr.md` | **ACCEPTED** — `codex_worker_4` / `term_d93ff3b1`; đủ 5 câu hỏi, 7 verdict L1..L7, 6 transform. Spot-check coordinator: 27/28 nhóm trích dẫn đúng, **1 trích dẫn sai** (`0023_admin_local_users.sql:1-20` — file 23 dòng, 0 lần `backfill`; nguồn thật `0024:24-30` + `0026:172-180`). Kết luận ADR **sống sót** dưới trích dẫn đúng → lỗi trích dẫn + framing, không phải lỗi suy luận. `LDBA-01-C1` **đã về và coordinator verify đủ 4/4 tiêu chí**: trích sai = 0; cả 2 chỗ trích `0024:24-30` + `0026:172-180` và nói rõ là **giả định cấp deploy** (không phải policy riêng của bảng); ghi chú `LDBA-01-C1` có trong §5; verdict L1..L7 / transform §4.1..§4.6 / quyết định A1/A2 **không đổi**. Ghi nhận khác biệt nhỏ không chặn: owner ghi "20 trích dẫn còn lại" vs coordinator đếm 27 nhóm — khác quy ước đếm, không phải thiếu nội dung |
| LDBA-02 | Lớp C: **xác nhận KHÔNG cần DDL additive** + tài liệu hoá consumer scan | migration owner | LDBA-01 | `services/orchestrator/migrations/`, `services/connector/src/db/migrations/` (chỉ đọc) | `reports/ldba-02-additive-fields.md` | **ACCEPTED** 2026-10-09 — `codex_worker_4` / `term_d93ff3b1`. Quét độc lập 8/8 cột trên 5 cây thư mục bằng 8 lệnh `rg` cụ thể: **0/8 cột có consumer lưu trữ trực tiếp**. Xác minh 3 cơ chế thay thế bằng file:line (`deleted_at` `0024:32-35`, `state` `0001:43`, `artifacts.storage_key` `0001:129-143` + `artifact_blobs` `0003:8-13`). Coordinator đã đọc lại receipt và verify trên disk: `0001:43` = `state text` (không phải enum), `0024:32-35` = `deleted_at timestamptz`, `0007:6-7` = `callback_url text`, `legacy-host-adapter.ts:474` = `done: isTerminalState(rawState)`, `legacy-input-decoders.ts:307-312` = `webhook_url` → `callback`. **2 open item của owner đã xử lý:** (1) "0/8" nghĩa là 0 consumer của cột **persist** — `webhook_url` là wire-level alias map vào `callback_url` sẵn có, không cần cột mới; (2) đã sửa wording "enum" → "application state vocabulary" ở §6.1. **Không sinh file migration nào** |
| LDBA-03 | Lớp B: backfill/transform script idempotent | runtime owner | LDBA-02 | script riêng + tests riêng | `reports/ldba-03-backfill.md` | **ACCEPTED (module scope)** 2026-10-09 — `codex_worker_4` / `term_d93ff3b1`. Runner `scripts/ldba-03-backfill.cjs` (**1210 dòng**) + test `tests/ldba-03-backfill-offline.test.cjs` (**511 dòng**), `node --test` exit 0. Coordinator verify trên disk: `LEGACY_TABLES` (`:7-17`) liệt kê **đúng 9 bảng** (receipt tự bắt lỗi prose gọi 8 — đúng); tenant path (`:891-930`) resolve **theo name** `legacy-default` (`:6`), `seedTenantByName` chỉ chèn name, >1 match → `DUPLICATE_TENANT_NAME` fail-closed, `TENANT_KEY` không bao giờ cast UUID, **0 hit** UUID dev-fallback `00000000-...-0001`; connector path (`:438-446`) ép `tenant_id === ''` + `credential_source.kind === 'legacy-db'` + `account_id` null ⇒ khớp đính chính §4.1 thứ hai. Đếm test: **16** `test()` top-level + 4 subtest (`t.test` 3-case loop `:313-342` + 1 lồng `:415`) = **20**, khớp receipt. **Cảnh báo đáng giữ — timezone chưa chứng minh:** receipt nói rõ Compose/Docker **không pin runtime timezone**; runner đang đọc timestamp naive là UTC cố định. Nếu giá trị cũ là local wall time thì mọi instant sẽ lệch ⇒ **A1 phải resolve trước khi backfill thật**. **5 open item:** chưa có evidence A1 cho đúng source version; chưa có source/sink adapter thật (phải serialize seed vì `tenants.name` không UNIQUE — cần advisory lock); timezone; callback L3 + adapter LDBA-04/05/06 chưa có nên row tương ứng **fail-closed**; FileCache cần byte reader + token/purpose policy |
| LDBA-04 | Adapter identity: bcrypt→scrypt re-hash (§4.3) | identity owner | LDBA-01 | identity modules | `reports/ldba-04-identity-adapter.md` | **ACCEPTED (module scope)** 2026-10-09 — `term_6bd1346d`. Module `legacy-user-adapter.ts` + test, **5/5 pass exit 0**, tsc 0, RED trước đã ghi. Coordinator verify 3 điểm nhạy cảm: (1) **không** nới CHECK `0023`, **không** thêm cột bcrypt song song; (2) tenant lấy **UUID đã resolve**, owner tự ghi *never casts the text label to UUID* — khớp đính chính §4.1; (3) `user_profile_assignments` **không** bịa cột tenant, chỉ trả cặp uuid đã validate, từ chối khác tenant. Owner đảo tiền đề no-backfill ở tầng deploy có chủ đích (trích nguyên văn `0024:24-30` + `0026:161-180`). **Chọn reset password** cho user chưa từng login (không tạo row khoá với mật khẩu không rõ). **4 open item — 2 cần lease mới, không phải sửa packet này:** module **chưa** nối vào đường login hiện hữu; orchestrator **không khai bcryptjs** (verifier phải inject, không được tạo dependency runtime chưa khai báo); `provider`/`providerSub` MISSING ⇒ continuity OIDC còn mở; số lượng thật thuộc backfill report |
| LDBA-05 | Adapter connector: `ExternalApiConnection`→`connector_revisions`+`secret_versions` | connector owner | LDBA-01 | connector modules | `reports/ldba-05-connector-adapter.md` | **ACCEPTED-WITH-CONDITIONS (module scope)** 2026-10-09 — `term_ca784044`. Module `legacy-connector-adapter.ts` + test **8/8 pass exit 0**, tsc 0. Id **giữ TEXT**, không cast uuid (khớp `001:2,13,25`); `authSecret` đi qua `AesCredentialCipher` hiện hữu, **không** bao giờ vào `config` hay `encryptedValue`. Coordinator verify 2 open item vương thật với code: (a) `connector_revisions.tenant_id` là `TEXT DEFAULT ''` theo `008:16-20` + comment `008:3-8` ⇒ connector **không** dùng `legacy-default`, đã đính chính §4.1; (b) `connector_prompt_overrides.connection_id uuid` **cố ý**, `0026:118-120` comment từ chối nới sang text, và **không có cột revision** `0026:121-139` ⇒ spec §1.6 (gắn vào revision cụ thể) **không thực thi được** mà không đổi schema. Owner **đúng** khi dừng không tự sửa. **4 open item cần coordinator:** (1) `ExternalApiOverride` **chưa** map được; (2) `DISABLED`→`RETIRED` là state **terminal**, có thể mất hành vi re-enable cũ — cần chốt lại; (3) `httpMethod`/`authType` chỉ nhận 1 giá trị mỗi loại, cần mở rộng nếu legacy có giá trị khác; (4) `multipart-http` **không** tiêu thụ `staticFormFields`/`fileUrlFieldName`/`defaultPrompt` đã giữ — chưa chứng minh execution parity. 1 biên lỗi owner tự khai đúng: **không đọc** `lib/db/schema.ts` root (repo scope `du-rework`) ⇒ danh sách field dùng từ LDBA-00 thay vì đối chiếu lại nguồn. **6 open item đã chốt 2026-10-09 (coordinator, theo uỷ quyền tự quyết) — xem §8.1.4:** (1) chấp nhận LDBA-00 làm nguồn field, không đọc lại root; (2) override projection **v1 hoãn** — `0026:121-139` không có cột revision, `connection_id uuid` **không có bảng tham chiếu** (không tồn tại bảng `connectors`, quét 0 hit) trong khi `connector_revisions.connector_id` là TEXT (`001:2`) ⇒ cần packet thiết kế riêng; (3) tenant đã chốt §4.1 — connector UNBOUND, owner đúng; (4) **giữ `DISABLED`→`RETIRED`** — tiền lệ `006`, chỉ ACTIVE routable nên không khác biệt bảo mật, bật lại = revision mới nên terminal bảo toàn audit; (5) execution parity `multipart-http` **ngoài phạm vi projection** nhưng **chặn cutover** — cần packet verify riêng, 17 field đã giữ trong `config`; (6) connector không `authSecret` **fail-closed đúng** — `ConnectorCredentialSourceSchema` (`vault.ts:185-191`) chỉ có `legacy-db` + `vault-kv2`, **không có kind none**, `credential_ref NOT NULL` (`001:6`) ⇒ mọi row dừng phải vào danh sách có tên trong backfill report |
| LDBA-06 | Adapter workflow schema: `wb_schema:*`→`legacy_workflow_schemas` | workflow owner | LDBA-01 | workflow modules | `reports/ldba-06-workflow-schema-adapter.md` | **RECEIPT — owner STOPPED trước khi viết code** 2026-10-09 (`term_f4f7687d`). 0 module, 0 test, 0 DB, 0 slug. Cả 2 lý do dừng đã **coordinator verify độc lập trên source**: (1) **digest** — `schemaDigest` (`:70-76`) hash canonical-pin-bytes, `parseStoredEnvelope` (`:88-90`) đòi **đúng 3 khóa**, `parseStoredPin` (`:116-125`) recompute rồi ném `SCHEMA_INVALID`; blob JSON thô của legacy **không lưu được** ⇒ công thức raw-JSON ở §4.6 sai, đã đính chính §4.6; (2) **tenant** — `0037:5` là `tenant_id uuid NOT NULL REFERENCES tenants(id)`, không lưu được chuỗi `legacy-default` ⇒ §4.1 đã đính chính: `legacy-default` là **name**, UUID do `gen_random_uuid()` sinh, packet resolve theo name. **Hai quyết định đã chốt xong** (digest + tenant) ⇒ **R2 RE-DISPATCHED** 2026-10-09 (`term_f4f7687d`, `turn_started`, gen 130; spec `2026-10-09-LDBA-06-R2-workflow-schema-adapter.md`). R2 chốt thêm 3 điểm: trùng `updatedAt` → lấy `key` lớn nhất byte-order; route giữ `appSettings` (đổi route là packet riêng); **tiêu chí nghiệm thu nâng** — test phải chứng minh đọc lại được bằng chính `parseStoredPin`, cấm tự viết reader riêng (vacuous pass). **R2 RECEIPT — owner STOPPED lần 2, đúng** 2026-10-09: `parseStoredPin` **không được export** (`:116`), cùng `parseStoredEnvelope` (`:84`) và `schemaDigest` (`:70`) đều module-private. Coordinator verify độc lập: đúng. **Không** export hàm (phải sửa file ngoài write set, hiện không consumer nào cần) ⇒ **R3 RE-DISPATCHED** 2026-10-09 (`term_f4f7687d`, `turn_started`, gen 130; spec `2026-10-09-LDBA-06-R3-workflow-schema-adapter.md`). R3 mở khoá bằng **sửa packet**, đúng phương án owner tự đề xuất ở Open item 1: dùng `resolveLegacyWorkflowSchema` (`:152-199`) **đã export**, nhận `db: Db` injectable, gọi `parseStoredPin` thật ở `:198` — **mạnh hơn** gọi trực tiếp vì cũng chạy SELECT, check `status='active'`, `requireCrypto`, và `readStored(..., false)`. AAD triple chốt từ `:58`/`:62-68`/`:190-194`: `slot` = `legacy_workflow_schemas.schema_ref`, `refId` = `${slug}:1`, `tenant_id` = UUID đã resolve; **sai triple ⇒ `CONTEXT_MISMATCH` ⇒ `SCHEMA_CRYPTO_UNAVAILABLE` ⇒ test đỏ, không pass âm thầm**. Tenant **bắt buộc giống hệt LDBA-03** (`:891-930`) để hai adapter không trôi. Tiêu chí nâng giữ nguyên + thêm: phải có case chứng minh hàng **chưa seal** bị từ chối | **R3 RECEIPT — owner STOPPED lần 3, đúng** 2026-10-09: spec R3 §1.4 của coordinator bắt buộc `connectorSlotMap` rỗng + `approvedEgressOrigins` rỗng — hai giá trị chỉ hợp lệ cho schema không connector và không egress. Coordinator verify độc lập: `validateLegacyWorkflowConnectorSlotMap` (`legacy-workflow.ts:164-177`, đặc biệt `:173-175`) từ chối map thiếu bất kỳ tên connector nào; `validateLegacyWorkflowEgressOrigins` (`:329-370`, đặc biệt `:352-354`, `:355-363`, `:365-367`) từ chối approved rỗng cho mọi hình egress được hỗ trợ; nguồn legacy có thật `connector`/`file_url_download`/`callback` (`lib/workflow-builder/types.ts:24-34`, `:93-118`). **Nguyên nhân gốc là spec R3 của coordinator, không phải owner.** **R4 RE-DISPATCHED** 2026-10-09 (`term_f4f7687d`, `turn_started`, gen 130; spec `2026-10-09-LDBA-06-R4-workflow-schema-adapter.md`). R4 đóng Open item 1 bằng cách **không tự bọc envelope** — gọi thẳng `provisionLegacyWorkflowSchema` (`workflow-schemas.ts:205-337`, **đã export**, writer production): tự cấp slot map đầy đủ qua `allocateLegacyWorkflowConnectorSlotMap` (`:266-268`), validate origins (`:277-280`), tính digest canonical-pin (`:287`), tính `revision = max+1` (`:288-293`), seal đúng AAD triple (`:294-298`), advisory lock + CAS + retire + insert (`:300-326`). ⇒ Adapter **không** tự tính digest/seal/INSERT; output theo cấu trúc đọc lại được bởi reader production. Open item 2 (approved origins) chốt: **derive từ URL tĩnh HTTPS, cấm bịa** — thu URL từ `file_url_download`/`callback` (đệ quy `parallel`), URL động (`^\$[A-Za-z_]...`) hoặc non-HTTPS hoặc có userinfo → **skip + báo cáo**, không bao giờ tự tạo phê duyệt. Idempotency: pre-check active row → skip; `expectedRevision: null` = assert-absent (`:221-224`, `:234`), `SCHEMA_REVISION_CONFLICT` → coi như skip. Tiêu chí nghiệm thu nâng lên **round-trip writer production → reader production** trên cùng fake db + case connector + case egress tĩnh/động + case hàng chưa seal bị từ chối + idempotent skip. **Đây là lần dừng đúng thứ 3 — ghi nhận là hành vi được chấp nhận, không phạt.** | **R4 RECEIPT — IMPLEMENTED, coordinator verify độc lập trên disk → ACCEPTED (module scope)** 2026-10-09 (`term_f4f7687d`). Module `legacy-workflow-schema-backfill-adapter.ts` (**15537 byte**) + test `legacy-workflow-schema-backfill-adapter.test.ts` (**17557 byte**), **7/7 pass exit 0**, tsc 0, fixture synthetic. **Coordinator verify 7/7 tiêu chí R4 nghiệm thu ngay trên source, không tin receipt:** (a) adapter **gọi** `provisionLegacyWorkflowSchema` thật (`:9` import, `:406` call) với `expectedRevision: null` (`:412`) và bắt `SCHEMA_REVISION_CONFLICT` thành skip (`:417-418`); (b) **0 INSERT** vào `legacy_workflow_schemas` trong adapter, **0** self-seal, **0** self-digest ⇒ đúng lệnh R4 §1.1; (c) test gọi **cả hai** production writer **và** `resolveLegacyWorkflowSchema` (`:8,296,320,364`) trên cùng fake db ⇒ đúng bar round-trip bắt buộc, không phải vacuous pass; (d) crypto **thật**: `createMetadataCrypto` + `VaultTransitProvider` + `adaptKeyProviderForMetadata` (`:4-6,73,81-82`), không fake; (e) case bắt buộc có đủ — `SCHEMA_CRYPTO_UNAVAILABLE` (hàng chưa seal bị từ chối), connector round-trip, egress tĩnh round-trip, `DYNAMIC_EGRESS_URL` skip, idempotent (`ACTIVE_ROW_EXISTS`, không sinh revision 2), preflight tenant pending; (f) chính sách egress R4 chốt hiện diện đúng — `DYNAMIC_EGRESS_URL`/`INVALID_EGRESS_URL`/`NON_HTTPS_EGRESS_URL`/`EGRESS_URL_USERINFO` (`:51-54`), origins sort deterministic (`:235`), **không bịa** origin; (g) tenant khớp LDBA-03: `legacy-default` là **name** (`:14`), `PREFLIGHT_TENANT_PENDING` không seed (`:328`), `seedTenantByName` chỉ chèn name (`:258`), `DUPLICATE_TENANT_NAME` fail-closed 3 chỗ (`:269,280,292`). **Hygiene: 0 ký tự nháy kép + 0 trailing whitespace** trên cả adapter, test, receipt. **Phạm vi hẹp đúng:** route + loader **không** đổi (§1.7 giữ nguyên — route vẫn đọc `appSettings`), không migration, không DB thật, không sửa contract/catalog/crypto. **Open items còn lại (2, đều của coordinator):** (1) chưa có **independent verify** + acceptance riêng — receipt tự khai `IMPLEMENTED with focused owner smoke`, tự **không** tick gate, đúng contract; (2) **số lượng thật** (slug/skip/origin từ DB legacy) **chưa biết** — chỉ có synthetic fixture, backfill thật cần window riêng. **ACCEPTED ở phạm vi module**; LDBA-07 verify độc lập trên rehearsal DB mới là chốt cuối. **→ VERIFIED (module scope)** 2026-10-09: **independent verify** (DeepSeek-1 / `term_8bfe6adc`, không phải implementer) receipt `reports/verify-ldba-06-INDEPENDENT-DSH-2026-10-09.md` — **7/7 pass exit 0** trên **cả** Node v22.23.3 **và** v24.21.0 (khớp môi trường owner), **tsc exit 0 / 0 error**, **zero double-quote + zero trailing whitespace** trên cả 3 file R4 (adapter 465 dòng / test 440 dòng / receipt 71 dòng). **Ranh giới offline giữ:** 0 `new Pool`/`new Client`/`DATABASE_URL`/`process.env`/`psql`/`fetch(`/`axios`/`http.request`; `pg` chỉ là `import type` trong test; `VaultTransitProvider` dựng với `fetchImpl` **tiêm vào** (`test:78`) = emulator Transit trong bộ nhớ, không mở socket. Verifier **đối chiếu claim owner**: `git diff --check` exit 2 + đúng 2 dòng trailing ở `apps/admin-web/src/features/operations/operations-screen.tsx:445,599` (ngoài phạm vi) ⇒ **owner khai trung thực**. Digest sha256 cả 3 file R4 ghi ở receipt §1. **5 GAP của verifier:** (1) ngữ nghĩa nghiệp vụ chỉ chứng minh qua 7 test fixture, **chưa** inventory legacy thật; (2) cả 3 file R4 chưa commit (`??`) ⇒ verify gắn working tree, đổi file là hết hiệu lực; (3) **không** chứng minh tuyệt đối không tiến trình khác chạm live DB/Vault — chỉ chứng minh mã R4 không chứa đường gọi đó; (4) `tests/migrations.test.ts` + suite live-gate không chạy (offline); (5) chỉ đọc bản R4, không đối chiếu lại R3 cũ. |
| LDBA-07 | Verify độc lập trên DB rehearsal (fresh schema, synthetic data) | tester (không phải implementer) | LDBA-02..06 | tests + report | `reports/ldba-07-verify.md` | **DISPATCHED** 2026-10-09 — dep LDBA-02..06 đã đóng (mở khoá). Owner `term_8bfe6adc-f0da-41a1-a4aa-fc835bcb1535` (DeepSeek-1, **tester**, đã verify độc lập LDBA-06 R4 ⇒ **không** phải implementer nào của LDBA-03/04/05/06). Spec `dispatch-specs/2026-10-09-LDBA-07-rehearsal-verify.md`. Phạm vi: **disposable PG16** (container `du-ldba07-rehearsal`, `--network none`, tmpfs, **không** publish port, remove sau) + full migration `001..0037` (fresh schema) + **dữ liệu synthetic tự dựng** (UTC tường minh) + verify 4 adapter LDBA-03..06 (source/target đếm khớp, zero parse failure, idempotent). **Điều kiện bắt buộc §5:** `getHealth()` phải fail-closed `unknown` (không phải `ok`) khi `tasks`/`outbox` thiếu. **A1 timezone vẫn mở** — rehearsal UTC **không** đóng A1. Gap đã biết: LDBA-03 **chưa có** source/sink adapter production trên disk ⇒ owner tự dựng adapter synthetic test-only để chạy runner (`LDBA03_ADAPTER_MODULE`), phải ghi rõ đây không phải bằng chứng cho adapter production | **RECEIPT — NOT-PASS (owner dừng đúng theo spec §4)** 2026-10-09, cùng owner `term_8bfe6adc`. **ĐẠT:** disposable PG16 `--network none` + tmpfs + `PortBindings=map[]`, PG 16.11, **đã remove** (exit 0); fresh schema **37/37** migration + ledger `count(*) = 37`, **28** bảng; seed synthetic **6** bảng legacy-shaped (tự dựng, UTC tường minh, không đọc DB thật) → 34 bảng; **getHealth fail-closed ở tầng probe** — `SELECT count(*) FROM tasks` ném `relation tasks does not exist` ⇒ `dbOk=false` ⇒ **`degraded` + HTTP 503**, không ok. **CHƯA ĐẠT:** **4 adapter CHƯA chạy được** ⇒ `source/target đếm khớp` + `zero parse failure` + `idempotent 2 lần` **không có bằng chứng**, target counts đo được = `0|0|0|0|0`; owner **không** claim đạt và **không** tick gate. **Nguyên nhân gốc là spec của coordinator, không phải owner** (giống LDBA-06 R1..R3): (a) LDBA-03 cần adapter synthetic đủ contract runner 1210 dòng (`source.scan` + 5 hàm `sink` + `context` + `a1Passed` + `sourceVersion`) — là **implementation**, vượt một lượt verify; (b) LDBA-04/06 cần harness Node **trong** container (build TS + copy `node_modules/pg`); (c) **LDBA-05 không thể verify** vì bảng sink connector (`connector_revisions`, `secret_versions`, `connector_invocations`, `connector_usage_outbox`) **không tồn tại** sau `001..0037` — connector có bộ migration riêng `001..009`. **Phát hiện để dùng cho lượt sau (đã kiểm chứng):** Node chạy được **bên trong** container `--network none` mà không publish port (`docker create` node image → `docker cp` binary ra host → `docker cp` vào container → `docker exec ... -v` cho v24.21.0). **Coordinator đo thêm:** 4 bảng connector **không trùng tên** bất kỳ bảng orchestrator nào ⇒ áp **cả hai** bộ migration vào **cùng một** container rehearsal được, **không** cần container thứ hai. **7 open item** cho coordinator: (1) chưa có bằng chứng 4 adapter; (2) LDBA-03 chưa có source/sink adapter **production**; (3) bộ migration connector `001..009` chưa áp; (4) nhãn `unknown` vs `degraded` → **đã chốt ở §2c mục 2** (giữ hành vi BFF, sửa câu chữ plan); (5) getHealth mới đo ở tầng probe, **chưa** boot end-to-end qua route thật (thiếu Redis dưới `--network none`); (6) **A1 timezone vẫn mở**; (7) gap đo lường — SQL có identifier quoted truyền inline qua `docker exec` từ Windows bị mất dấu nháy kép, lần sau dùng `docker cp` file `.sql` + `psql -f` |

| LDBA-08 | Adapter source/sink **production** cho LDBA-03 + harness in-container để verify được trên rehearsal | runtime owner (**implementer**, không phải tester) | LDBA-03 (runner) + LDBA-07 (kết quả) | adapter mới + harness test-only + receipt | `reports/ldba-08-production-adapter.md` | **DISPATCHED** 2026-10-09 — coordinator chốt sau khi đọc receipt LDBA-07. **Vì sao:** LDBA-07 **chưa** đạt vì 4 adapter chưa chạy được trên PG thật; nguyên nhân gốc là **implementation còn thiếu**, không phải lỗi verify. **Phạm vi tối thiểu:** (1) adapter source/sink **production** cho LDBA-03 — `source.scan` + `sink.inspectImmutable` / `validatePlan` / `applyImmutableBatch` / `resolveTenantIdsByName` / `seedTenantByName` + `context` + `a1Passed` + `sourceVersion`, theo contract runner `scripts/ldba-03-backfill.cjs` (đọc schema legacy PascalCase, ghi schema rework); seed tenant phải **serialize** vì `tenants.name` không UNIQUE (cần advisory lock); (2) harness **test-only** chạy **bên trong** container `--network none` theo kỹ thuật §6 receipt LDBA-07 (Node copy vào container + `node_modules/pg` + build TS) — dùng lại được cho lượt verify sau, không phải code production; (3) áp **thêm** bộ migration connector `001..009` vào **cùng** container rehearsal (coordinator đã đo: 4 bảng connector không trùng tên bảng orchestrator ⇒ **không** cần container thứ hai). **Ranh giới:** không đọc DB production/legacy; không sửa runner `ldba-03-backfill.cjs` (đã ACCEPTED) trừ khi bằng chứng buộc phải, khi đó phải ghi rõ; không commit/`git add`/push; không tick gate. **Điều kiện mở:** A1 timezone **vẫn phải resolve** trước khi chạy backfill **thật** — harness trên synthetic UTC **không** đóng A1 | **RECEIPT — NOT-PASS (owner dừng đúng theo spec §7)** 2026-10-09, owner `term_d93ff3b1` (Codex-4). **ĐẠT:** cả 4 file lease đã viết (W1 adapter production + W2 offline test + W3 harness + W4 receipt); offline test **5/5 pass exit 0**; `node --check` pass W1 + W3; hygiene **0 double-quote + 0 trailing whitespace** trên cả 4 file. Rehearsal disposable PG16 `--network none` tmpfs, không publish port, **đã remove**: áp **cả hai** bộ migration — orchestrator **37/37** (`schema_migrations` 37 dòng) + connector **9/9** (`connector_schema_migrations` 9 dòng, connector dùng ledger riêng) ⇒ **33** bảng public; seed synthetic **19** hàng trên 9 bảng legacy; scan đủ 9 bảng; tenant `legacy-default` seed name-only, UUID sinh lúc runtime. **CHƯA ĐẠT:** runner preflight = **`BLOCKED_TRANSFORM` exit 1** (read 19 · written 0 · failed 12 · skipped 1 · destination planned 0), nên **execute / idempotent / count reconciliation không được chạy** — đúng theo stop condition §7. **Nguyên nhân gốc — 7 contract incompatibilities giữa runner LDBA-03 và các adapter chuyên biệt, đều nằm NGOÀI lease owner** (lease cấm sửa runner + cấm sửa adapter LDBA-04/05/06 đã ACCEPTED): (1) **identity** — LDBA-04 chỉ re-hash bcrypt→scrypt **sau khi user nhập plaintext ở lần đăng nhập đầu**, runner đòi sẵn `password_hash` scrypt **lúc backfill** ⇒ không có transform an toàn; (2) **connector** — LDBA-05 projector chỉ nhận `POST` + `API_KEY_HEADER`, runner cần synthetic row auth type khác + URL http, và **runner không có kết quả skip cho connector** (mọi transform error → `BLOCKED_TRANSFORM`); (3) **HTTP vs HTTPS** — dispatch kỳ vọng skip HTTP, nhưng endpoint parser LDBA-05 hiện **chấp nhận cả HTTP lẫn HTTPS**; (4) **override id** — `ExternalApiOverride` mang connector id dạng **text**, runner đòi UUID `connectionId`; plan đã nói target uuid-only + **v1 override projection deferred**, nhưng runner **không thể defer** một hàng; (5) **profile** — `resolveProfileName` + `normalizeConnectionsOverride` **không có** chính sách production synchronous/pure nào được phê duyệt; (6) **workflow schema** — LDBA-06 delegate qua `provisionLegacyWorkflowSchema` (catalog writer), runner đòi **pure digest + `schema_ref`** rồi tự ghi ⇒ không có API prep thuần nào được expose; (7) **FileCache** — **không có** production object reader / artifact token policy / purpose policy trong module thuộc lease. **Phát hiện thêm (2, ngoài 7 mục trên):** runner duplicate report đọc `row.id` trong khi **source key là `row.key`** ⇒ in ra `winner=undefined` + `skipped=undefined`; và `AppSetting.key` là **UNIQUE** trong source thật, còn fixture synthetic của spec yêu cầu 2 hàng cùng key ⇒ **spec và constraint xung đột**, runner có diagnostic bug. **A1 timezone VẪN MỞ** (rehearsal UTC không đóng A1, owner tự khai trung thực). **Coordinator chốt:** đây là **contract gap thật giữa các module**, **không** phải lỗi owner — owner **đúng** khi dừng, **không** bịa credential, **không** skip âm thầm, **không** ghi đè module đã ACCEPTED, **không** sửa runner ngoài lease. Đây là lần thứ 4 nguyên nhân gốc thuộc **spec của coordinator** (sau LDBA-06 R1..R3 và LDBA-07), **không** phạt owner. **Hướng xử lý (packet riêng, không nhét vào LDBA-08):** (a) **LDBA-09 — runner contract reconciliation**: thêm skip semantics có kiểm soát + fix diagnostic `row.id`→`row.key` + chấp nhận trạng thái identity *pending-rehash* thay vì bịa hash; (b) **expose pure-prep API** cho profile / workflow-schema / FileCache-objects (hoặc định nghĩa tích hợp transaction-safe với writer hiện có); (c) **chốt chính sách HTTP** — hoặc sửa LDBA-05 từ chối HTTP, hoặc sửa kỳ vọng dispatch; (d) **identity** — không backfill mật khẩu; hoặc tạo identity locked bắt buộc reset lần đầu, hoặc tách packet riêng có phê duyệt bảo mật. **Kết luận:** LDBA-08 **đóng ở phạm vi infrastructure** (hạ tầng adapter + harness + bằng chứng 2 bộ migration áp được), **acceptance chưa đạt** vì runner contract chưa khớp adapter chuyên biệt |
| LDBA-09 | Reconcile **contract runner** LDBA-03 với adapter chuyên biệt (controlled skip + pending-rehash identity + diagnostic `row.key`) | runtime owner (**implementer**) | LDBA-03 (runner) + LDBA-08 (kết quả) | runner + test + fixture adapter + harness + receipt | `reports/ldba-09-runner-reconciliation.md` | **DISPATCHED** 2026-10-09 — spec `dispatch-specs/2026-10-09-LDBA-09-runner-reconciliation.md`. **Vì sao:** LDBA-08 chỉ ra 7 contract gap giữa runner và adapter LDBA-04/05/06, đều ngoài lease; runner cần (a) cơ chế skip có kiểm soát thay vì `BLOCKED_TRANSFORM` cho mọi lỗi transform, (b) chấp nhận trạng thái identity *pending-rehash* thay vì bịa hash scrypt, (c) sửa diagnostic duplicate workflow đọc `row.id` thay `row.key`. **Phạm vi:** W1 runner `ldba-03-backfill.cjs` (file production duy nhất được sửa) + W2 test offline + W3 fixture adapter test-only + W4 harness in-container + W5 receipt. **Ranh giới:** không đọc DB thật; không sửa adapter LDBA-04/05/06/08; không sinh hash; không nới `connector_prompt_overrides.connection_id`; không commit/`git add`/push; không tick gate. **A1 vẫn mở** | **RECEIPT — runner work ACCEPTED, rehearsal BLOCKED ở fixture preflight** 2026-10-09, owner `term_d93ff3b1` (Codex-4), dừng đúng §7. **ĐẠT (runner):** 4 thay đổi contract đúng — `RowSkip` + `SKIP_POLICIES` allowlist **đúng 4 bảng** (`ExternalApiConnection`/`ExternalApiOverride`/`User`/`UserProfileAssignment`), skip chỉ nhận khi khớp hàng + allowlist, ngoài allowlist → `UNAPPROVED_SKIP`, `CONTEXT_POLICY_REQUIRED` không bao giờ thành skip, `report.skips` + registry `_skippedSourceKeys` non-enumerable, `mapOverride(row, report, tenantId)` / `mapAssignment(row, report)`, pending-rehash cho `{pending:true, reason}` + tương thích ngược `PASSWORD_RESET_REQUIRED` (không ghi identity, không tạo hash), cascade `ASSIGNMENT_USER_NOT_MIGRATED` vì FK `ON DELETE RESTRICT`, `:758` + `:773-774` dùng `row.key`, `LDBA_SKIP_POLICY=report\|fail` (giá trị lạ → exit 2, `fail` → `BLOCKED_SKIPPED_ROWS`). Offline **34/34 pass exit 0** (14 test skip mới + 20 test có sẵn). **ĐẠT (rehearsal infra):** disposable PG16 `--network none` tmpfs, không publish port, **đã remove**; áp **cả hai** bộ migration — orchestrator **37/37** + connector **9/9** (ledger riêng `connector_schema_migrations`) ⇒ **33** bảng; seed synthetic **22** hàng / 9 bảng; tenant `legacy-default` UUID `ffde5cd7-ab81-4086-afcd-14b6d82219c6`. **CHƯA ĐẠT:** preflight dừng `BLOCKED_TARGET_CONFLICT` exit 1 (read 22 · skipped 10 · failed 2) ⇒ execute / replay / fail-policy / hồi quy LDBA-08 **không chạy**. **Nguyên nhân gốc — coordinator đã verify trực tiếp, không tin receipt:** (1) **blocker duy nhất là lỗi fixture** — `001_connector.sql:1-9` khai `adapter TEXT NOT NULL`, W3 `revision` **thiếu** `adapter`; runner `mapConnector` (`:496-512`) **không** đòi `adapter` ⇒ fix một field là đủ. Coordinator đọc `006`/`007`/`008` để chứng minh field này **đủ** không chỉ hợp lý: `006` thay CHECK state thành `PENDING/ACTIVE/RETIRED` (nghi ngờ `RETIRED` vi phạm CHECK là **báo động giả**), `007` backfill `credential_source` NOT NULL, `008` PK `(connector_id, tenant_id, revision)` + chain guard + `bound_source_is_vault` (`tenant_id = '' OR kind = 'vault-kv2'`) — các field còn lại của fixture (`tenant_id: ''`, `account_id: null`, `credential_source: {kind:'legacy-db', credentialRef}`, `credential_ref` distinct theo hàng) **đã thỏa mọi** constraint. (2) **Hai mâu thuẫn fixture trong spec §3.4 là lỗi coordinator** (errata §9 của spec): AppSetting yêu cầu **khác `key`** cùng slug nhưng `appSettingSlug` suy slug từ `key` ⇒ không thỏa được, chốt lại **cùng `key`** (nguồn thật `AppSetting.key` UNIQUE nên va chạm khác-key không thể; tiebreak `:758` chỉ verify bằng đọc code); User yêu cầu 3 user pending **và** assignment trỏ user đã ghi ⇒ mâu thuẫn trừ khi có hash scrypt, chốt lại **cả 3 pending** + assignment[1] dùng `userId` non-UUID, **không bịa hash**, đường ghi assignment bù bằng test offline. (3) **Bug thật của W4** — `assertReportSkips` hoán `OVERRIDE_CONNECTION_ID_NOT_UUID` và `OVERRIDE_CONNECTOR_NOT_MIGRATED` (seed `fixtureOverride(index)` đặt `connectionId: CONNECTOR_IDS[index]`; runner check `OVERRIDE_CONNECTOR_NOT_MIGRATED` **trước** `:549-554`) ⇒ preflight dừng trước khi assertion này chạy. **Coordinator chốt:** owner **đúng** khi dừng, **không** sửa lung tung, **không** bịa credential, container đã remove. Đây là lần thứ 5 nguyên nhân gốc thuộc **spec của coordinator** (sau LDBA-06 R1..R3, LDBA-07, LDBA-08), **không** phạt owner |
| LDBA-09A | **Unblock rehearsal** — sửa fixture W3 (thêm `adapter`) + sửa W4 (hoán expectation) + bù test offline W2, rồi chạy lại đủ 5 lượt | runtime owner (**implementer**, cùng owner LDBA-09) | LDBA-09 (receipt) | W2 test + W3 fixture adapter + W4 harness + receipt mới | `reports/ldba-09A-fixture-unblock.md` | **DISPATCHED** 2026-10-09 — spec `dispatch-specs/2026-10-09-LDBA-09A-fixture-unblock.md`. **Vì sao:** blocker LDBA-09 là **một field** trong file test-only, đã chứng minh là đủ bằng đọc `006`/`007`/`008`; không cần sửa runner, không cần sửa schema, không cần sửa adapter production. **Phạm vi tối thiểu (3 thay đổi):** (1) W3 thêm `adapter` (string không rỗng, deterministic, rõ synthetic) vào object `revision`, giữ nguyên mọi field khác; (2) W4 sửa hai dòng bị hoán trong `assertReportSkips` về đúng thứ tự `OVERRIDE_CONNECTOR_NOT_MIGRATED` (OVERRIDE_IDS[1]) / `OVERRIDE_CONNECTION_ID_NOT_UUID` (OVERRIDE_IDS[2]); (3) W2 thêm **≥2** test offline đường **ghi** (`mapAssignment` ghi được, `mapConnector` ghi được) vì rehearsal không chạy được đường ghi assignment. **Chốt fixture theo errata §9 của LDBA-09:** AppSetting giữ 2 hàng **cùng** `key`; User giữ cả 3 pending + assignment[1] non-UUID, **không** tạo hash. **Chạy lại 5 lượt:** preflight `report` → execute → execute lần 2 (idempotent) → preflight `fail` (`BLOCKED_SKIPPED_ROWS`) → hồi quy adapter LDBA-08 (kỳ vọng **còn** `TRANSFORM_ERROR` cho connector/profile/workflow/file — đúng, không phải hồi quy). **Ranh giới:** không sửa runner, không sửa adapter LDBA-04/05/06/08, không sinh hash, không đọc DB thật, không commit/`git add`/push, không tick gate, container phải remove. **A1 vẫn mở** | **RECEIPT — BLOCKED ở lượt 3 (Replay Idempotency)** 2026-10-09, owner `term_d93ff3b1` (Codex-4). Lượt 1 preflight và lượt 2 first execute đạt, ghi thành công 20 destination rows; lượt 3 dừng do 6 hàng `TARGET_IMMUTABLE_CONFLICT` (độ lệch kiểu dữ liệu BigInt, jsonb, timestamptz giữa driver `pg` và runner). |
| LDBA-09B | **Replay Unblock** — chuẩn hóa `normalizeComparable` & `sameValue` cho BigInt, JSONB, Date/timestamptz, và JSONB array serialization trong `ldba-03-production-adapter.cjs` | runtime owner (**implementer**) | LDBA-09A (receipt) | adapter + test + harness + receipt | `reports/ldba-09B-replay-unblock.md` | **DISPATCHED & COMPLETED** 2026-10-09 — spec `dispatch-specs/2026-10-09-LDBA-09B-replay-unblock.md`. **Kết quả:** Đã giải quyết triệt để độ lệch kiểu dữ liệu giữa PG driver và runner (BigInt vs number, JSONB string vs object/array, chuỗi số thập phân `numeric(20,6)`, Date millisecond). Cập nhật harness nhận diện migration 0038 (38 migration orchestrator + 9 connector, 34 bảng public). Toàn bộ 5 lượt rehearsal trong disposable PG16 `--network none` tmpfs đều **PASS exit 0**: (1) `FIXTURE_PREFLIGHT_READY`, (2) `FIXTURE_APPLIED_FIRST` (20 rows), (3) `FIXTURE_APPLIED_REPLAY_ALL_IDENTICAL` (all identical), (4) `FIXTURE_FAIL_POLICY_BLOCKED`, (5) `LDBA08_REGRESSION_EXPECTED_CONTEXT_FAILURES`. `HARNESS_PASS disposable_pg16=1`. | **RECEIPT — ALL 5 ROUNDS PASS exit 0** |
| LDBA-09-VFY | **Xác minh độc lập LDBA-09B** | independent tester (`term_ca784044`, Codex-1) | LDBA-09B (receipt) | verify receipt | `reports/ldba-09-verify.md` | **COMPLETED & VERIFIED** 2026-10-09. Chạy độc lập 3 test offline (42/42 pass exit 0) và harness rehearsal PG16 (`IN_CONTAINER_EXIT=0`, `HARNESS_PASS`, container removed). Cả 5 round đều pass đúng assertion. | **VERIFIED exit 0** |

**Thứ tự:** LDBA-00/01 (chốt) → 02 (field) → 03..06 song song theo owner → 07 verify (**NOT-PASS**) → 08 (adapter production + harness, **NOT-PASS**) → 09 (reconcile runner contract) → 09A (unblock rehearsal) → 09B (replay unblock) → **09-VFY (VERIFIED)**.
**Trạng thái 2026-10-09:** LDBA-00 VERIFIED · LDBA-01 ACCEPTED · LDBA-02 ACCEPTED · LDBA-03 **ACCEPTED** (module) · LDBA-04 **ACCEPTED** (module) · LDBA-05 **ACCEPTED-WITH-CONDITIONS** (module) · LDBA-06 **VERIFIED (module scope)** · LDBA-07/08/09/09A/09B/09-VFY: **Hạ tầng runner, adapter production và rehearsal trên disposable PG16 đã HOÀN TẤT VÀ ĐƯỢC XÁC MINH ĐỘC LẬP (ALL 5 ROUNDS PASS, EXIT 0)**. Mọi tiêu chí idempotent, preflight, write, và controlled skip đã được chứng minh trên PG16 thực tế biệt lập.
**Năm định nghĩa cần nhớ khi đọc tiếp:** tenant có **hai** từ vực (orchestrator uuid+FK = `legacy-default` tên; connector text = `''` UNBOUND); digest workflow schema là **canonical-pin**, không phải raw JSON; `connector_prompt_overrides.connection_id` là **uuid-only, cấm nới** — và uuid đó **không có bảng tham chiếu** (không tồn tại bảng `connectors`) nên override projection bị hoãn ở v1; **timezone legacy chưa chứng minh** — runner đang giả định UTC cố định, A1 phải xác nhận trước backfill thật; **writer production `provisionLegacyWorkflowSchema` là nguồn chân lý ghi catalog** — adapter workflow schema phải delegate cho nó, không tự bọc envelope.
Mọi packet cần: task ID, exact lease, owner từ live roster, acceptance, receipt path. Không dùng DB production/legacy thật để lấy fixture (`WORKFLOW-API-BACKWARD-COMPAT:97`).

### 8.1. Điều chỉnh phát hiện từ LDBA-00 (2026-10-09)

LDBA-00 **VERIFIED** và ghi nhận **7 điểm plan sai so với code thật**. Coordinator đã spot-check 6 trích dẫn — tất cả khớp. Các điểm này được đưa vào LDBA-01 để **chốt lại**, chưa sửa ở đây (sẽ cập nhật §4/§6 sau khi ADR có verdict):

| # | Plan đang nói | Thực tế |
|---|---|---|
| L1 | mọi bảng rework có `tenant_id` NOT NULL | 5 bảng không có cột tenant; 2 bảng tenant là **text**; 1 bảng nullable |
| L2 | `UserProfileAssignment` 1-1 + tenant | bảng không có cột tenant |
| L3 | thêm `operations.webhook_url` | `operations.callback_url` **đã tồn tại** (`0007:7`) — thêm nữa là trùng ngữ nghĩa |
| L4 | `submission_keys`/`webhook_deliveries` không có nguồn legacy | là nguồn **một phần** (`idempotencyKey`, `webhookUrl`, `webhookSentAt`) |
| L5 | `allowedFileExtensions` là JSON | là **CSV text**; `fileUrlAuthConfig` là chuỗi `iv:tag:ciphertext`, không cast JSON mù |
| L6 | — | `rateLimitPerMin`/`maxConcurrent` **chưa** có trong §6 → **đã quyết: KHÔNG thêm** (xem §3.4) |
| L7 | §3.3 là danh sách đầy đủ | thiếu `artifact_multipart_parts`, `connector_invocations`, `connector_usage_outbox` |

### 8.1.1 Kết quả spot-check chất lượng của ADR LDBA-01 (2026-10-09, coordinator)

Cùng kỷ luật đã dùng để VERIFIED LDBA-00: coordinator tự đọc lại **toàn bộ** trích dẫn `file:line` của ADR, không tin receipt.

- **Đúng (giữ nguyên, 27 nhóm trích dẫn):** `lib/db/schema.ts:11,20,23,27-28,33,34,54,60-61,73,86-87,104,123,127-131,130-131,134-137,146-150,157,175,177,179-182,191` (22 vị trí) · `0001_platform_v1.sql:16,24,36,38,58,70,94,102,114,127` · `0007_webhook_deliveries.sql:7` · `0024:39` (`pipeline_json jsonb`) · `0024:61` (`total_cost_usd numeric(20,6)`) · `0037_legacy_workflow_schema_catalog.sql` · `0027_profile_active_pointer.sql:32-41` · `0026_profile_policy.sql:54-60` · `workflow-schemas.ts:70-75,202-210,287-295` · `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:76,148,254-255,260-263`.
- **Sai (1 chỗ):** ADR trích `0023_admin_local_users.sql:1-20` cho policy `Deliberately NOT backfilled`. File đó dài **23 dòng** và có **0** lần xuất hiện `backfill`. Header thật nằm ở `0024_legacy_parity_columns.sql:24-30` và `0026_profile_policy.sql:172-180` — cả hai là **comment**, không phải constraint, và cả hai đều trích `docs/14-reference-compatibility.md` rằng rework là dự án mới, không migrate dữ liệu/credential nào.
- **Phân loại:** đây là **lỗi trích dẫn + lỗi framing**, **không phải** lỗi suy luận. Kết luận của ADR vẫn đúng dưới trích dẫn đúng, nhưng cần sửa framing vì lý do vận hành: nếu LDBA-04 hiểu nhầm rằng `admin_local_users` có policy backfill riêng, nó sẽ hòa giải với một thứ không tồn tại và bỏ lỡ việc cần làm thật — **đảo ngược giả định cấp deploy** `fresh project, no data/credential migration` mà toàn bộ plan LDBA đang đảo ngược.
- **Xử lý:** coordinator **không tự sửa** receipt (vi phạm ranh giới COORDINATOR-CONTRACT). Đã dispatch `LDBA-01-C1` cho đúng owner của ADR (`codex_worker_4` / `term_d93ff3b1`) với phạm vi 3 chỗ sửa chính xác; xem `dispatch-specs/2026-10-09-LDBA-01-C1-citation-fix.md`.
- **Kết quả correction (2026-10-09, coordinator verify):** `LDBA-01-C1` **đã về** và coordinator đọc lại cả 3 chỗ: trích sai = **0**; cả 2 chỗ trích `0024_legacy_parity_columns.sql:24-30` + `0026_profile_policy.sql:172-180` và nói rõ đây là **giả định cấp deploy** (không phải policy riêng của bảng); ghi chú `LDBA-01-C1` có trong §5; verdict L1..L7 / transform §4.1..§4.6 / quyết định A1/A2 **không đổi một ký tự**. ⇒ **LDBA-01 ACCEPTED.**

### 8.1.2 Quét consumer field-level cho §6 (2026-10-09, coordinator)

ADR LDBA-01 đặt gate: *"consumer inventory phải quyết định từng field đề xuất"*. `COMP-01` không thỏa (chỉ route-level). Coordinator tự quét field-level (read-only, trong ranh giới) trên `services/orchestrator/src/**` + `apps/admin-web/src/**`.

**Kết quả: 0/8 cột cũ có consumer.** Chi tiết từng cột + nguồn thay thế: **§6.1**. Hai hệ quả hành vi: **§6.2**. Quyết định D6: **§9.2**.

**Lưu ý phương pháp:** lần quét đầu coordinator dùng nhầm path `du-rework/apps/admin-web/src` (không tồn tại) — `cd` fail nhưng loop vẫn chạy từ thư mục trước, ra số liệu **sai** (`filesJson=14`, `rateLimitPerMin=3`, `webhook_url=55`). Đã phát hiện qua `find . -maxdepth 3 -name admin-web -type d` → path thật `du-rework/orchestrator/apps/admin-web/src`, quét lại → **tất cả = 0**. Bài học: không tin số liệu khi `cd` trong command thất bại.

### 8.1.3 LDBA-02 — owner quét lại độc lập, xác nhận (2026-10-09)

Owner không tin kết quả của coordinator mà tự chạy **8 lệnh `rg`** trên **5 cây thư mục** (`orchestrator/src`, `admin-web/src`, `connector/src`, `orchestrator/migrations`, `connector/src/db/migrations`), mỗi lệnh ghi rõ exit code + số hit. Kết quả khớp 8/8 với §6.1.

**Ba điểm owner làm rõ chính xác hơn coordinator:**

1. **`webhook_url` có 13 hit, không phải 0** — nhưng là **wire-level input alias** map vào `submission.callback` → `operations.callback_url` (`legacy-input-decoders.ts:307-312` → `submission.ts:572-594`). Không phải consumer của cột persist. ⇒ Tiêu đề "0/8" của §8.1.2 phải đọc là **0 consumer của cột lưu trữ**, không phải 0 tham chiếu tên.
2. **`done` có 23 hit** — nhưng phần lớn là iterator `.done`, comment, shape tương thích. Consumer thật duy nhất là **projection** `done: isTerminalState(rawState)` (`legacy-host-adapter.ts:474`), tức **suy ra**, không đọc cột.
3. **`created_by_user_id` có 3 hit** — nằm trong `FORBIDDEN_IDENTITY_HEADERS` (`legacy-input-decoders.ts:151,177-178`), tức compat mount **từ chối** field, không phải đọc nó.

**Open item 2 của owner — đã sửa:** §6.1 ghi `state` là "enum" — **sai**. `0001:43` khai `state text NOT NULL DEFAULT 'ACCEPTED'`; quét toàn bộ `migrations/` cho `CREATE TYPE` và CHECK trên `state` = **0 kết quả**. Đã sửa thành "application state vocabulary, không phải PostgreSQL enum".

**Verdict: LDBA-02 ACCEPTED.** Không sinh migration nào. Gate cho LDBA-03 đã mở.

### 8.1.4 LDBA-05 — coordinator chốt 6 open item của owner (2026-10-09, theo uỷ quyền tự quyết)

Receipt `reports/ldba-05-connector-adapter.md` ngỏ **6** câu hỏi cho coordinator. Dưới đây là quyết định của từng câu, mỗi quyết định đều có evidence verify trên source trước khi chốt. **Không câu nào cần sửa packet LDBA-05** — 3 câu đóng bằng chấp nhận, 3 câu chuyển thành packet riêng.

**Câu 1 — không đọc được `lib/db/schema.ts` root (repo scope `du-rework`): ĐÓNG, không cần làm gì.**
LDBA-00 (`reports/ldba-00-schema-mapping.md`) đã ở trạng thái **VERIFIED** và là nguồn mapping field được dùng cho cả LDBA-03/04/05. Danh sách 17 field owner giữ trong `config` lấy từ đó là đúng nguồn. Không yêu cầu owner đọc lại root repo vì việc đó nằm ngoài lease. Việc đọc chéo này là **biên đúng** (owner tự khai), không phải lỗi.

**Câu 2 — gắn override vào revision cụ thể, và hoà giải `connection_id` uuid với connector id text: v1 HOÃN, cần packet riêng.**
Coordinator verify ba điều trên disk:
- `0026_profile_policy.sql:121-139`: `connector_prompt_overrides` có `connection_id uuid NOT NULL` và **không có cột revision** ⇒ **không thể** ghim một revision cụ thể mà không đổi schema.
- **Không tồn tại bảng `connectors` ở bất kỳ đâu**: quét `CREATE TABLE` trong cả hai cây migration (`connector/src/db/migrations/`, `orchestrator/migrations/`) cho `connectors` = **0 hit**; connector migration chỉ tạo `connector_revisions`, `secret_versions`, `connector_invocations`, `connector_usage_outbox`. ⇒ **uuid `connection_id` không có bảng tham chiếu, không có nguồn sinh ra nó.**
- `connector_revisions.connector_id` là **TEXT** (`001_connector.sql:2`), trong khi override đòi **uuid**.

⇒ Cả hai vế đều không thực thi được trong write set hiện tại, và nới `connection_id` sang text bị `0026:118-120` **cố ý từ chối**. Quyết định: **v1 không chiếu `ExternalApiOverride` vào `connector_prompt_overrides`** (adapter hiện đã không ghi bảng này — đúng). Muốn bật override cần packet thiết kế riêng với một trong hai lựa chọn: tạo bảng uuid-keyed `connectors`, hoặc sửa contract để `connection_id` mang nghĩa khác. **Không** quyết vụn vào LDBA-05.

**Câu 3 — tenant `legacy-default` vs tenant UNBOUND rỗng: ĐÃ CHỐT ở §4.1, hành vi owner đúng.**
`connector_revisions.tenant_id` là `TEXT DEFAULT ''` theo `008:16-20` (comment `008:3-8`), và LDBA-03 ép đúng như vậy tại `scripts/ldba-03-backfill.cjs:438-446`. Connector **không** dùng `legacy-default`; đó là từ vựng **thứ hai** (orchestrator mới dùng uuid + FK). Owner làm đúng. Đóng, không cần sửa.

**Câu 4 — `DISABLED` → `RETIRED`: GIỮ NGUYÊN, đây là chủ ý.**
Ba lý do, đều verify:
1. **Tiền lệ đã có trong chính codebase**: `006_connector_revision_lifecycle.sql` chạy `UPDATE connector_revisions SET state='RETIRED' WHERE state='DISABLED'` **trước khi** dựng lại CHECK constraint, và ghi rõ không có writer nào phát ra `DISABLED` nữa, chạy lại hội tụ về cùng constraint.
2. **Không khác nhau về bảo mật**: `006` định nghĩa chỉ **ACTIVE** là routable. `PENDING` (chờ gắn credential) và `RETIRED` (kết thúc) đều **không** được dispatch. Chuyển `DISABLED` sang `PENDING` cũng không mở routability.
3. **Trong mô hình revision-centric, bật lại không phải là đảo ngược state**: bật lại một connector = **tạo revision ACTIVE mới**, không phải lật một row terminal. Nên tính terminal của `RETIRED` **bảo toàn lịch sử audit** thay vì làm mất hành vi.

Thứ duy nhất bị mất là tiện ích cũ *lật một row về ENABLED*. Đó là thứ **được thay bằng revision mới một cách có chủ ý**, không phải hành vi bị bỏ sót. Xác nhận.

**Câu 5 — execution parity của `multipart-http`: NGOÀI phạm vi LDBA-05, nhưng là khoảng trống chặn cutover.**
Docstring của chính module (`:100-103`) tự khai phạm vi: projection thuần offline, không SQL, không migration. Việc `multipart-http` có **tiêu thụ** `staticFormFields`/`fileUrlFieldName`/`defaultPrompt` hay không thuộc tầng invoker/adapter lúc chạy, không thuộc projection. Điểm quan trọng: owner **đã giữ nguyên** 17 field trong `config`, nên packet parity về sau **không** cần chiếu lại dữ liệu. Đóng với điều kiện — **một packet verify parity phải chạy trước cutover**, vì nếu không các field đó là config chết.

**Câu 6 — connector không có `authSecret`: FAIL-CLOSED là đúng, nhưng phải báo tên.**
Coordinator verify: `ConnectorCredentialSourceSchema` (`packages/contracts/src/vault.ts:185-191`) là union của **đúng ba** shape — `legacy-db` + hai biến thể `vault-kv2`. **Không có** kind *none* / *unauthenticated*. Và `connector_revisions.credential_ref` là `TEXT NOT NULL` (`001:6`). ⇒ **Không tồn tại cách biểu diễn** một connector không credential trong mô hình đích. Dừng (fail-closed) là hành vi đúng: chiếu nó thành một shape gửi request không credential là rủi ro, còn dừng thì không.

Kèm điều kiện bắt buộc: **mọi row bị dừng phải vào danh sách có tên trong backfill report, kèm lý do** (`MISSING_SECRET` / `UNSUPPORTED_AUTH_TYPE` / ...) — không được rơi im lặng. Thêm `authType` ngoài `API_KEY_HEADER` cũng dừng (`:114`). Hỗ trợ connector không auth sẽ cần **kind credential mới** ⇒ đổi contract ⇒ packet riêng.

**Điều LDBA-05 còn dính sau khi chốt:** đúng **2** khoảng trống, đều không chặn module scope và đều đã biết chủ đích:

| Khoảng trống | Bản chất | Chặn cutover? |
|---|---|---|
| Override projection | Cần packet thiết kế riêng (uuid không có nguồn, không có cột revision) | Không ở v1 — v1 không dùng override |
| Execution parity `multipart-http` | Packet verify riêng, field đã giữ trong `config` | **Có** — phải chạy trước cutover |

### 8.1.5 Bổ sung kiểm chứng từ 2 review mới (2026-10-09, coordinator, read-only)

Hai báo cáo review mới **không được plan này tham chiếu ở đâu cả** (grep `MDB-`/`ARC-`/`SEC-ENC-06` trên plan = **0 hit**):
- `reports/legacy-db-migration-review-codex-2026-10-09.md` — **MDB-01..MDB-08** (7 HIGH + 1 MEDIUM), review tĩnh, không chạy DB.
- `reports/architecture-code-review-codex-2026-10-09.md` — **ARC-01..ARC-06** (4 HIGH + 2 MEDIUM), backlog chưa dispatch.

Yêu cầu là **check lại kỹ issue có chính xác không trước khi đưa vào plan**. Coordinator đã tự đọc lại từng issue trên **source gốc**, không tin receipt của cả hai báo cáo. Dưới đây là kết quả kiểm chứng + các ràng buộc phát sinh. **Không có issue nào bị bác; có 2 chỗ được siết lại và 1 receipt bị bỏ sót.**

#### A. Kết quả kiểm chứng MDB-01..08

| ID | Mức | Claim gốc | Kiểm chứng coordinator | Kết luận |
|---|---|---|---|---|
| MDB-01 | HIGH | `production-adapter.cjs:122` phụ thuộc `LDBA03_CONTEXT_MODULE`, không thấy provider | **SIẾT MẠNH HƠN**: quét toàn repo, symbol `LDBA03_CONTEXT_MODULE` có **đúng 1 occurrence** — chính dòng đọc env tại `ldba-03-production-adapter.cjs:149` trong `loadContextProvider`. Không có provider module nào tồn tại, không phải chỉ *ngoài phạm vi đã rà* | **Đúng, nghiêm trọng hơn review nói** |
| MDB-02 | HIGH | replay không ổn định qua type PG + re-encrypt mỗi lần | bigint/numeric/timestamptz: **đã đóng bởi LDBA-09B** (`canonicalNumeric:160`, `timestampMilliseconds:185`, `normalizeComparable:214`, `sameValue:259`, binding JSONB `:291`, map `JSONB_COLUMNS:70`). Vẫn mở: re-encrypt IV ngẫu nhiên mỗi lần (`legacy-connector-adapter.ts:150-152` + `services.ts:35`) và **2 conflict ProfileEndpoint chưa quy hết về bigint** | **Đúng, nhưng một nửa đã superseded** |
| MDB-03 | HIGH | import `RUNNING` tạo operation không tiếp tục được | `OPERATION_STATE` (`ldba-03-backfill.cjs:35-39`) đúng chỉ có `RUNNING/SUCCEEDED/FAILED`; đường ghi `:351-427` chỉ tạo row `operations`, không root task/lease/checkpoint/outbox | **Đúng nguyên văn** |
| MDB-04 | HIGH | backfill ghi plaintext, bypass crypto/storage facade | `:407-425` ghi `pipeline_json`/`steps_result_json`/`extracted_data`/`output_content`/`error_message` thẳng; `:689-748` đọc FileCache rồi `write('artifact_blobs', storageKey, {storage_key, bytes: body})` + `storage_backend: 'postgres'` — **không** qua crypto seam | **Đúng** — xem mục B |
| MDB-05 | HIGH | có data nhưng không giữ hành vi multipart | `src/adapters/http.ts` nhánh multipart hardcode tên field; **không** đọc `requestMapping`/`staticFormFields` trong khi projector đã giữ chúng | **Đúng nguyên văn** |
| MDB-06 | HIGH | re-hash chưa nối vào auth; quyền cũ chưa bảo toàn | `migrateLegacyLocalCredentialOnLogin` có **0 callsite production** (chỉ definition + test); `production-adapter.cjs:631-635` **luôn** ném `PASSWORD_RESET_REQUIRED` | **Đúng nguyên văn** |
| MDB-07 | HIGH | profile auth chỉ kiểm hình dạng ciphertext | `backfill.cjs:241-256` + `:623` copy `iv:tag:ciphertext` chỉ qua regex hình dạng; target derive key từ `ENCRYPTION_KEY`/`NEXTAUTH_SECRET` | **Đúng nguyên văn** |
| MDB-08 | MEDIUM | không có shared snapshot; preflight không thuần SELECT | **SIẾT MẠNH HƠN**: `inTransaction` (`:330-333`) chỉ phát `BEGIN` trần; grep `REPEATABLE`/`isolation` trên **cả hai** script chỉ khớp **duy nhất** dòng `BEGIN` đó ⇒ **không** có snapshot dùng chung ở bất kỳ đâu | **Đúng, nghiêm trọng hơn review nói** |

#### B. MDB-04 không phải issue mới — nó là **SEC-ENC-06**, packet đã mở sẵn

Coordinator verify đủ 3 nguồn, cả 3 đều đã có sẵn trong repo:
- `docs/41-persistence-encryption-policy.md:85-86` — `Historical plaintext rows and backups are handled by SEC-ENC-06; enabling new-write encryption does not rewrite history.`
- `tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md:87` — `SEC-ENC-06 - historical data migration and compatibility`, owner = data migration/crypto owner, allowed paths gồm encryption/backfill CLI + Connector migration helpers, **không** shared/live DB hay S3 mutation ở phase implementation.
- `tasks/DU-PLATFORM-MIGRATION-2026-10-05.md:395` — checkbox `SEC-ENC-06: historical plaintext dry-run/backfill, bounded migration window, old versions/backup disposition` vẫn **chưa tick**.

⇒ **Không mở packet mới cho MDB-04.** Nó là phần việc chưa làm của SEC-ENC-06. LDBA chỉ cần **nối** đường ghi backfill vào crypto/storage ports; phần migrate lịch sử thuộc lease SEC-ENC-06, không thuộc lease LDBA.

**Nâng từ mismatch lên vi phạm.** `docs/41-persistence-encryption-policy.md:23` (fail-closed rule, nguyên văn): *Missing policy, crypto seam, wrapping service or key fails the write; no plaintext fallback on error/retry paths.* Ghi plaintext thẳng vào cột đích là **vi phạm câu này**, không đơn thuần là chưa khớp kiểu dữ liệu. Hai câu bổ trợ cùng file cùng áp dụng:
- `:25-26` — synthetic-data exemption là **explicit only**, không bật được bằng cấu hình bị bỏ sót. Rehearsal LDBA-09 dùng synthetic **không** cấp exemption cho production path.
- `:29` — `an unclassified field is not an exemption`. Các field backfill ghi thẳng (`output_content`, `extracted_data`, `error_message`, bytes trong `artifact_blobs`) **không** được coi là an toàn vì chưa ai phân loại.
- Dòng `:83` của cùng file (row 21, `profile_bindings.file_url_auth_cipher`, trạng thái **ENFORCED**) là chỗ dữ liệu của MDB-07 được chính policy đánh dấu là phải seal.

#### C. Ranh giới AppSetting cùng `key` — fixture **không** thể chứng minh tiebreak khác-key

`reports/ldba-09-unblock-guide-2026-10-09.md:37-38` (Chốt 1, nguyên văn phần hệ quả): tiebreak tính định đoạn tại `ldba-03-backfill.cjs:758` **chỉ verify được bằng đọc code, không chứng minh được bằng fixture khác-key**. Lý do: `appSettingSlug` (`:650-654`) suy slug từ `row.key.slice('wb_schema:'.length)` nên khác `key` là khác slug, và `AppSetting.key` ở nguồn legacy thật là **UNIQUE**.
`reports/ldba-09A-fixture-unblock.md:48` xác nhận cùng ranh giới: fixture giữ 2 hàng cùng key và **không** chứng minh được nhánh khác-key.

⇒ Cả 5 round PASS của LDBA-09/09B **không** đóng được nhánh tiebreak khác-key. Đây là **giới hạn bằng chứng** phải ghi kèm mọi lần trích 5-round PASS, không phải lỗi.

#### D. A1 timezone — cụ thể hoá mức độ rủi ro

`ldba-03-backfill.cjs:197-204` (`timestampUtc`): regex chỉ nhận timestamp **naive** `YYYY-MM-DD[ T]HH:MM:SS[.ffffff]`; bất kỳ offset hoặc hậu tố `Z` nào ⇒ `fail(..., 'TIMESTAMP_NOT_NAIVE')`. Sau đó runner **diễn giải giá trị naive đó là UTC cố định**.
⇒ Hai nhánh, và cả hai đều là rủi ro thật: nếu nguồn trả timestamp **có offset**, backfail hàng loạt; nếu nguồn trả **naive local wall time**, runner sẽ dịch sai instant của **mọi** hàng mà không báo lỗi nào. `ldba-09A-fixture-unblock.md:50` và receipt DSH (mục D dưới) đều nêu rõ: fixture UTC tường minh **không đóng A1**.

#### E. ARC-01/ARC-02 tương tác với MDB-08 — **không** tạo xung đột lease, nhưng cùng nằm trên một seam

Coordinator đối chiếu: ARC row `1A` (Orchestrator owner) và row `2` (Orchestrator owner) của `architecture-code-review-codex-2026-10-09.md:108,111` đều là **Orchestrator owner**. Lease LDBA đang mở (LDBA-03/08/09/09B) nằm ở `scripts/*.cjs` + `tests/*.cjs` dưới `services/orchestrator` — **không giao** với `src/modules/runtime/runtime.ts` hay `src/app/bootstrap/create-app.ts` mà ARC-01/02 sẽ sửa. ⇒ **Không có xung đột lease trực tiếp.**

Điểm cần ghi nhớ thay vì (đã kiểm tra kích thước file trên disk): `create-app.ts` **1.158 dòng**, `runtime.ts` **2.164 dòng**, `server.ts` **434 dòng**. Review kiến trúc đã xếp hạng mục 4 là tách composition root + background supervisor. Khi tách, **context provider của LDBA-03 (MDB-01) phải được đăng ký ở seam composition mới**, không ở seam cũ — nếu không, fix MDB-01 sẽ bị bỏ sót khi refactor. Đây là **ràng buộc thứ tự**, không phải mâu thuẫn nội dung.

#### F. Receipt xác minh thứ hai của LDBA-09B — **bị plan bỏ sót**

`reports/ldba-09-verify-INDEPENDENT-DSH-2026-10-09.md` (97 dòng) là receipt xác minh độc lập **thứ hai**, của lane DSH (`term_8bfe6adc`), chạy **Node v22.23.3** (receipt đã ghi ở dòng 325 chạy **v24.21.0**) trên HEAD `72e225ae`, container riêng (`CONTAINER_REMOVED du-ldba09-pg16-1791511947140-7784`). Kết quả **khớp**: 42/42 offline exit 0; harness exit 0, `HARNESS_PASS disposable_pg16=1 network=none tmpfs=1 published_ports=0`; đúng 5 marker `FIXTURE_*` / `LDBA08_*`.

Lane DSH ghi rõ **không** ghi đè path `ldba-09-verify.md` đã bị chiếm, nên mới sinh path hậu tố lane + mục đối chiếu riêng (receipt `:87-97`).

Bốn điều DSH bổ sung mà receipt kia không có, và chúng đều **load-bearing**:
1. **Digest sha256 của 4 file** (receipt `:11-16`) — 4 file LDBA-09 đều **untracked** (`??`), nên mọi verify chỉ gắn với working tree tại thời điểm đó; đổi file là mất hiệu lực.
2. **Identity table 0 là đúng thiết kế** (receipt `:80`): `admin_local_users=0`, `user_profile_assignments=0`, và mọi hàng bị skip đều có mã — `IDENTITY_PENDING_REHASH` ×3, `ASSIGNMENT_USER_NOT_MIGRATED`, `ASSIGNMENT_USER_ID_NOT_UUID`. Không phải backfill hỏng.
3. **Skip có kiểm soát 10/22 hàng nguồn**, mỗi skip đều có `code` + `reason`; `failures` rỗng ở vòng 1-3 ⇒ **zero parse failure**.
4. **Vòng 4 và 5 là vòng âm tính có chủ đích**: runner exit **1** theo thiết kế (`BLOCKED_SKIPPED_ROWS` / `BLOCKED_TRANSFORM`) trong khi harness exit **0**. Cách đọc *mọi* vòng runner phải exit 0 là **sai với thiết kế harness** — đây là điểm dễ đọc nhầm nhất của cả chuỗi LDBA-09.

⇒ **Dòng 325 của plan chỉ nêu receipt thứ nhất.** Coordinator **không sửa dòng 325** (là edit hoàn tất của lane khác); ghi chú này là chỗ tham chiếu thứ hai. DSH cũng là nguồn duy nhất nói thẳng **A1 vẫn mở** (receipt `:83`), khớp với mục D.

#### G. Đính chính dữ kiện FileCache

`ldba-09A-fixture-unblock.md:54` là nguồn chuẩn cho 6 hàng `TARGET_IMMUTABLE_CONFLICT`: Operation `20000000-0000-4000-8000-000000000001` và `…002`; ProfileEndpoint `50000000-…0001` và `…0002`; FileCache `60000000-…0001` và `…0002`. Một số bản chép lại trước đó liệt kê trùng `…0002` cho FileCache — **receipt là chuẩn**, `scripts/ldba-09-harness.cjs:40-41` khớp `…0001`/`…0002`.

#### H. Dữ kiện cũ trong review MDB — cần đọc kèm addendum

`legacy-db-migration-review-codex-2026-10-09.md:97-101` (mục `Evidence hiện có`) viết rằng LDBA-09A replay fail 6 conflict và `fail-policy` + `regression rounds chưa chạy`. Câu đó **đúng tại thời điểm viết** nhưng **đã cũ**: LDBA-09B sau đó đã chạy đủ 5 round và tất cả đều đạt đúng kỳ vọng (xem dòng 324). Đây là **addendum có ngày**, không phải lỗi của report — report là của lane khác, coordinator không tự sửa. **Mọi lần đọc MDB phải cộng thêm bằng chứng LDBA-09B/09-VFY.**

Lưu ý đọc dòng 329: câu tổng kết nhóm `LDBA-07/08/09/09A/09B/09-VFY` dưới một nhãn hoàn tất, trong khi **từng dòng của chúng vẫn ghi trạng thái riêng** (07/08 NOT-PASS, 09 runner-ACCEPTED nhưng rehearsal BLOCKED, 09A BLOCKED). Câu tổng kết nói về **hạ tầng runner + adapter + rehearsal**; **trạng thái acceptance phải đọc theo dòng**, không đọc theo câu tổng kết.

#### I. Việc chưa làm sau khi bổ sung mục này

Cả hai report đều là **review/backlog, chưa dispatch** (`architecture-code-review-codex-2026-10-09.md:103` nói thẳng single dispatcher hiện hành sẽ ánh xạ ARC ID vào task/lease khi thực thi). Coordinator **không** tạo packet LDBA mới ở đây. Việc còn mở là:
- MDB-01 (thiếu composition provider) — **ĐÃ ĐÓNG 2026-10-09** (`reports/mdb-01-composition-provider-2026-10-09.md`): provider + composition seam đã nối (2/2 + 27/27 pass, tsc 0), `LDBA03_CONTEXT_MODULE` có 5 occurrence (`create-app.ts:130,154,175`, adapter `:159`, test `:29,49`). Provider **fail-closed có chủ đích** cho 5 nhóm callback chưa có domain policy (connector, profile, workflow-schema, FileCache, legacy-user rehash) ⇒ việc còn lại là **5 packet domain policy riêng**, không phải packet "thêm provider". Blocker còn sống là **CR10-01**: `main.ts:233` gọi registration vô điều kiện và image mặc định không chứa provider ⇒ boot hỏng (xem `PLAN-OPEN-2026-10-09.md` `## 9`).
- MDB-03/04/05/06/07 đều **chặn cutover**, không chặn module scope ⇒ hợp nhất với điều kiện cutover ở `## 9` khi tới lúc.
- MDB-02 chỉ còn phần ciphertext-semantic; phần type đã đóng.

---

## 9. Quyết định đã chốt (2026-10-09, theo chỉ đạo "tự chốt")

Cả 5 câu hỏi dưới đây **đã có quyết định**. Lý do nằm ngay tại mục quyết định tương ứng trong §4 và §5; ở đây chỉ lập chỉ mục để reviewer đọc một chỗ.

| # | Câu hỏi | Quyết định | Chi tiết |
|---|---|---|---|
| D1 | A1 (view) hay A2 (backfill)? | **Cả hai, A1 trước A2** | §5 |
| D2 | Tenant: một tenant hay tách theo ApiKey? | **Một tenant chung** (`legacy-default`) | §4.1 |
| D3 | User chưa từng login (bcrypt)? | **Re-hash lần đăng nhập đầu; không nới CHECK scrypt** | §4.3 |
| D4 | Đơn vị cost sau cutover? | **Giữ `numeric(20,6)` USD ở `operations`; micro-USD chỉ cho budget** | §4.4 |
| D5 | Workflow schema trùng slug? | **`revision=1`, giữ bản mới nhất theo `updatedAt`** | §4.6 |

**Điều kiện đi kèm bắt buộc (không phải quyết định mới, là điều kiện nghiệm thu):**

- D3 kéo theo hệ quả phải nói thẳng: **user chưa từng đăng nhập trên rework sẽ không đăng nhập được cho tới khi reset mật khẩu.** Số lượng phải lấy từ backfill report, **không** ước lượng.
- D1 nghĩa là **LDBA-00 (verify) là tiền đề của LDBA-03 (backfill)**, không phải hai việc song song.
- Cả 5 quyết định đều **có thể đảo** nếu user muốn (đặc biệt D2), nhưng đảo sau khi backfill đã chạy là việc khác hẳn về rủi ro — lúc đó phải mở packet riêng, không sửa plan này.

### 9.1. Ba điểm còn mở — ĐÃ CHỐT (2026-10-09, user uỷ quyền "tự quyết")

User đã xác nhận và giao quyền chốt các quyết định còn lại. Ba mục dưới đây **không còn là câu hỏi mở**:

| # | Điểm | Quyết định của coordinator | Lý do |
|---|---|---|---|
| Q1 | Cho phép chạy migration lên DB thật? | **Có, nhưng có điều kiện.** LDBA-02 chỉ được **viết file migration**, không được chạy lên bất kỳ DB nào. Việc chạy thật là packet riêng, chỉ mở **sau khi LDBA-07 chứng minh rehearsal DB đạt** (fresh schema + synthetic data, source/target đếm khớp, zero parse failure) và sau khi app cũ đã dừng có rollback plan. | `0024:4-5` giữ chính sách additive-only; chạy sớm trên DB có dữ liệu sống là rủi ro không hoàn tác được. Việc ủy quyền là *cho phép theo cửa sổ có kiểm soát*, không phải *chạy ngay*. |
| Q2 | Thứ tự ưu tiên khi nhiều owner rảnh? | **Giữ nguyên thứ tự đã ghi ở §8**: `LDBA-00/01` (chốt) → `LDBA-02` (field) → `LDBA-03..06` (song song, chọn owner theo lease) → `LDBA-07` (verify). Không được bỏ qua LDBA-01 để chạy song song với nó, vì mọi packet sau đều dựa vào ADR. | Trình tự này là điều kiện đúng, không phải sở thích. Bỏ qua tạo việc phải làm lại. |
| Q3 | Mở route `workflows` (`ADMIN_WEB_ROUTE_NAMES`)? | **Có, mở — nhưng sau LDBA-06.** Hiện route đã đăng ký ở router nhưng màn hình chỉ render banner disabled. Mở sớm khi backend `legacy_workflow_schemas` chưa có dữ liệu sẽ ra UI rỗng. Packet mở route phải có lease riêng và phải nằm sau khi LDBA-06 có dữ liệu thật trên DB rehearsal. | `§2b.4` — nghiệm thu LDBA-06 qua UI cần route sống; nhưng mở route không có dữ liệu là hiển thị sai thực tế. |

**Lưu ý phạm vi:** Q1 **không** cho phép coordinator tự chạy migration. Coordinator vẫn giữ ranh giới `COORDINATOR-CONTRACT`: không implement, không chạy product build/test/DB. Việc chạy migration thuộc executor packet có lease.

### 9.2. D6 — Danh sách field cần bổ sung: **RÚT TOÀN BỘ** (2026-10-09, coordinator đo thật)

Đây là quyết định thứ 6, được chốt sau D1..D5 vì ADR yêu cầu *"consumer inventory phải quyết định từng field"*.

**Cách đo:** `COMP-01` (`reports/qwen-comp01-q15-consumer-inventory-2026-10-02.md`) **không dùng được** cho gate này — nó chỉ quét route-level cho `api/v1/services`, `billing/balance`, `billing/usage`, `webhook_url` (207 dòng, 0 lần nhắc ApiKey/Operation/role/note/rate-limit/concurrency). Nên coordinator tự quét field-level: `services/orchestrator/src/**` + `apps/admin-web/src/**` cho từng tên cột legacy.

**Kết quả: 0/8 cột đề xuất có bất kỳ consumer nào trong rework.** Bảng quét từng cột: **§6.1**.

**Quyết định:** không viết DDL additive nào. LDBA-02 chuyển từ *"author migration 0038+"* sang *"xác nhận không cần + tài liệu hoá bằng chứng"*.

**Điều kiện đi kèm — hai hệ quả hành vi phải được user chấp nhận trước cutover** (chi tiết §6.2):
1. **Mất per-user operation scoping** — user cũ sẽ thấy *tất cả* operation của tenant thay vì chỉ của mình.
2. **Mất key-level admin** — legacy `ApiKey.role=ADMIN` không còn tác dụng; rework chỉ có bearer token admin.

**Có thể đảo:** mở packet `LEGACY-OP-SCOPE` và `API-KEY-ROLE` nếu user muốn giữ hai hành vi đó. **Không** mở trong LDBA-02 vì không có consumer — mở khi có yêu cầu thật.

---

## 10. Xác nhận ranh giới

- Plan này **chỉ là metadata**. **KHÔNG** tạo migration, **KHÔNG** sửa source/test, **KHÔNG** chạy build/DB, **KHÔNG** commit/add/push.
- **KHÔNG** tự revert hunk nào của lane khác (COORDINATOR-CONTRACT).
- Đảo ngược giả định "fresh project, no migration" của `0024`/`docs/14` là **thay đổi scope**, cần user xác nhận tường minh trước khi bất kỳ owner nào viết migration lên DB.