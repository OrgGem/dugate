# P730-CONT-PREP — DRAFT schema continuity (input cho CONT-01)

**Packet:** `coordination/dispatch-specs/2026-10-04-1845-P730-CONT-PREP.md` · **Lane:** cc_2 (`term_ee7e9f33-e20d-483d-8423-830f2924d90c`) · **Run:** `run_069ecd6957cd` (dispatch `ctx_4f4c89427d35`, task `task_84dfce20ecff`).
**Date:** 2026-10-04 (+07). **Mode:** READ-ONLY ngoài receipt này; offline; không commit/push; không tick gate.
**Trạng thái:** **DRAFT — chưa freeze.** Input cho **CONT-01**; mọi quyết định mapping cần **COMP-00 + PAR-00 ký** trước (mục 3). Không phải implementation, không migration, không export/import production, không chạm shared fixture/DB, **không mở lại R-16** (đã đóng N/A theo decision 15:12).
**Write set thực tế:** chỉ file này. Fixture synthetic **không được cấp lease** trong packet này → không viết (ghi nhận ở mục 5).
**Nguồn:** `plan-review-730-2026-10-04.md` §4 (row P730-CONT-PREP); đọc source trực tiếp (mục 1) + các receipt đã dẫn.

---

## 0. TL;DR

- DRAFT map 8 nhóm bề mặt continuity: **17 settings keys**, **Profile policy**, **Connector**, **workflow schema**, **user grants**, **API-key hash**, **storage generations**, **operation ownership** (poll/cursor/download/resume/HITL/UNKNOWN, webhook, billing).
- Điểm neo kỹ thuật quan trọng nhất: **API-key hash hai bên đều là sha256-hex của raw string** (`lib` legacy dùng `crypto.createHash('sha256')`; rework `api-key-auth.ts:24-26`) ⇒ chỉ cần migrate **hash verbatim**, raw key cũ tiếp tục auth được, **không cần đọc/ghi lại raw key**.
- Open decisions tập trung: key shape/prefix/status/tenant mapping; legacy users identity (không import credential); operation ownership strategy (drain/coexist vs state migration) + cursor dialect; storage generation của artifact cũ; webhook/billing continuity; `api_secret_key` retire + 2 store-only keys; profile `fileUrlAuthConfig` legacy plaintext fallback re-seal.

---

## 1. Phương pháp + bằng chứng đã đọc (literal)

| Nguồn | Lấy được gì |
|---|---|
| `app/api/settings/route.ts` | Allowlist **17 key** (:54-72); mask 5 secret khi GET (:25-38); reset storage backend khi nhóm `s3_*` đổi (:87-91) |
| `lib/settings.ts` | `SETTING_DEFAULTS` (:88-98) — gồm 2 key **store-only** ngoài allowlist; `ENCRYPTED_KEYS` 5 key (:111); encrypt/decrypt tại `getSetting` :115 / `setSetting` :149 / `setSettings` :157 |
| `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` §3 | Mapping đầy đủ 17 key → replacement/scope/secret source (CFGADM) |
| `coordination/reports/par00-cutover-register-draft-2026-10-03.md:19` (PAR-15) | Mapping đề xuất + Q5 sign-off; nguyên tắc retire `api_secret_key` |
| `du-rework/.../migrations/0026_profile_policy.sql` | Cột policy trên `profile_bindings`; `operations.profile_policy_snapshot`; `connector_prompt_overrides`; `user_profile_assignments`; lý do JSONB/cipher/no-FK |
| `du-rework/.../migrations/0027_profile_active_pointer.sql` | `profile_active_revisions` pointer + 3 invariant bắt buộc; backfill MAX(revision) |
| `app/api/internal/profile-endpoints/route.ts` + `ext-overrides/route.ts` + `lib/endpoints/profile-resolver.ts` (đã dẫn trong profile-parity-analysis) | Semantics legacy: lock `400 khi present`; `isActive:false` = delete; key-4 unique |
| `app/api/internal/ext-connections/route.ts` (+ `[id]/route.ts`, `[id]/test/route.ts` per CFGADM §2) | Field list đầy đủ của `external_api_connections`; mask `authSecret`; slug unique 409; POST tạo kèm Processor |
| `du-rework/services/connector/src/db/migrations/001_connector.sql` + `006..008` | `connector_revisions(connector_id, revision, adapter, config, credential_ref, state)`; `secret_versions`; PK đổi thành `(connector_id, tenant_id, revision)`; `credential_source` Vault-only cho tenant-bound; chain guard 1 ACTIVE |
| `lib/workflow-builder/loader.ts:3,10` + `app/api/internal/workflow-schemas/route.ts` | Storage key `wb_schema:<slug>` trong `appSettings`; API GET/save(JSON/XML+validate)/DELETE |
| `app/api/internal/apikeys/route.ts` | `dg_` + 32B base64url; `sha256 hex`; prefix `'dg_'`; status `active`; rotate giữ id; DELETE guard `Global Profile` theo tên |
| `du-rework/.../http/routes/api-key-auth.ts:24-26` + review-plan-adjust §G4 (`shell-server.ts:375`, `dispatcher.ts:563-566`) | Rework `sha256 hex`; BFF sinh `du_…`; dispatcher lưu hash + prefix 4 ký tự |
| `app/api/internal/user-profiles/route.ts` | Assignment `(userId, apiKeyId[])` replace trong transaction; GET theo userId |
| `du-rework/.../migrations/0025_artifact_manifest_version.sql` + grep `manifest_version_id` | `artifacts.manifest_version_id` (NULL = đọc legacy key-only); `ARTIFACT_STORAGE_MIGRATION_WINDOW` (`main.ts:117`, `storage-migration-cli.ts:34`) |
| `lib/pipelines/format.ts` + `app/api/v1/operations/route.ts` | Operation wire shape legacy: `name=operations/{id}`, metadata, result/download_url, `next_page_token` = **id operation cuối**, `page_token` lookup theo id |
| `app/api/v1/billing/{balance,usage}/route.ts` | Balance = `spendingLimit - totalUsed` theo api key; usage aggregate theo `SUCCEEDED` ops / date range / model |
| `lib/storage/types.ts` (+ `dedup.ts`, `local-backend.ts`, `s3-backend.ts`) | Backend trừu tượng `upload→{bytesWritten, md5, s3Key}`; dedup theo md5 (→ LPG-01) |

---

## 2. Map bề mặt continuity (export/import · bất biến · ghi chú legacy)

### 2.1) 17 config keys (admin settings) — nguồn: CFGADM §3 + `app/api/settings/route.ts:54-72`

Danh sách đúng 17 key (allowlist): `ai_provider, ai_api_key, ai_model, ai_image_prompt, ai_pdf_prompt, ai_docx_prompt, ai_compare_prompt, ai_generate_prompt, openai_api_key, openai_base_url, api_secret_key, s3_endpoint, s3_bucket, s3_access_key, s3_secret_key, s3_region, s3_cache_ttl_hours`. Mask 5 secret: `ai_api_key, openai_api_key, api_secret_key, s3_access_key, s3_secret_key`.

| Key | Replacement (CFGADM — logical ID đề xuất) | Export/import cần | Bất biến | Ghi chú legacy |
|---|---|---|---|---|
| `ai_provider` / `ai_model` | `aiDefaults.provider` / `.model` | Giá trị + revision | Revision identity khi publish | Defaults `gemini` / `gemini-1.5-flash` (`lib/settings.ts:89-91`) |
| `ai_api_key` / `openai_api_key` | Credential account (Vault secret-ref) | **Ref only** — không raw | Secret-ref/version bất biến theo revision | Legacy AES-GCM trong `appSettings`; rework: Vault write-only |
| 5 `*_prompt` (`image/pdf/docx/compare/generate`) | `promptDefaults.*` (versioned) | Nội dung + revision | Placeholder `{user_prompt}`/`{input_content}` giữ nguyên; precedence Code>Profile>Connector | 5 slot = 5 consumer riêng; preset EN/VI là draft |
| `openai_base_url` | Connector config revision (allowlist egress) | URL + policy | Base-path join + `/chat/completions` contract | — |
| `api_secret_key` | **Retire** (đề xuất; chưa thấy consumer ngoài settings) | — | Chặn retire nếu CONT inventory tìm thấy consumer | Store-only; cần quyết định Q5 |
| `s3_endpoint/bucket/access_key/secret_key/region` | `storageConfig.*` + **storage generation** | Config nhóm + credential ref | **Generation ID bất biến** cho artifact ref cũ; act/rollback cả nhóm | Legacy: đổi nhóm này → `resetStorageBackend()` |
| `s3_cache_ttl_hours` | `retentionPolicy.cacheTtlHours` | Numeric | TTL cache ≠ output retention | Default 168 |

Hai key **store-only ngoài 17-key API** (không user-writable qua Settings API): `docx_conversion_mode` (default `'ai'`), `docx_intermediate_format` (`'html'` | `'md'` | `'pdf'`) — `lib/settings.ts:97-98`. Grep consumer trong `lib/**` + `app/**` = **chỉ 2 dòng default** (không thấy consumer runtime) ⇒ đưa vào open decisions: map/retire (không tự quyết ở đây).

### 2.2) Profile policy (`profile_bindings` + pointer + overrides)

| Bề mặt | Export/import cần | Bất biến | Ghi chú |
|---|---|---|---|
| `profile_bindings` (policy cols: `enabled, parameters, job_priority, allowed_file_extensions, file_url_auth_cipher, connections_override`) | Revision content **verbatim** (append-only) | `(profile_id, revision)` immutable; `job_priority ∈ LOW/MEDIUM/HIGH`; `step_id DEFAULT '_default'`; cipher `iv_hex:tag_hex:ciphertext_hex` | 0026: JSONB, CHECK priority, no-FK `connection_id`; bare-slug normalized on write |
| `profile_active_revisions` (pointer) | Pointer row sau cùng | 3 invariant 0027: createRevision pin cùng transaction; publish/rollback chỉ UPDATE pointer; **pointer missing ⇔ no revision** (không fallback MAX) | Pointer = source of truth sau phase 2 |
| `connector_prompt_overrides` (key-4) | Rows + semantics | `UNIQUE(connection_id, api_key_id, endpoint_slug, step_id)`; `is_active=false` **= DELETE, không park** | `connection_id` uuid-only (no FK — Connector sở hữu vòng đời) |
| `operations.profile_policy_snapshot` | Không export (per-operation history) | **NULL ≠ empty policy** (legacy mode khác "policy rỗng") | Snapshot non-secret + ref `(tenantId, profileId, profileRevision)` |
| `fileUrlAuthConfig` legacy | Re-seal khi import | Format cipher giữ nguyên; legacy **plaintext fallback tồn tại** → chỉ nhận trong cửa sổ migration có chủ, fail-closed mặc định | Quyết định re-seal policy (ENC owner) |

Identity continuity: `profile_id` là uuid rework — legacy `(apiKeyId, endpointSlug)` là key tự nhiên; CONT-01 phải định nghĩa mapping ID stable (bảng mapping tạm hoặc deterministic derivation) — **open decision**.

### 2.3) Connector

| Bề mặt | Legacy (`external_api_connections`) | Rework (`connector_revisions`, `services/connector`) | Cần export/import + bất biến |
|---|---|---|---|
| Định danh | `slug` unique (409 khi trùng) | `connector_id` + `revision`; PK `(connector_id, tenant_id, revision)` (008) | Mapping slug ↔ connector_id; revision chain giữ 1 ACTIVE (chain guard 006/008) |
| Cấu hình | `endpointUrl, httpMethod, authType, authKeyHeader, promptFieldName, fileFieldName, defaultPrompt, staticFormFields, extraHeaders, responseContentPath, sessionIdResponsePath, sessionIdFieldName, timeoutSec` | `config JSONB` + `adapter` | Field-level mapping; `authType NONE/API_KEY_HEADER/Bearer` → adapter contract; secret **không bao giờ** trong `config` |
| Credential | `authSecret` (mask `••••`; PUT giữ secret khi gửi lại mask) | `credential_ref` + `secret_versions(encrypted_value, rotated_at, revoked_at)`; tenant-bound ⇒ Vault-only (`credential_source`) | authSecret → Vault secret-ref qua kênh được cấp quyền; ref bất biến theo revision; rotate/revoke semantics |

### 2.4) Workflow schema

- Legacy: `wb_schema:<slug>` trong `appSettings` (`loader.ts:10`); API save = JSON `schema` **hoặc** `xml` (convert + validate trước khi lưu) + DELETE; node overrides ở route riêng.
- Rework: **catalog chưa tồn tại** (P9-04 decision-gated; PAR-16b planned; COMP-09 `schemaSlug` mapping tới registered business schema).
- Export/import unit: schema payload (JSON) theo slug; bất biến: **schemaSlug** + revision khi publish (contract chưa freeze). Van: XML import cần guard XXE/DTD/size (CFGADM §4.7).

### 2.5) User grants

- Legacy: `user_profile_assignments(userId, apiKeyId)`; replace all-or-nothing trong transaction (`user-profiles/route.ts`); user verify tồn tại; ADMIN/USER/VIEWER qua `requireProfileAccess`.
- Rework: `user_profile_assignments(user_id → admin_local_users, api_key_id → api_keys)` PK `(user_id, api_key_id)`, **RESTRICT cả hai FK** (0026); `admin_local_users` (0023).
- **Không import credential legacy** (LOCAL-R01 — `ADMIN-LOCAL-AUTH-2026-09-30.md:9`): legacy user identity không mang hash/password sang. Cần quyết định: tạo identity mới + map assignment theo **tên/role** hay không migrate user (chỉ giữ key-level grants). Assignment shuttle: `apiKeyId` references rework `api_keys.id` sau migrate.

### 2.6) API-key hash (điểm neo quan trọng)

| Mặt | Legacy (`app/api/internal/apikeys/route.ts`) | Rework (`api-key-auth.ts:24-26`; dispatcher) | Invariant |
|---|---|---|---|
| Raw | `dg_` + 32B base64url (server-generate; trả **1 lần**) | BFF `du_…` (caller-supplied raw ở dispatcher — Q-M01a) | **Raw không cần cho continuity** |
| Hash | `sha256(raw).digest('hex')` | `sha256(raw).digest('hex')` — **cùng hàm** | Migrate `keyHash` **verbatim** ⇒ raw key cũ auth được không cần đọc lại raw |
| Khác | `prefix='dg_'`, status `'active'`, id uuid, `spendingLimit/totalUsed`; rotate thay hash giữ id; delete guard `Global Profile` | `prefix` (4 ký tự), status `ACTIVE/REVOKED`, `tenant_id` bắt buộc; rotate **chưa có** (G1 review-plan-adjust) | Quyết định: giữ prefix `dg_` hay đổi `du_`; status map; tenant gán mặc định; rotate/disable phải có trước cutover (Q3) |

### 2.7) Storage generations

| Mặt | Legacy | Rework | Cần bất biến |
|---|---|---|---|
| Backend | `StorageBackend` trừu tượng (`lib/storage/types.ts`): `upload→{bytesWritten, md5, s3Key}`; local FS hoặc S3 theo settings; dedup md5 (`dedup.ts` → LPG-01) | S3 riêng (`du-artifacts*`), mã hóa; migration window cờ `ARTIFACT_STORAGE_MIGRATION_WINDOW` (`main.ts:117`), CLI `storage-migration-cli.ts` | **Artifact ref giữ generation** (bucket/endpoint/version/manifest) |
| Version pin | — | `artifacts.storage_version_id` (RFX-05) + `manifest_version_id` (0025; **NULL = đọc legacy key-only**) | Old download/HITL/retry phải đọc đúng generation gốc; chuyển bucket không làm đọc nhầm backend mới (CFGADM §3) |
| Byte migration | DATA-05 (PG blob → S3) | `storage-migration.ts` + reconciliation | Quyết định: serve tại chỗ (old system) hay migrate byte trước cutover; plaintext window không mặc định mở |

### 2.8) Operation ownership (poll IDs/cursor/download/resume/HITL/UNKNOWN, webhook, billing)

Wire legacy (từ `format.ts` + list route):
- `name = operations/{id}`; `done`; `metadata{state, pipeline[], current_step, progress_percent, progress_message, create_time, update_time, pipeline_steps[]}`; `result{output_format, content, extracted_data, pipeline_steps, usage{…}, download_url=/api/v1/operations/{id}/download}`; `error{code,message,failed_step}`.
- List: `{operations[], next_page_token}` — token = **id của item cuối**; `page_token` = lookup theo operation id rồi `created_at <` (op-id cursor); states list `RUNNING/SUCCEEDED/FAILED/PENDING` + schema có `CANCELLED`, `WAITING_USER_INPUT` (HITL).
- Resume: `POST /api/v1/operations/{id}/resume`; cancel: `…/cancel`; webhook: `operations.webhookUrl/webhookSentAt` (+ wire contract receipt); idempotency: `operations.idempotencyKey`; billing: balance/usage theo api key.

Rework (gap đã characterize): operation view `progress.percent=0` placeholder + `runtime.reportProgress` không persist (COMP-05a); list/detail projection (COMP-06, facade); cancel/resume/download (COMP-07); webhook delivery encryption + bounded dispatch (FIX-CR-01/02 + RFX); billing projection COMP-08; `connector_invocations.state` có **UNKNOWN** (001_connector.sql) — durable replay không redispatch cancelled/in-flight; UNKNOWN preserved (P3 review-fixes).

| Quyết định CONT-03 | Options | Bất biến bắt buộc |
|---|---|---|
| Route ownership cho operation cũ | (a) **drain/coexist** — hệ cũ tiếp tục sở hữu polling/download/resume của op cũ, rework chỉ op mới; (b) **state/checkpoint migration** có contract chứng minh | IDs/cursor/URLs client đang dùng; idempotency replay xuyên thời điểm chuyển; callback/usage **không double**; không route 2 chiều ngẫu nhiên |

---

## 3. Open decisions cần COMP-00 / PAR-00 ký trước freeze (không tự quyết)

**Từ COMP-00/01 (đã nêu trong register/recon, nhắc lại đúng phạm vi CONT):**
1. **Key shape/prefix** — giữ `dg_` server-generate (legacy) hay `du_` caller-supplied (rework); prefix lưu bao nhiêu ký tự. (Register Q2; review-plan-adjust §G4)
2. **Rotate/enable/disable + HTML/BFF** — legacy rotate giữ id + delete-guard `Global Profile` có bắt buộc tại cutover không. (Q3)
3. **Cursor dialect `next_page_token`** — op-id (legacy) vs 4-slot cursor; set-vs-exact filter — ảnh hưởng trực tiếp ownership client. (Register Q8; COMP-00)
4. **Locked-field status** legacy `400 Forbidden Field` vs canonical `403` — chốt per-surface trước COMP-02 freeze. (Q11)
5. **No-binding fallback window** — managed key bypass policy trong cửa sổ migration? (Q12)
6. **Upstream prerequisite mapping** — PAR-01/02/03/04 (+LOCAL-04) ghi vào COMP-10/11 + P8-08. (Q10)

**Từ PAR-00 (register Q1..Q12) liên quan continuity:** Q1 classification required/post-cutover/retire (đặc biệt `PAR-16a` assignment, `PAR-17` non-parity); Q4 PAR-14 scope (egress allowlist, test redaction); Q5 mapping 17 key (đặc biệt `api_secret_key` retire, `s3_*` deployment); Q7 retire sign-off; Q9 LOCAL-00 mode/auth (quyết định mode ảnh hưởng user continuity).

**Mới, riêng CONT (đề xuất cần ký trước CONT-01 freeze):**
7. **API-key continuity** — migrate hash verbatim + mapping `status/prefix/tenant`; xác nhận "không cần raw key".
8. **Legacy users identity** — không import credential (LOCAL-R01); chọn: tạo identity mới + map assignment theo tên, hay chỉ migrate key-level grants (bỏ user-scope) — kèm last-admin/self-lockout guard.
9. **Operation ownership strategy** — chọn (a) drain/coexist hay (b) state migration (CONT-03); kèm định nghĩa "client identity" bảo toàn (key, op ids, cursor, download URL).
10. **Storage generation semantics** — artifact cũ đọc bởi hệ cũ hay migrate byte (DATA-05); format manifest/key version; xử lý bucket deviation đã ghi trong liv11 §2.
11. **Webhook continuity** — trạng thái delivered/in-flight chuyển tiếp; callback chống double sau cutover; dùng chung wire contract receipt.
12. **Billing continuity** — map `spendingLimit/totalUsed` legacy → cost model rework (COMP-08 + COST-04 402 problem-json type).
13. **`fileUrlAuthConfig` legacy plaintext** — re-seal policy + cửa sổ migration fail-closed; cùng quyết định ENC-META.
14. **`api_secret_key` + 2 store-only keys (`docx_*`)** — retire (đề xuất CM: chỉ 2 default usage, không consumer) hay map; cần xác nhận không consumer ngoài repo.
15. **Secret re-encrypt channel** — kênh được cấp quyền cho secret profile/connector khi import (không log; đúng CONT-01 acceptance "re-encrypt hoặc chuyển reference").

## 4. Câu hỏi sign-off (checklist ngắn cho Product/architect)

- [ ] Chốt Q1 (classification) + Q5 (17-key mapping) + Q7 (retire list) — khối điều kiện để CONT-00 register duyệt.
- [ ] Chốt key shape/prefix/rotate (items 1–2) vì nó quyết định "client identity continuity".
- [ ] Chốt cursor dialect + operation ownership (items 3, 9) trước khi thiết kế CONT-02/03.
- [ ] Chốt storage generation + byte migration (item 10) cùng DATA/ENC owner.
- [ ] Chốt users identity + billing/webhook continuity (items 8, 11, 12).
- [ ] Xác nhận `api_secret_key`/`docx_*` không có consumer ngoài repo (item 14) — nếu có, phải bổ sung replacement trước sign-off.

## 5. Limitations (không thay thế CONT-01 freeze)

1. **DRAFT, chưa freeze** — mọi tên replacement/ID logical là đề xuất; service owner freeze DTO/schema/path trước code (CFGADM §3).
2. **Không chạy migration/export/import production; không chạm DB/shared fixture; không mở lại R-16 N/A.**
3. **Fixture synthetic không viết** — packet chỉ cấp write set là receipt này ("và input fixtures synthetic riêng **nếu cấp**" — chưa cấp). Nếu coordinator mở lease fixtures, bổ sung sau.
4. Một số bề mặt (webhook wire chi tiết, cursor 4-slot, `createdByUserId` semantics) đối chiếu qua receipt characterize (`codex-webhook-wire-contract`, `codex-billing-spending-wire-contract`, `codex-comp01-slice-d/g`) — cần re-anchor `file:line` tại thời điểm freeze vì working tree di chuyển.
5. Line-ref trong receipt này đọc tại thời điểm inventory (working tree dirty; nhiều lane đang sửa) — re-read trước khi freeze.
6. CONT-01 acceptance gốc (PLAN-COMPLETION §5) yêu cầu thêm: manifest digests, integrity validation, incompatible hash/provider/identity migration path — các mục đó **chưa** được thiết kế ở draft này (đúng phạm vi).

## 6. Ledger

- 1 — Đọc 5 spec/plan-review + 14 file source/config/schema (mục 1) — trích xuất bằng chứng literal.
- 2 — Map 8 nhóm bề mặt (17 keys / profile / connector / schema / grants / key-hash / storage / operations) — §2.
- 3 — Liệt kê open decisions COMP-00/PAR-00 + CONT-specific + checklist sign-off — §3/§4.
- 4 — Limitations + xác nhận boundary — §5/§6.
- Boundary: file duy nhất được ghi = receipt này; không tick; không commit/push; không chạm `nocobase-10`.

*Draft doc này KHÔNG phải CONT-01 freeze và không chứng minh bất kỳ gate nào.*
