# Plan: Portal Business + Profile (worker status, profile list, binding, workflow)

- Ngày: 2026-10-10 (Asia/Bangkok)
- Vai trò: Claude Code coordinator (theo `COORDINATOR-CONTRACT.md`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng DB production/legacy)
- Nguồn yêu cầu: người dùng 2026-10-10 — tab Business hiển thị business đã đăng ký kèm trạng thái worker từng business; tab Profile dạng bảng, sửa được profile gọi business/task nào, tạo API key trong profile, tạo profile mới đầy đủ thông tin kết nối và phân quyền task/endpoint; làm rõ workflow đặt ở profile hay workflow.
- Sổ mở duy nhất: `coordination/PLAN-OPEN-2026-10-09.md`
- HEAD khi khảo sát: `d0b2210`. Working tree có thay đổi chưa commit; HEAD không định danh đầy đủ các hunk đã đọc.
- Trạng thái: **SPECIFIED / chưa dispatch**. Ba quyết định kiến trúc ở §7 **đã được người dùng chốt 2026-10-10**. Không tick gate, không commit, không push, không git add.

---

## 0. Trả lời trực tiếp câu hỏi người dùng

| Yêu cầu | Hiện trạng | Kết luận |
|---|---|---|
| Tab Business liệt kê business đã đăng ký | Có màn, chỉ hiện `businessId` | **Một phần** |
| Trạng thái worker từng business (A1 online, A2 offline) | Không có bảng worker; UI Overview vẽ chấm xanh hard-code | **Chưa có** |
| Tab Profile dạng bảng chia mục | Không có màn danh sách; chỉ editor một profile | **Chưa có** |
| Sửa profile để trỏ business nào | Có selector business/version nhưng chỉ lúc nạp | **Một phần** |
| Sửa profile để trỏ task nào của business | Không có bộ chọn task/action | **Chưa có** |
| Tạo API key trong profile, dùng với endpoint của business | Tạo key ở màn riêng; grant chỉ đọc | **Một phần** |
| Tạo profile mới đầy đủ thông tin kết nối | Có (`connectionsOverride`, `fileUrlAuthConfig`, redaction, callback) | **Đã có** |
| Phân quyền profile dùng task/endpoint nào | Có ở schema (`profile_bindings.action` + `enabled`), không có ở UI | **Một phần** |
| Profile xem workflow business đã đăng ký | Không tồn tại ở cả ba tầng | **Chưa có** |

**Trả lời câu hỏi profile hay workflow:** theo kiến trúc hiện tại, **workflow không thuộc profile**. `legacy_workflow_schemas` khoá `(tenant_id, slug, revision)` — tenant-scoped, không có `business_id`, không liên kết profile. Đề xuất của plan: **định nghĩa workflow thuộc về business** (business đăng ký), **profile chỉ được xem và chọn dùng** — đúng theo mô hình sẵn có của `profile_bindings.action`.

---

## 1. Hiện trạng đã kiểm chứng trên source (không dựa vào report)

### 1.1 Business

- Màn React: `orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx`. Cột bảng tại `:181-187`: `Business | Active Version | Status | Updated | (nút Versions)`. Ô `Business` render `{row.businessId}` tại `:194` — **không có tên hiển thị**.
- Không có tham chiếu worker nào trong toàn bộ feature (grep = 0).
- BFF: `GET /admin/api/businesses` → `app/admin/bff/operations.ts:62,229-238` → upstream `http/routes/admin.ts:383-408` → `modules/admin-read/business-list.ts:23-64`.
- **Không có bảng `businesses`.** Business là nhóm `DISTINCT ON (business_id)` trên `business_versions`; chính comment `business-list.ts:28-29` nói rõ tên bảng là alias, không tồn tại thật.
- `business_versions` (`migrations/0001_platform_v1.sql:24-34` + `0006` + `0021`): `business_id, version, contract_version, manifest, digest, status, queue, created_at, is_active, updated_at`. **Không có `tenant_id`** — business là platform-global.
- `displayName`/`description` chỉ nằm trong `manifest` jsonb (`packages/contracts/src/manifest.ts:57-58`); route list **bỏ manifest hoàn toàn** (`http/routes/admin.ts:388-400`) nên UI không có tên.

### 1.2 Worker status — khoảng trống lớn nhất

- **Không tồn tại bảng worker/instance/heartbeat** trong toàn bộ `orchestrator/services/orchestrator/migrations/*.sql` (grep `CREATE TABLE` ∩ `worker|instance|heartbeat` = 0).
- Route heartbeat là stub không ghi state: `src/http/routes/runtime.ts:348-368`. Comment `:349-357` ghi rõ nó **không đọc/ghi runtime/lease state** và trả hằng số `DEGRADED`. Chính comment cảnh báo báo `HEALTHY` giả sẽ khiến operator ra quyết định sai.
- Gần nhất là lease tạm trên `tasks` (`migrations/0001_platform_v1.sql:70-91`): `leased_by`, `lease_expires_at`, `lease_epoch`. Chỉ tồn tại khi `state='RUNNING'`, bị xoá khi xong (`modules/runtime/runtime.ts:1670`), **không có cờ online/offline**, không có truy vấn nhóm theo business.
- **UI Overview hiển thị trạng thái giả.** `features/overview/overview-metrics.ts:270-304` map trên `businesses` (không phải workers) ⇒ mỗi business đúng một dòng; `status: b.status || 'ENABLED'` là trạng thái đăng ký của business; `queue` là chuỗi tự chế `du-business-${businessId}-${version}` (`:289`) bỏ qua cột `business_versions.queue`. Chấm xanh tại `features/overview/operations-monitor-dashboard.tsx:506` là `bg-green-500 animate-pulse` **hard-code**, nhấp nháy bất kể có worker hay không.
- Cột `Worker` trong bảng operations gần đây cũng sai nhãn: header `operations-monitor-dashboard.tsx:640` nhưng ô `:665-666` render `{op.businessId}`.
- Shell SSR cũ có cột `Worker heartbeat` (`app/admin/business-section-renderer.ts:214`) nhưng vĩnh viễn `No workers` vì upstream không gửi trường nào (`http/routes/admin.ts:503-512`), và dù có cũng chỉ là một badge gộp theo business-version, không phải từng instance.
- Kiểu dữ liệu đã có sẵn nhưng không nguồn: `app/admin/business-view-models.ts:31-38` (`WorkerHeartbeatState = online|degraded|offline|none`), ngưỡng `:178-179` (60s/300s).

### 1.3 Profile

- Màn: `features/profiles/profiles-screen.tsx` (một editor chi tiết). **Không có màn danh sách** và **không có route BFF list** — `bff/profiles.ts:35-48` chỉ khớp `/profiles/:b/:v/:n` (+`upsert|publish|rollback`) và `/profiles/test-endpoint`. `modules/admin-read/` chỉ có `profile-detail.ts`, không có `profile-list.ts`.
- Business là **selector lúc nạp**, không phải trường sửa được: `profiles-screen.tsx:589-607`. Ghi dữ liệu khoá theo `loadedAs` (`:354-355,375-381`) ⇒ **không thể trỏ lại profile cũ sang business khác**.
- **Không có bộ chọn task/action.** Manifest actions chỉ dùng để đặt tên mặc định (`:1181-1182`). Lệnh gửi đi không có `action` (`command-bodies.ts:36-41`); schema để `action` optional (`packages/contracts/src/profile-commands.ts:74`).
- `policyShipped` **đã là hằng `true`** tại `:312` (biến `caps` ở `:311` chết), `canTest = true` tại `:313`. **Tài liệu AWEB-11 (2026-10-08) nói nút Save bị disable vì `capabilities: []` — đã lệch, không còn đúng.**
- Tạo profile mới có đủ thông tin kết nối: `connectionsOverride` `:866-905`, `fileUrlAuthConfig` write-only `:994-1073`, `requestRedaction` `:907`, callback policy `:910-970`.

### 1.4 API key

- Tạo key chỉ ở màn riêng: `features/api-keys/api-keys-screen.tsx:81-105` `issueKey()` → `postAction('apikey.issue', { tenantId })`; dispatcher đòi đúng `tenantId` + `apiKey` (`modules/admin-actions/dispatcher.ts:668`) — **không có business/endpoint/task/profile**.
- `api_keys` (`migrations/0001_platform_v1.sql:14-21` + `0021` + `0024`): `id, tenant_id, hash, prefix, status, created_at, updated_at, name, spending_limit, total_used`. **Không có cột `profile_id`** — quan hệ là key → profile, không phải key tạo-trong-profile.
- Grant key → business/version/action nằm ở `profile_bindings.api_key_id`; UI chỉ hiển thị read-only: `api-keys-screen.tsx:305-347`, cột `Business | Version | Action | Granted` (`:321-325`), kèm chú thích `Bindings are created outside this screen.` (`:311`).
- **Không có route BFF riêng cho issue/revoke** — phải đi qua `POST /admin/api/actions` với `apikey.issue` / `apikey.revoke`.

### 1.5 Schema profile (SQL thuần, KHÔNG có Prisma)

`du-rework/orchestrator` **không có `*.prisma`** ở đâu cả (không có ORM). Schema là migration SQL viết tay, runner tại `src/db/migrations.ts`.

`profile_bindings` (`migrations/0004_profile_bindings.sql:14-28`) — **đây chính là bảng join profile ↔ api key ↔ business ↔ endpoint**:

```sql
CREATE TABLE IF NOT EXISTS profile_bindings (
  profile_id         uuid NOT NULL,
  revision           integer NOT NULL,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  api_key_id         uuid NOT NULL REFERENCES api_keys(id),
  business_id        text NOT NULL,
  business_version   text NOT NULL,
  action             text NOT NULL,
  connector_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, revision)
);
```

Cộng thêm: `enabled` (`0026:35-36`), `parameters`, `job_priority`, `allowed_file_extensions`, `file_url_auth_cipher`, `connections_override`, `request_redaction` (`0033`), `callback_policy` (`0036`). Ghi chú thiết kế `0026:14-26` nói rõ bảng này **là** profile_endpoint join, cố ý không tách bảng con.

Kèm: `profile_names` (`0028:22-34`), `profile_active_revisions` (`0027:32-41`), `user_profile_assignments` (`0026:161-170`).

⇒ **Quan hệ profile → business → task đã có sẵn ở tầng dữ liệu.** Thiếu là UI, không phải schema.

### 1.6 Workflow

`legacy_workflow_schemas` (`migrations/0037_legacy_workflow_schema_catalog.sql:4-20`):

```sql
CREATE TABLE IF NOT EXISTS legacy_workflow_schemas (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  revision integer NOT NULL CHECK (revision > 0),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  schema_ref jsonb NOT NULL CHECK (jsonb_typeof(schema_ref) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, slug, revision)
);
```

Comment dòng 1 ghi rõ: **tenant-scoped**. **Không có `business_id`.** Không có bảng cấu hình workflow theo profile. Màn `/workflows` (`features/workflows/workflows-screen.tsx`) là catalog tenant-level, không có selector business. Grep chéo: `workflow` trong `features/profiles/**` = 0, `profile` trong `features/workflows/**` = 0.

---

## 2. Quyết định kiến trúc (coordinator chốt, ghi rõ lựa chọn thay thế)

### D1 — Trạng thái worker cần state bền vững mới

Yêu cầu A1 online / A2 offline **không thể** suy từ `tasks.leased_by` (chỉ nói có ai đang chạy task, không có offline). Ba lựa chọn:

- **(a) Bảng `worker_instances` + heartbeat ghi thật (thay stub).** Đây là lựa chọn **được chọn** — chỉ nó thoả yêu cầu online/offline bền vững.
- (b) Suy từ `tasks.leased_by`: chỉ hiện đang-chạy, không có offline. Loại.
- (c) Đọc từ telemetry/deployment (AOPS-00/03/04): đúng hướng dài hạn nhưng ngoài phạm vi portal và chưa có nguồn. Ghi làm phụ thuộc, không chặn (a).

Xác thực danh tính worker **tái dùng cơ chế sẵn có**, không phát minh mới: `assertRuntimeAuth` + `authorizeWorkerBusiness` (`http/routes/runtime.ts:359-365`) cùng map `WORKER_IDENTITY_TOKENS_BY_BUSINESS` (`main.ts:61-83`) đã ràng buộc một worker với business của nó. **Đã chốt tại §7 (2026-10-10).**

### D2 — Workflow thuộc business, profile chỉ chọn dùng

- **Định nghĩa** workflow do business đăng ký ⇒ thêm cột `business_id`/`business_version` nullable vào `legacy_workflow_schemas` (additive, `NULL` = workflow không gắn business, không phá API hiện tại).
- **Profile** được **xem** workflow của business mình trỏ tới và **chọn bật/tắt** qua bảng join mới `profile_workflow_bindings`.
- Thay thế đã cân nhắc: (c) coi workflow là một `action` trong `manifest.actions[]` — sạch hơn về mô hình nhưng làm mất nghĩa legacy Workflow Builder và đụng contract manifest. **Đã loại tại §7 (chốt 2026-10-10).**

### D3 — Membership profile ↔ key đã có sẵn (cập nhật 2026-10-10)

**D3 gốc: LOẠI.** Ban đầu chốt *không đổi schema*, với luồng `apikey.issue` + `profile_bindings`. Điều đó đã không còn đúng — migration `0039_profile_api_keys.sql` đã đổi schema theo đúng hướng cần thiết, và quyết định đó đã tồn tại dưới dạng code + comment, không còn là tranh luận.

Thực tế đã kiểm chứng (2026-10-10):

- `profile_api_keys` (PK `(profile_id, api_key_id)`, `state ACTIVE/REVOKED`) là tập membership **nhiều-nhiều**. Trước nó quan hệ ngầm 1:1 nên *issue key thứ hai cho một profile tạo ra profile_id thứ hai thay vì credential thứ hai*.
- `profile_bindings.api_key_id` **giữ nguyên** với lý do cụ thể của `0039`: đó là sự thật kiểm toán *key nào đã soạn revision này*, và rotation không được viết lại lịch sử.
- Authorization đã chạy theo membership, không phải theo tác giả: `profiles.ts:366-371` join `profile_api_keys` với `state='ACTIVE'`; `probe-authorization.ts:22-30` cũng vậy.
- Action đã có: `apikey.attach` (`dispatcher.ts:821`), `apikey.rotate` (`dispatcher.ts:954` — cấp membership cho key mới rồi revoke key cũ, chung transaction `auditedMutation`).

⇒ **Không thêm `profile_id` vào `api_keys`** vẫn đúng và giữ nguyên. Nhưng **không cần thêm cột mới nào**: đường tới *một profile có nhiều key* đã mở bởi `0039`. Việc còn lại là UI, không phải schema.

### D4 — Màn Profile dạng bảng cần read surface mới

Thêm `modules/admin-read/profile-list.ts` + route `GET /admin/api/profiles` (hiện chỉ có detail).

### D5 — Sửa lỗi hiển thị sai trước khi thêm tính năng

Chấm xanh hard-code (`operations-monitor-dashboard.tsx:506`), bảng Workers một-dòng-mỗi-business (`overview-metrics.ts:270-304`), và nhãn cột `Worker` sai (`:640,665-666`) là **hiển thị sai sự thật**. Phải sửa/đổi nhãn hoặc nối nguồn thật **trước** khi thêm màn worker mới, nếu không sẽ có hai màn cùng nói dối khác nhau.

---

## 3. Hạng mục công việc

Quy ước: tái dùng ID đã có, chỉ mở ID mới khi chưa có chủ. Mọi packet phải khai task ID, lease chính xác, owner, phụ thuộc, acceptance, receipt.

### 3.1 Dùng lại ID đã có

| ID | Nội dung | Phụ thuộc | Ghi chú |
|---|---|---|---|
| **AWEB-11A** | Business read surface: thêm `displayName`/`description` từ manifest vào route list; lối đăng ký business qua BFF server-side (không đưa platform bearer vào browser) | — | Đã SPECIFIED |
| **AWEB-11B** | Profile gắn business/version + chọn action/task từ manifest; lưu `action` vào `profile_bindings` | AWEB-11A, contract freeze | Đã SPECIFIED |
| **AWEB-11C** | Workers & Queues visibility | D1, AOPS-00/03/04 | Đã SPECIFIED; chờ nguồn thật |
| **AWEB-04** | Profile editor: giữ phần thông tin kết nối đã có | — | Đang chạy một phần |
| **AWEB-05** | API Keys + Connectors: copy-once, grants | — | Đã có màn key |

### 3.2 ID mới (chưa có chủ)

| ID | Nội dung | Lease chính | Phụ thuộc | Acceptance |
|---|---|---|---|---|
| **AWEB-12** | Màn Profile dạng bảng: danh sách profile, chia mục, drilldown sang editor | `features/profiles/**`, `bff/profiles.ts`, `modules/admin-read/profile-list.ts`, `http/routes/admin.ts` | AWEB-02 | List đọc được từ dữ liệu thật; empty khác 401/403/5xx; tenant fence; không lộ secret |
| **AWEB-13** | Tạo API key trong profile: issue + bind endpoint nguyên tử | `features/profiles/**`, `modules/admin-actions/**`, `bff/profiles.ts` | AWEB-12, D3 | **ĐÃ XONG phần backend bởi `qwen_2` (P0-P3)** — còn lại chỉ UI panel (xem §8.4). Không giao owner khác. |
| **AWEB-14** | Workflow ↔ business: cột `business_id`, màn Profile xem workflow của business, bật/tắt theo profile | `migrations/`, `modules/admin-read/workflow-list.ts`, `features/profiles/**`, `features/workflows/**` | D2, AWEB-12 | Workflow cũ (`business_id IS NULL`) không đổi hành vi; profile chỉ thấy workflow thuộc business mình trỏ; test retired/NULL |
| **AWEB-15** | Sửa hiển thị sai worker ở Overview (D5) | `features/overview/**` | — | Không còn chấm xanh hard-code; nhãn `Worker` đúng nghĩa; hoặc nối nguồn thật hoặc ghi rõ chưa có dữ liệu |

---

## 4. Thay đổi schema đề xuất (additive, chưa tạo migration)

**Không tạo migration trong plan này.** Chỉ ghi DDL đề xuất để owner thực thi dưới lease riêng.

```sql
-- AWEB-11C / D1: inventory worker bền vững
CREATE TABLE IF NOT EXISTS worker_instances (
  business_id      text NOT NULL,
  instance_id      text NOT NULL,
  business_version text NOT NULL,
  state            text NOT NULL DEFAULT 'OFFLINE'
                     CHECK (state IN ('ONLINE','DRAINING','OFFLINE')),
  capacity         integer NOT NULL DEFAULT 1,
  active_leases    integer NOT NULL DEFAULT 0,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  observed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, instance_id)
);
CREATE INDEX IF NOT EXISTS worker_instances_business
  ON worker_instances (business_id, state);

-- AWEB-14 / D2: workflow thuộc business (NULL = không gắn, giữ hành vi cũ)
ALTER TABLE legacy_workflow_schemas
  ADD COLUMN IF NOT EXISTS business_id text NULL;
ALTER TABLE legacy_workflow_schemas
  ADD COLUMN IF NOT EXISTS business_version text NULL;
CREATE INDEX IF NOT EXISTS legacy_workflow_schemas_business
  ON legacy_workflow_schemas (business_id, business_version, slug);

-- AWEB-14: profile chọn dùng workflow nào
CREATE TABLE IF NOT EXISTS profile_workflow_bindings (
  profile_id        uuid NOT NULL,
  workflow_slug     text NOT NULL,
  workflow_revision integer NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, workflow_slug)
);
```

Lưu ý: **không** đặt FK `worker_instances.business_id` → `business_versions` vì business là platform-global và version có thể retire; FK sẽ chặn retire hợp lệ.

---

## 5. Ý tưởng và tính năng bổ sung (người dùng mời đề xuất)

1. **Trang chi tiết business (drilldown):** versions, actions, worker, profile nào đang dùng, workflow đã đăng ký — gom một chỗ thay vì rải.
2. **Cảnh báo worker cũ:** `last_seen_at` quá ngưỡng (60s/300s đã có ở `business-view-models.ts:178-179`) ⇒ online/degraded/offline; tái dùng từ vựng `WorkerHeartbeatState` sẵn có.
3. **Xem trước ảnh hưởng trước khi retire business version:** bao nhiêu profile/key sẽ hỏng — chặn retire mù.
4. **Ma trận endpoint theo profile:** bảng `action × enabled` đọc thẳng từ `manifest.actions[]` + `profile_bindings`, thay vì form dài.
5. **So sánh revision profile:** diff hai revision trước khi publish (đã có rollback, thiếu diff).
6. **Effective-config preview thật:** hiện là placeholder (`profiles-screen.tsx:1109-1122`) — hiện giá trị sau merge Code > Profile > Connector default.
7. **Copy-once key ngay trong profile** kèm chọn sẵn endpoint được phép, thay vì sang màn khác rồi quay lại.
8. **Tái dùng đồ thị node-flow** của `workflows-screen.tsx:665-885` để hiển thị workflow trong ngữ cảnh profile (chỉ đọc).
9. **Lọc/tìm trong tab Profile** theo business, key, trạng thái enable.
10. **Đồng bộ tên:** business hiện chỉ có `businessId`; hiển thị `displayName` từ manifest để người dùng đọc được.

---

## 6. Ràng buộc và thứ tự

1. **Không có second writer trên cùng lease.** AWEB-12/13/14 đều đụng `features/profiles/**` ⇒ **phải tuần tự**, không song song.
2. **AWEB-15 độc lập** với phần còn lại (`features/overview/**`) ⇒ có thể chạy song song bất kỳ lúc nào, và nên chạy sớm vì là sửa hiển thị sai.
3. **AWEB-11A độc lập** (business read + displayName) ⇒ chạy sớm.
4. **AWEB-14 cần migration** ⇒ serialize với mọi thay đổi schema khác; không gộp với AWEB-11C nếu cả hai cùng chạm `migrations/`.
5. **AWEB-11C đã được chốt chạy** (§7) nhưng **vẫn phải sau AWEB-14** vì cùng chạm `migrations/` — không gộp, không song song với nhau.
6. Verifier phải **độc lập với implementer**.
7. Không tự revert hunk của lane khác. Không commit, không push, không git add.

**Thứ tự đề xuất (đã cập nhật 2026-10-10):** (1) AWEB-15 + AWEB-11A song song → (2) **AWEB-13-UI** (chỉ panel, sau khi P5 của `qwen_2` nằm xuống) → (3) AWEB-12 → (4) AWEB-14 → (5) AWEB-11C sau khi D1 chốt.

**Cảnh báo uncommitted (quan trọng nhất).** Toàn bộ tính năng API-key-trong-profile của `qwen_2` hiện **chỉ tồn tại trong working tree**, chưa commit:

| File | Trạng thái git |
|---|---|
| `migrations/0039_profile_api_keys.sql` | `??` chưa track |
| `modules/admin-read/profile-api-keys.ts` | `??` chưa track |
| `modules/admin-actions/dispatcher.ts` | `M` |
| `modules/profiles/profiles.ts` | `M` |
| `http/routes/admin.ts` | `M` |
| `app/admin/bff/profiles.ts` | `M` |
| `apps/admin-web/src/lib/api/client.ts` | `M` |
| `apps/admin-web/src/lib/api/types.ts` | `M` |
| `apps/admin-web/src/app-shell/app-shell.tsx` | `M` |

Nếu có `git checkout` / `git clean` / `git reset --hard` trên nhánh này, toàn bộ mất. **Cần yêu cầu commit hoặc backup trước khi tiếp tục bất kỳ thao tác git nào khác.** Coordinator không tự commit (ràng buộc đã có).

---

## 7. Quyết định đã chốt (người dùng xác nhận 2026-10-10)

Ba điểm mở ở bản trước nay đã đóng. Ghi lại nguyên văn quyết định và hệ quả để executor không phải suy diễn.

1. **D1 — xác thực danh tính worker: CHỐT.** Tái dùng cơ chế sẵn có, không phát minh mới: `assertRuntimeAuth` + `authorizeWorkerBusiness` (`src/http/routes/runtime.ts:359-365`) cùng map `WORKER_IDENTITY_TOKENS_BY_BUSINESS` (`main.ts:61-83`). Một worker chỉ được heartbeat cho business mà token của nó khai. Không thêm cơ chế xác thực thứ hai.
2. **D2 — workflow gắn business: CHỐT theo phương án (a).** Thêm cột `business_id` + `business_version` nullable vào `legacy_workflow_schemas`; `NULL` giữ nguyên hành vi workflow cũ. Phương án thu gộp thành `manifest.actions[]` **không** chọn.
3. **Thêm bảng `worker_instances`: CHỐT — được phép.** Không phải chờ telemetry AOPS-00/03/04. Telemetry vẫn là hướng dài hạn cho chỉ số vận hành, nhưng inventory online/offline lấy từ bảng này.

**Hệ quả cho executor:** DDL ở §4 nay là **đã duyệt về nguyên tắc**, không còn là đề xuất. Vẫn **không** tạo migration trong plan này — owner thực thi dưới lease riêng, và vẫn phải giữ tính additive (không sửa/xoá cột cũ, không backfill phá dữ liệu hiện có).

---

## 8. Xung đột owner cần người dùng chốt (2026-10-10)

Khảo sát roster sống lúc 13:24 (đọc bằng `coordination/probe-agents.py` + `orca` v1.4.219; **không** dùng `agent-watch-state.json` vì file đó cũ 5 ngày, mọi entry `settled`):

| Handle | Terminal | Trạng thái |
|---|---|---|
| `qwen_2` | `term_4bca69af-a9d5-40f4-8dac-2edb1853dbac` | Connected, IDLE_DONE, đứng ở prompt chờ lệnh |
| `reviewer` | `term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8` | Chính là phiên coordinator này — không phải owner khác |

11 vai trò còn lại (`coordinator`, `qwen_1`, `qwen_5`, `antigravity`, `codex_arch`, `codex_worker_1`, `oc_1..4`, `deepseek`) đều OFFLINE — không có handle trong live terminal list.

### 8.1 `qwen_2` đã giữ sẵn plan trùng AWEB-13 — và đã làm xong phần lõi

Màn hình `qwen_2` lúc 13:24 cho thấy plan về **đưa API key vào trong profile** đang chờ bắt đầu. **Kiểm chứng lúc 19:35 cho thấy P0-P3 đã xong** — `coordination/DISPATCH-LIVE-2026-10-10.md:23` ghi rõ *RUNNING (P5 UI)*, 8 suites / 148 tests pass ×3, tsc pass. Đối chiếu trực tiếp trên cây:

| Hạng mục | Thực tế |
|---|---|
| Bảng membership | **Đã có** — `migrations/0039_profile_api_keys.sql` |
| `apikey.attach` | **Đã có** — `dispatcher.ts:821-880` |
| `apikey.rotate` (cấp key mới + revoke key cũ, chung tx) | **Đã có** — `dispatcher.ts:954` |
| Read key set của profile | **Đã có** — `admin-read/profile-api-keys.ts` |
| Route `GET /admin/profiles/:b/:v/:n/api-keys` | **Đã có** — `http/routes/admin.ts:631-673` |
| BFF route `api-keys` + `attach|rotate` | **Đã có** — `bff/profiles.ts:47,62,67,342` |
| Client methods | **Đã có** — `lib/api/client.ts:380-393` |
| Bỏ nav `/api-keys` | **Đã làm** — `app-shell.tsx:16-17` |
| **UI panel** | **CÒN THIẾU** — `grep` `listProfileApiKeys`/`profileKeyAction` trong `src/features/` = **0 nơi dùng**. File `profile-keys.ts` mà `qwen_2` ghi lúc 19:2x **không tồn tại trên đĩa**. |

⇒ **AWEB-13 không còn là việc tạo API key trong profile** — việc đó xong rồi. Không giao owner khác (vi phạm *avoid a second writer on a live lease*, `COORDINATOR-CONTRACT.md:36`).

### 8.2 Hệ quả lan toả lên cả §3 và §6

`qwen_2` đang giữ `features/profiles/**` + `modules/admin-actions/**` + `bff/profiles.ts`. AWEB-12 (màn profile dạng bảng) **vẫn còn đúng** nhưng phải sau P5. AWEB-14 (workflow ↔ business) cần `migrations/` và **không tranh lease UI lúc này** — có thể giao cùng `qwen_2` nhưng phải serialize sau P5 vì cùng repo đang dirty.

### 8.3 Câu hỏi đã hỏi và câu trả lời (người dùng đồng ý 2026-10-10)

Hai câu ở bản trước:

1. **Hợp nhất hay chia lại?** → **Đóng AWEB-13**, không hợp nhất. Chỉ giao `qwen_2` phần panel UI còn thiếu (dùng client đã có sẵn).
2. **P4 có được chấp nhận không?** → **Không cần bàn nữa — P4 đã bị vô hiệu hoá bởi chính `0039`.** Migration đó đã giải quyết đúng vấn đề P4 muốn giải (một profile ↔ nhiều key) theo cách additive, đồng thời giữ `profile_bindings.api_key_id` làm sự thật kiểm toán. Xem D3 mới ở §2.

### 8.4 Việc còn lại đã chốt

| Hạng mục | Owner | Ghi chú |
|---|---|---|
| **AWEB-13-UI** | `qwen_2` | Chỉ panel hiển thị + nút issue/rotate/attach trong profile screen. Backend đã xong. Ưu tiên cao nhất vì đây là thứ làm cho P0-P3 trở nên nhìn thấy được. |
| **AWEB-14** | `qwen_2` | Serialize **sau** AWEB-13-UI. Cần `migrations/` cho `legacy_workflow_schemas`. |
| **AWEB-12** | chưa giao | Phải sau AWEB-13-UI (cùng lease). |
| **AWEB-15** | độc lập | `features/overview/**`, không tranh. Chạy được ngay. |
| **AWEB-11A** | độc lập | `features/businesses/**` + `admin-read/business-list.ts`, không tranh. Chạy được ngay. |

**Rủi ro lớn nhất hiện tại: toàn bộ công việc của `qwen_2` chưa commit** (xem bảng ở §6). Cần commit hoặc backup trước mọi thao tác git khác.
