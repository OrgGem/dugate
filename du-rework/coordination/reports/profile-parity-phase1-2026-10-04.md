# Phase 1 — Profiles Tab Parity: T-DB-01 + T-DB-02 + T-PROF-01 + T-DOC-01

**Task:** T-DB-01, T-DB-02, T-PROF-01, T-DOC-01 (plan `typed-discovering-wall.md` PHẦN 5, Phase 1)
**Lane:** single-writer lease = `services/orchestrator/migrations/` + `packages/contracts/` + `docs/21-openapi.json`
**Date:** 2026-10-04
**Status:** DONE — 4/4 task hoàn thành, cả 2 gate `tsc --noEmit` exit 0, 27/27 contract test pass, migration đã chạy thật trên PG :5433 (throwaway schema). **1 BLOCKER cần coordinator quyết** (mục 6). Không tick row, không commit.

---

## 1. FILE ĐỔI (đúng phạvi lease)

| File | Kích thước | Ghi chú |
|---|---|---|
| `services/orchestrator/migrations/0026_profile_policy.sql` | 179 dòng | MỚI — T-DB-01 |
| `services/orchestrator/migrations/0027_profile_active_pointer.sql` | 80 dòng | MỚI — T-DB-02 |
| `packages/contracts/src/profile-policy.ts` | 506 dòng | MỚI — T-PROF-01 |
| `packages/contracts/tests/profile-policy.test.ts` | 279 dòng | MỚI — 27 case |
| `packages/contracts/src/index.ts` | +1 dòng | `export * from './profile-policy';` (diff đúng 1 dòng, đã verify bằng `git diff`) |
| `docs/21-openapi.json` | 2158 → 2667 dòng | T-DOC-01 |

**Không chạm:** `services/connector`, `packages/connector-client`, `packages/document-kit`, `businesses/document-core`, `services/orchestrator/src/**` (ngoài migrations), `coordination/INDEX.md` (append-only, coordinator giữ).
**Không stage/commit** thay đổi lane khác. Lưu ý: `migrations/0025_artifact_manifest_version.sql` đang untracked và **không phải của lane này** — không đụng vào.

---

## 2. GATE — LỆNH LITERAL + EXIT CODE

```
# contracts
cd du-rework/packages/contracts && npx tsc --noEmit -p tsconfig.json
→ CONTRACTS_TSC_EXIT=0

# orchestrator
cd du-rework/services/orchestrator && npx tsc --noEmit -p tsconfig.json
→ ORCH_TSC_EXIT=0

# contract tests
cd du-rework/packages/contracts && npx jest --runInBand tests/profile-policy.test.ts
→ Test Suites: 1 passed, 1 total
→ Tests:       27 passed, 27 total
→ JEST_EXIT=0

# orchestrator regression (các suite liên quan đang có)
cd du-rework/services/orchestrator && npx jest --runInBand tests/admin-error-boundary.test.ts tests/admin-profile-render.test.ts tests/aweb04-bff-profiles.test.ts --forceExit
→ Test Suites: 1 skipped, 2 passed, 2 of 3 total
→ Tests:       1 skipped, 34 passed, 35 total

# openapi cú pháp + $ref
node -e "JSON.parse(require('fs').readFileSync('docs/21-openapi.json','utf8'))"
→ JSON_OK version=1.3.0 · unresolved $refs: 0 · schemas total=26 · paths=45 · x-absent entries=10

# secret scan trên 5 file mới/sửa
grep -rn "ghp_\|github_pat_\|VAULT_TOKEN\|BEGIN PRIVATE KEY" <5 file>
→ SECRET_SCAN_EXIT=1 (không match = sạch)
```

**Pre-existing failure, không phải của lane này (đã chứng minh):** `packages/contracts/tests/vault-policies.test.ts` — 2 case fail (`worker/browser can never even log in`, `renewal extends the session; expired tokens die and cannot be revived`). Bằng chứng: backup `src/index.ts` → `git checkout -- src/index.ts` → chạy lại suite đó → vẫn `Tests: 2 failed, 60 passed, 62 total` y hệt → restore `index.ts` → `git diff --stat` vẫn chỉ 1 dòng thêm. Full contracts suite: `Test Suites: 1 failed, 23 passed, 24 total / Tests: 2 failed, 489 passed, 491 total`.

---

## 3. T-DB-01 — `0026_profile_policy.sql`

### 3.1 Quyết định "chọn 1, ghi lý do"

**Chọn: mở rộng `profile_bindings` tại chỗ.** Loại: bảng con `profile_endpoint_policy` FK về `(profile_id, revision)`.

Lý do: một row `profile_bindings` **đã là** tuple `(api_key, business@version, action)` tại một revision — đúng thứ mà policy mô tả. Bảng con buộc thêm 1 join trên đường nóng submit (`submission.ts:214`, PAR-XA-03) và tạo ambiguity "revision của binding vs revision của policy". Một cột `policy` trên binding row giữ 1 row = 1 quyết định tại 1 thời điểm.

### 3.2 Cột thêm vào `profile_bindings`

| Cột | Kiểu | Default | Ghi chú |
|---|---|---|---|
| `enabled` | boolean NOT NULL | `true` | legacy default true |
| `parameters` | jsonb NOT NULL | `'{}'::jsonb` | `{key: {value, isLocked}}` |
| `job_priority` | text NOT NULL | `'MEDIUM'` | `CHECK (job_priority IN ('LOW','MEDIUM','HIGH'))` |
| `allowed_file_extensions` | text NOT NULL | `''` | CSV string, không phảa array |
| `file_url_auth_cipher` | text NULL | — | `iv_hex(24):tag_hex(32):ciphertext_hex` |
| `connections_override` | jsonb NOT NULL | `'[]'::jsonb` | `ConnectionStep[]` |

### 3.3 Bảng mới

- `connector_prompt_overrides` — key-4 `(connection_id, api_key_id, endpoint_slug, step_id)` UNIQUE, `step_id DEFAULT '_default'`, `prompt_override text` nullable, `is_active boolean DEFAULT true`, index `(api_key_id, endpoint_slug, step_id)`.
  - `connection_id uuid NOT NULL` **cố tình không FK**: du-rework chưa có bảng connections; Connector service sở hữu vòng đời connection. FK vào một bảng không tồn tại sẽ kẹt migration runner.
  - `is_active` giữ theo plan nhưng **một row tồn tại luôn nghĩa là active** — repository DELETE, không "park" row disabled (legacy DELETE khi `isActive:false`).
- `user_profile_assignments` — `(user_id, api_key_id)` PK, `granted_at`, index `(api_key_id, user_id)`. Assign theo **api key**, không phải profile (legacy `requireProfileAccess`).
- `operations.profile_policy_snapshot jsonb NULL` — chọn thay vì tái dụng `connector_bindings` (khác lifetime, khác consumer). **NULL snapshot ≠ empty policy.**

### 3.4 Không backfill

Fresh project, không có legacy data import (`docs/14-reference-compatibility.md`). R-16 xem mục 6.

---

## 4. T-DB-02 — `0027_profile_active_pointer.sql`

**Chọn: bảng con trỏ `profile_active_revisions`, 1 row per `profile_id`.** Loại: `ALTER TABLE profile_bindings ADD COLUMN is_active` + partial unique index (mẫu 0006).

Lý do: một revision của `profile_bindings` là **bất biến theo hợp đồng** — 0004 ghi "One immutable row per (profile_id, revision)", và rollback tới revision N phải trả về byte-identical. Đặt `is_active` trên row nghĩa là mỗi publish/rollback **ghi đè một row vốn là audit record bất biến**, và `moved_at` không có chỗ sống. Bảng phụ tách "nội dung của revision" và "revision nào đang live" thành 2 fact độc lập — đúng là điểm đối lập của publish-vs-append.

**FK composite, không phải single-column:** PK của `profile_bindings` là `(profile_id, revision)`, nên FK chỉ trên `profile_id` là không thể (không có unique index trên `profile_id` đơn lẻ — và tạo ra cấm sai nhiều revision cùng profile). FK trên cặp composite trỏ vào PK thật, `ON DELETE RESTRICT` để active revision không bao giờ bị orphan.

**Backfill = `MAX(revision)`** — đúng semantics `profiles.resolveBinding` hôm nay (`ORDER BY revision DESC LIMIT 1`), nên con trỏ là **no-op vào ngày nó land**. `ON CONFLICT DO NOTHING` cho phép chạy lại (không kéo ngược con trỏ operator đã move).

### 4.1 ⚠️ RỦI RO TÍCH HỢP — phase 2 PHẢI đọc

Ghi trong comment của file 0027, và lặp ở đây vì rủi ro là thật:

1. **Mọi revision append phải trở thành active theo mặc định.** `createRevision` phải insert row `profile_bindings` VÀ (re)pin `profile_active_revisions` **trong CÙNG một transaction**. Không vậy, một profile mới sẽ **không có pointer row nào** và resolution fail closed.
2. **publish/rollback chỉ UPDATE con trỏ; không bao giờ sửa `profile_bindings`.**
3. **Pointer missing ⇔ không có revision nào cho profile đó.** Đường đọc phải phân biệt "không pointer, không revision" (404 / legacy mode) với "có pointer row" — **không được fallback vào `MAX(revision)`**, không thôi con trỏ ngừng là source of truth và rollback thành silent no-op.

Nếu phase 2 chuyển `resolveBinding` sang bảng này mà bỏ qua (1), mọi profile mới resolve tới pointer cũ hoặc vắng trong khi submission vẫn chạy đúng trên semantics MAX ở một code path khác.

---

## 5. T-PROF-01 — `packages/contracts/src/profile-policy.ts`

### 5.1 Hai quy tắc gốc (ghi trong header file)

1. **Write schema ≠ read schema.** `ProfileEndpointPolicySchema` (write, mọi field optional, có `fileUrlAuthConfig`) vs `ProfileEndpointPolicyReadSchema` (read, mọi field required, `fileUrlAuthConfigured: boolean` thay cho secret).
2. **Cipher là `iv_hex:tag_hex:ciphertext_hex`, không phải JSON envelope.** `FILE_URL_AUTH_CIPHER_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:([0-9a-f]{2})+$/`.

### 5.2 Export chính

| Export | Nội dung |
|---|---|
| `ProfileKeySchema` | `{businessId, businessVersion, profileName}` |
| `ProfileRevisionSchema` | int 0..1e9 |
| `ProfileParameterValueSchema` | strict, `value: unknown`, `isLocked: boolean().optional()` |
| `ProfileParametersSchema` | `z.record(z.string().min(1), ProfileParameterValueSchema)` |
| `ProfileJobPrioritySchema` | `z.enum(['LOW','MEDIUM','HIGH'])` |
| `PROFILE_JOB_PRIORITY_WEIGHTS` | `{LOW:1, MEDIUM:10, HIGH:20}` — đúng legacy BullMQ 20/10/1 |
| `parseAllowedFileExtensions(csv)` | split `,` → trim → bỏ rỗng. **Giữ nguyên thứ tự, case, trùng lặp** |
| `ConnectionStepSchema` | strict `{slug, stepId?, captureSession?, injectSession?}` |
| `FileUrlAuthConfigSchema` | strict, **giữ nguyên snake_case** `header_name`/`header_value`/`query_key`/`query_value` |
| `FileUrlAuthCipherSchema` | regex 3 phần hex, message tường minh |
| `ProfileEndpointPolicySchema` | WRITE, strict, mọi field optional |
| `ProfileEndpointPolicyReadSchema` | READ, strict, `fileUrlAuthConfigured` |
| `ProfileRevisionReadSchema` | strict, có `latestRevision` |
| `ProfileDetailReadSchema` | strict — xem mục 7 |
| `PromptOverrideKeySchema` | strict, uuid `connectionId`/`apiKeyId`, `stepId` default `'_default'` |
| `PromptOverrideUpsertParamsSchema` | `promptOverride` nullable, `isActive` default true |
| `PromptOverrideDeleteParamsSchema` | key alone |
| `PROMPT_OVERRIDE_PRECEDENCE` | `['code','profile','connector']` |
| `UserProfileAssignmentParamsSchema` | strict `{userId uuid, apiKeyId uuid}` |
| `ProfileUpsertParamsSchema` | key + `expectedRevision?` + `policy` (**bắt buộc**) |
| `ProfilePublishParamsSchema` | key + `expectedRevision` (**bắt buộc**) |
| `ProfileRollbackParamsSchema` | key + `targetRevision` (bắt buộc) + `expectedRevision?` |
| `PROFILE_DISPATCHER_ACTIONS` | 7 action, xem mục 7 |
| `PROFILE_PROBLEM_CODES` | 7 code |

### 5.3 Bảo toàn legacy (4 nguồn, ghi trong docblock)

- `lib/crypto.ts` — AES-256-GCM, IV 12 byte, tag 16 byte, key = SHA-256(`ENCRYPTION_KEY ?? NEXTAUTH_SECRET`), lowercase hex, read fallback plain JSON.
- `lib/endpoints/profile-resolver.ts:53-93` — DB profile default trước, client chỉ override được field **unlocked**; **locked field PRESENT (kể cả cùng value) → 400**.
- `lib/file-url-downloader.ts` — `FileUrlAuthConfig` snake_case.
- `app/api/internal/profile-endpoints/route.ts` — `VALID_PRIORITIES`, non-admin chỉ sửa `parameters`/`connectionsOverride` trên endpoint đã enabled (403 nếu không), `allowedFileExtensions` chỉ `.trim()`.

---

## 6. ⚠️ BLOCKER — R-16 nằm NGOÀI lease

**R-16** (plan dòng 181): "thêm vào T-DB-01: script đọc `ProfileEndpoint` rows cũ (parameters/connectionsOverride/priority/extensions/fileUrlAuth) → insert `profile_bindings` revision 1 + prompt-overrides từ `ExternalApiOverride` (chạy 1 lần, idempotent, receipt đính kèm)."

**Vấn đề:** script đó phải nằm trong `services/orchestrator/src/` (cần `db`, `registry`, `profiles` context) — **nằm ngoài single-writer lease** của lane này (`migrations/` + `packages/contracts/` + `docs/21-openapi.json`). Tôi không được ghi vào `src/`.

**Thêm nữa:** `docs/14-reference-compatibility.md` khẳng định rework là **fresh project, không có data migration**. Nếu đúng vậy, R-16 không có nguồn legacy để đọc và nên được **đóng là "not applicable"** thay vì treo.

**Cần coordinator quyết 1 trong 3:**
- (a) Cấp lease `services/orchestrator/src/modules/profiles/` (hoặc đường dẫn cụ thể) để tôi viết backfill script trong phase này; hoặc
- (b) Giao R-16 cho lane khác có lease `src/`; hoặc
- (c) Đóng R-16 = N/A (fresh project, không legacy data) và ghi rõ trong plan.

Tôi **không tự ý** ghi vào `src/` vì vi phạm single-writer.

---

## 7. WIRE ITEMS cho AWEB-04 UI

### 7.1 Profile detail read — `GET /api/v1/admin/profiles/{businessId}/{businessVersion}/{profileName}`

Chưa có route (x-absent). Response đóng băng theo `ProfileDetailReadSchema`:

```json
{
  "businessId": "document-core",
  "businessVersion": "1.0.0",
  "profileName": "extract",
  "revision": 3,
  "currentValues": { "model": "gemini-2.0" },
  "policy": {
    "enabled": true,
    "parameters": { "model": { "value": "gemini-2.0", "isLocked": true } },
    "jobPriority": "MEDIUM",
    "allowedFileExtensions": ".pdf",
    "fileUrlAuthConfigured": false,
    "connectionsOverride": []
  },
  "manifest": { "actions": [{ "name": "extract" }] },
  "capabilities": [{ "connectorId": "c1", "capability": "ocr" }]
}
```

`revision` là **real** từ `profile_active_revisions` (hết ACUI-M02 `revision: 0`). `currentValues` là view phẳng `{"key":"<value>"}` của `policy.parameters` cho form grid. `manifest`/`capabilities` giữ đúng tên field mà `ProfileManifestWireRow` trong `src/app/admin/profile-section-data.ts` đã đọc — backend thật **không ép** client sửa lần 2.

### 7.2 Dispatcher — `POST /api/v1/admin/actions`

Route **đã tồn tại** (`src/http/routes/admin.ts:305` → `modules/admin-actions/dispatcher.ts`) nhưng **chưa từng được document** trong `21-openapi.json`. Đã thêm path entry với `x-dispatched-actions` (13 action có thật) và `x-contract-actions-pending` (7 action đóng băng contract nhưng chưa có `case` trong dispatcher → hôm nay trả 404 `unsupported`).

Body: `{action, params, idempotencyKey?}`. Non-POST → 405; thiếu `action` → 422 `INVALID_SCHEMA`; action lạ → 404, **không bao giờ silent no-op**.

### 7.3 Params schema — 7 action đóng băng

| Action | params | Bắt buộc |
|---|---|---|
| `profile.upsert` | `{businessId, businessVersion, profileName, expectedRevision?, policy}` | `policy` (kể cả `{}`) |
| `profile.publish` | `{businessId, businessVersion, profileName, expectedRevision}` | `expectedRevision` — CAS move |
| `profile.rollback` | `{businessId, businessVersion, profileName, targetRevision, expectedRevision?}` | `targetRevision` |
| `prompt-override.upsert` | `{connectionId, apiKeyId, endpointSlug, stepId?, promptOverride, isActive?}` | key-4 + `promptOverride` |
| `prompt-override.delete` | `{connectionId, apiKeyId, endpointSlug, stepId?}` | key-4 |
| `assignment.grant` | `{userId, apiKeyId}` | cả 2 |
| `assignment.revoke` | `{userId, apiKeyId}` | cả 2 |

`policy` (write) = `{enabled?, parameters?, jobPriority?, allowedFileExtensions?, fileUrlAuthConfig?, connectionsOverride?}` — strict, unknown key → 422.

`fileUrlAuthConfig` = `{type: 'none'|'bearer'|'header'|'query', token?, header_name?, header_value?, query_key?, query_value?}` — **write-only**, mã hóa server-side trước khi lưu (T-PROF-04), không bao giờ trả plaintext trên read.

`promptOverride.isActive = false` nghĩa là **DELETE**, không phải "park row disabled".

`assignment.*` assign theo **api key**, không phải profile. Gate: tới khi VFY-LOCAL (T-AUTH-03) xong, route scoped-user trả **503 kèm message tường minh**, không bao giờ bypass bằng platform token (R-14 / ACUI-M07).

### 7.4 Lệch giữa wire freeze của AWEB-04 receipt §1 và contract đóng băng

AWEB-04 receipt (`aweb04-profiles-slice-2026-10-04.md` §1) ghi read shape có `schemaVersion`, `endpoints: ProfileEndpointPolicy[]`, `effective`, `capabilities: string[]`, và `fileUrlAuthConfig {mode, header, secret}`. Contract đóng băng ở `ProfileDetailReadSchema` **không** có 4 field đó và giữ `fileUrlAuthConfig` snake_case theo legacy.

**Hướng đi:** contract lane là nguồn tham chiếu cho backend (plan T-API-01 chỉ định đúng tên field của `ProfileManifestWireRow`). AWEB-04 nên **bỏ** `schemaVersion`/`endpoints`/`effective` khỏi read shape, hoặc coordinator xác nhận đó là field UI-internal không đi lên wire. `fileUrlAuthConfig` giữ snake_case — đổi thành `{mode, header, secret}` sẽ vỡ chính consumer legacy đang port.

---

## 8. T-DOC-01 — `docs/21-openapi.json`

- `info.version` 1.2.0 → **1.3.0**, description ghi rõ những gì 1.3.0 thêm.
- **12 schema mới** trong `components.schemas`: `ProfileEndpointPolicyWrite`, `ProfileEndpointPolicyRead`, `ProfileDetailRead`, `ProfileUpsertParams`, `ProfilePublishParams`, `ProfileRollbackParams`, `PromptOverrideUpsertParams`, `PromptOverrideDeleteParams`, `UserProfileAssignmentParams`, `FileUrlAuthConfig`, `FileUrlAuthCipher`, `ConnectionStep`. Tổng schema 14 → 26.
- **Path mới** `POST /api/v1/admin/actions` (đã tồn tại thật, trước đây không được document) với `x-dispatched-actions` / `x-contract-actions-pending` + note "đừng build client tới khi note này được bỏ".
- **`x-absent` dọn dẹp:** bỏ entry mơ hồ `admin /api/internal/v1 base + profiles/api-keys/connectors-CRUD/usage/replay`, thay bằng 3 entry tường minh (profile detail read T-API-01, `POST /api/v1/admin/profile-test-endpoint` T-UI-06, 7 dispatcher action pending). 7 → 10 entry.
- Validate: JSON parse OK, **0 unresolved `$ref`**, 45 paths.

---

## 9. CÒN LẠI CHO PHASE 2/3 (không phải lane này)

- `services/orchestrator/tests/profile-policy.test.ts` và `tests/prompt-override.test.ts` (plan PHẦN 6 verify) **chưa tồn tại** — chúng là test của backend T-PROF-02/04/05, thuộc Phase 2. Phase 1 chỉ có test ở `packages/contracts/tests/`.
- `0025_artifact_manifest_version.sql` đang untracked, không phải lane này.
- `docs/21-openapi.json` còn nhiều summary trỏ `server.ts:NNNN` trong khi route thật nằm ở `src/http/routes/admin.ts` — stale sẵn có, không sửa trong phase này.
