# PREP-PC-08 — Admin Workbench and Operations UI pre-analysis & design (READ-ONLY)

| Field | Value |
| :--- | :--- |
| Packet | `PREP-PC-08` — *Admin Workbench and Operations UI Pre-Analysis & Design* |
| Dispatch | [`du-rework/coordination/dispatch-specs/PC-08-prep-dispatch.txt`](../dispatch-specs/PC-08-prep-dispatch.txt) |
| Master plan | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) — PC-08 row, "Admin Workbench and operations UI"; §"DTO and route contract"; acceptance matrix |
| Worker | DeepSeek Worker 0 (Frontend & Admin Workbench Specialist) — `deepseek-v4.1-flash` |
| Mode | **READ-ONLY.** No production source edited; no DB/Redis used; no test executed. Only this report was written. |
| Output | This report only. |
| Verdict | **Not implementable as-is; UI surface absent, backend ready.** The entire V2 profile-group control plane exists on the server (PC-01 contracts, PC-03 config service/routes, PC-04 key modes, PC-05 resolver + v2 preview/submit). The canonical Admin UI still speaks **v1 only**: it cannot create a zero-key group, cannot show `active_revision` next to `access_version`, has no root-grant panel, and the workbench submits without a preflight `resolutionFingerprint`. Three read-projection gaps block part of the six PC-08 outcomes: operator/group-function discovery (D-01, §9), operations resolution refs (D-02, §4.9/§9), and `key_mode` for legacy key panes (§4.10). |

**Tóm tắt (VI).** Đã audit read-only toàn bộ bề mặt PC-08: 3 BFF handler (`profile-groups.ts`, `admin-workbench.ts`, `operations.ts`), 6 màn admin-web được giao, cùng các module trực tiếp chi phối chúng (`client.ts`, `types.ts`, `upstream.ts`, `envelope.ts`, `context.ts`, `handle.ts`, cockpit/detail read models), và đối chiếu với backend V2 đã hoàn tất ở PC-01/03/04/05.

Kết luận chính:

1. **BFF chưa có route V2 nào.** `bff/profile-groups.ts` chỉ ánh xạ `/api/v1/admin/profile-groups` (list/group/rollback/functions); `bff/admin-workbench.ts` chỉ có `test-endpoint` + `prompt-wizard` (v1); `bff/operations.ts` chỉ relay danh sách/chi tiết/cancel/retry/resume/delete. Không có `profile-groups/v2`, không có `admin-workbench/v2/preview|submit`, không có `If-Match`/`ETag` passthrough.
2. **Editor hiện tại bắt buộc chọn key.** `ProfileGroupEditorDraft` có `apiKeyId` + `revision` và không có `accessVersion`/grants/`requestDefaults`; validate chặn lưu nếu không có key ACTIVE (`profile-group-state.ts:154-204`, `profile-group-editor.tsx:918-930,1132`). Trái trực tiếp yêu cầu "zero-key config CRUD" và "không UI nào tự chọn root key đầu tiên".
3. **Không có UI cấp/thu quyền root grant.** `ProfileGroupV2` có `apiKeyGrants[]`, route `…/keys` (issue) và `…/keys/:keyId/revoke` (revoke) đã sống, nhưng admin-web không có method client, không có bảng grant, không có dialog issue/revoke, không có hiển thị secret một lần.
4. **Workbench vẫn là v1.** `docs-screen.tsx` chọn Profile + key đã gán, gửi `expectedProfileRevision`, không gọi preview, không có `resolutionFingerprint`; route server `/api/internal/admin-workbench/v2/*` đã có nhưng BFF không mở.
5. **`access_version` không thể hiện ở bất kỳ đâu trong UI.** Không có read DTO nào của admin-web chứa `accessVersion`; `OperationWire` cũng không có refs/profile pins, nên "safe effective refs" ở trang Operations **không thể làm trung thực** nếu không bổ sung read projection.
6. **Legacy server-rendered UI không có section group** (không có renderer nào), nên "giữ UI cũ ở chế độ v1 read projection" hiện chỉ còn nghĩa: các màn profile/API-key cũ phải map `409 PROFILE_GROUP_V2_REQUIRED` thành thông điệp rõ ràng và **không** hiển thị affordance ghi cho group đã chuyển đổi. Hiện chúng chỉ hiện title chung "The admin API rejected the request" vì `upstreamProblem` thay title upstream (`bff/envelope.ts:58-72`).
7. **Hai khoảng trống discovery chặn yêu cầu 4 và 6:** (a) `GET /api/v1/admin/profiles` loại trừ child của group (`admin-read/profile-list.ts:70`), self-service cũng loại trừ (`profiles/self-service.ts:471`), nên sau khi chuyển đổi, operator **không còn đường đọc** các function thuộc group; (b) `operations` không lưu `groupId`/`accessVersion` tại admission, chỉ `profile_id`/`profile_revision`/`connector_bindings` và fingerprint nằm ở `submission_keys`, nên không thể dựng lại access version lịch sử.

Đề xuất thực thi: **PC-08 chỉ sửa `apps/admin-web/src/**` + 3 file BFF + test**, không đụng service/contract (trừ 2 delta nhỏ được liệt kê ở §9 nếu coordinator chấp thuận). Toàn bộ quyết định mở nằm ở §9 (D-01…D-12), trong đó **D-01 (operator discovery)** và **D-02 (operations refs projection)** cần chốt trước khi code.

---

## 0. Evidence boundary

### 0.1 Read (whole files unless noted)

| # | Path (root = `du-rework/orchestrator/`) | Lines / scope |
| :--- | :--- | :--- |
| 1 | `services/orchestrator/src/app/admin/bff/profile-groups.ts` | 292 (full) |
| 2 | `services/orchestrator/src/app/admin/bff/admin-workbench.ts` | 120 (full) |
| 3 | `services/orchestrator/src/app/admin/bff/operations.ts` | 533 (full) |
| 4 | `services/orchestrator/src/app/admin/bff/upstream.ts` | 226 (full) |
| 5 | `services/orchestrator/src/app/admin/bff/envelope.ts` | 86 (full) |
| 6 | `services/orchestrator/src/app/admin/bff/context.ts` | 130 (full) |
| 7 | `services/orchestrator/src/app/admin/bff/handle.ts` | 1-200 (dispatch order) + profile-groups/workbench/operations wiring |
| 8 | `apps/admin-web/src/features/profiles/profile-group-state.ts` | 265 (full) |
| 9 | `apps/admin-web/src/features/profiles/profile-group-editor.tsx` | 1-360, 560-700, 846-1005 (three reads) + full-file grep sweep (1 151 lines total; 1006-1151 covered by grep only) |
| 10 | `apps/admin-web/src/features/profiles/profiles-screen.tsx` | 2015-2209 (tabs + groups tab + catalog table) + grep sweep (2 867 lines total) |
| 11 | `apps/admin-web/src/features/docs/docs-screen.tsx` | 40-70, 740-1030, 1152-1266 + grep sweep (1 286 lines) |
| 12 | `apps/admin-web/src/features/operations/operations-screen.tsx` | 930-1129, 1440-1460 + grep sweep (1 468 lines) |
| 13 | `apps/admin-web/src/features/businesses/businesses-screen.tsx` | 540 (full) |
| 14 | `apps/admin-web/src/features/businesses/business-detail-cockpit.tsx` | 230-260 + grep sweep |
| 15 | `apps/admin-web/src/lib/api/client.ts` | 470-620, 1040-1090, 1225-1245, 1325-1361 + grep sweep (1 361 lines) |
| 16 | `apps/admin-web/src/lib/api/types.ts` | 560-680 + grep sweep |
| 17 | `packages/contracts/src/profile-groups.ts` | 639 (full) |
| 18 | `packages/contracts/src/admin-workbench.ts` | 132 (full) |
| 19 | `packages/contracts/src/profile-policy.ts` | 52-71 (`ProfileRevisionSchema`) |
| 20 | `services/orchestrator/src/http/routes/admin-profile-groups-v2.ts` | 424 (full) |
| 21 | `services/orchestrator/src/http/routes/internal-admin-workbench.ts` | 43 (full) |
| 22 | `services/orchestrator/src/modules/admin-workbench/service.ts` | 1-410 (full) |
| 23 | `services/orchestrator/src/modules/profiles/profile-groups.ts` | grep sweep (`access_version`, 412/409 codes, group key mint, zero-key insert, grants) |
| 24 | `services/orchestrator/src/modules/profiles/self-service.ts` | grep sweep (`group_id`, assigned reads, edit fence) |
| 25 | `services/orchestrator/src/modules/admin-read/profile-list.ts` | 111 (full) |
| 26 | `services/orchestrator/src/modules/operations/facade.ts` | 20-90 (`toOperationView`) |
| 27 | `services/orchestrator/src/modules/operations/mappers.ts` | 20-139 (`toOperationDetailWire`, `buildAdminOperationDetail`) |
| 28 | `services/orchestrator/src/modules/operations/submission.ts` | grep sweep of the `INSERT INTO operations` column list + `resolution_fingerprint` |
| 29 | `services/orchestrator/src/app/admin/*` (legacy shell) | directory inventory + grep for profile-group/`PROFILE_GROUP`/`key_mode` (zero hits) |
| 30 | `orchestrator/apps/admin-web/package.json`, `orchestrator/package.json` | scripts (no admin-web unit runner) |
| 31 | Peer reports: `prep-pc01-contracts-spec.md` (§2, §3, D9), `prep-pc04-keys-spec.md` (§2, §3.4), `prep-pc05-admission-spec.md` (Q-5, §"UI implications"), `receipt-pc03-service.md` (§2 D-1/D-3/D-7, §4 service surface), `receipt-pc05-admission.md` (§2.5, §3 deviations) | — |
| 32 | Test seams: `services/orchestrator/tests/aweb09-profile-api-keys-bff.test.ts` (1-90), `tests/aweb05-bff-reads.test.ts`, `tests/aweb06-bff-operations.test.ts`, `tests/browser/admin-web/profiles.spec.ts`, `tests/browser/tests/sections.spec.ts` | pattern only |

Grep sweeps (whole `orchestrator/`): `ProfileGroupV2`, `accessVersion`, `apiKeyGrants`, `requestDefaults`, `resolutionFingerprint`, `PROFILE_GROUP_V2_REQUIRED`, `PROFILE_CHANGED`, `PROFILE_GROUP_UNAUTHORIZED`, `key_mode`/`GROUP_MANAGED`, `/v2`, `If-Match`, `etag`, `adminWorkbench`.

### 0.2 Not done

- No source edit, no migration, no build, no `pnpm`/`npx`, no browser run, no DB/Redis access.
- Every statement below is **source-level**. Nothing here claims runtime behaviour, a built image, or a deployed container.
- Line numbers are the working tree as of this audit (PC-03/PC-04/PC-05 code already present and uncommitted in places).
- The engine of the report is the **dispatch-mandated six outcomes**, not a general UX review; adjacent defects are recorded only where they block those outcomes.

---

## 1. Requirement → current state (gap matrix)

Dispatch requirements (Vietnamese, translated verbatim in intent):

| # | Requirement | Current state (source) | Verdict |
| :--- | :--- | :--- | :--- |
| R1 | Support V2 groups **without** an API key (zero-key config CRUD) | Editor draft requires `apiKeyId` (`profile-group-state.ts:37-46`, `:157`), key selector is mandatory and save is disabled without an active key (`profile-group-editor.tsx:918-930`, `:1132`); client has only v1 create/replace (`client.ts:1236-1244`) | **ABSENT** |
| R2 | Show `active_revision` (config) **separately** from `access_version` (root grants) | No admin-web type or client method contains `accessVersion`; the editor shows only `rev {revision}` on the list item (`profile-group-editor.tsx:885`) and `draft.revision` | **ABSENT** |
| R3 | Root-grant list with **issue** and **revoke** confirmed by `expectedAccessVersion` | No grant table, no issue/revoke UI, no client method; server routes already exist (`admin-profile-groups-v2.ts:323-423`) | **ABSENT** |
| R4 | Workbench submit **must select a key** and carry the `resolutionFingerprint` from preflight/preview | Workbench selects an assigned key (`docs-screen.tsx:914-926`) but never previews; body is `AdminWorkbenchEndpointTestRequest` with `expectedProfileRevision` only (`:914-926`); BFF has no v2 suffix (`admin-workbench.ts:14-20`); server v2 preview/submit already live (`internal-admin-workbench.ts:36-41`) | **PARTIAL (key yes, fingerprint no)** |
| R5 | Legacy admin UI stays on safe v1 read projection; converted-group writes denied with `409 PROFILE_GROUP_V2_REQUIRED` | Legacy server-rendered shell has **no** group UI (no renderer/section), so it cannot offer group writes; its profile/API-key panes surface upstream 409 only as the generic title because `upstreamProblem` drops the upstream message and keeps `code` (`envelope.ts:58-72`), which the UI does not branch on | **PARTIAL (safe by absence, messaging absent)** |
| R6 | Operations detail/diagnostics expose only **supported actions** and **safe effective refs** | Actions already gated by role/state (`operations-screen.tsx:885-886`, `:964-987`); no profile/group/connector/fingerprint refs exist in `OperationWire` (`types.ts:570-584`) or `toOperationView` (`facade.ts:37-57`), and the operations row does not persist group access version (`submission.ts` INSERT column list) | **PARTIAL (actions yes, refs impossible today)** |

Master-plan PC-08 sentence adds: "Inspect business/version/functions and input/output/profile schemas; edit root grants and nested typed endpoint config." Current capability: the group editor renders `profileSchema` fields and reads the function catalog (`profile-group-editor.tsx:639-690`), but does **not** render `inputSchema`/`outputSchema`, does not edit `requestDefaults`, and the businesses screen/cockpit has no function or schema inspector (`business-detail-cockpit.tsx:240-245` tabs are versions/workers/profiles/workflow schemas).

---

## 2. Current-state inventory (what actually exists)

### 2.1 BFF `profile-groups.ts` — v1 only

| Aspect | Evidence |
| :--- | :--- |
| Route union | `list \| group \| rollback \| functions \| invalid` (`:24-29`) |
| Matcher | `/profile-groups`; `/businesses/:id/versions/:v/functions`; `/profile-groups/:uuid/rollback`; `/profile-groups/:uuid` — a non-UUID group id returns `{kind:'invalid'}` → **404**, it does not fall through to another family (`:31-56`) |
| Query discipline | exactly one `tenantId` on list (`:58-65`, `:151-159`) |
| Local USER fence | OIDC + `du-local` + operator → assignment-aware read via `profileSelfService.canReadAssignedProfileGroup`; list filtered per group, detail 404s when unassigned (`:71-93`, `:235-264`) |
| Mutation gates | local USERs denied (`403 PROFILE_GROUP_ASSIGNMENT_REQUIRED`); platform admin only (`403 PROFILE_SCOPED_GATE`); CSRF (`:180-192`) |
| Upstream | `/api/v1/admin/profile-groups[/:id[/rollback]]` (`:221-231`) |
| Transport | body parsed and re-serialized; response relayed through `relayUpstream` (drops headers, genericizes problem title) (`:269-291`) |

Consequence: there is **no door** from the browser to `/api/v2/admin/profile-groups*`. Adding one requires a new matcher matched **before** `matchProfileGroupsRoute`, because `/profile-groups/v2` currently answers `{kind:'invalid'}` → 404 and never reaches a later matcher (`handle.ts:147-150`).

### 2.2 BFF `admin-workbench.ts` — v1 suffix pair only

- Routes `POST /admin-workbench/test-endpoint|prompt-wizard` only (`:14-20`), POST-only, no query, session + CSRF, viewer/unscoped denied (`:36-56`).
- Local operator forwards an **opaque session proof** (cookie + CSRF) instead of a tenant bearer (`:57-72`); tenant mismatch is a 404 (`:106-109`).
- `Idempotency-Key` is **required** and shape-checked (`:82-86`).
- Payload is validated by `AdminWorkbenchEndpointTestRequestSchema` / `AdminWorkbenchPromptWizardRequestSchema` before relay (`:98-105`), then posted to `/api/internal/admin-workbench/...` (`:110-119`).
- The v2 internal suffixes (`/v2/preview`, `/v2/submit`) are **not** mapped here.

### 2.3 BFF `operations.ts` — supported actions, no refs

| Aspect | Evidence |
| :--- | :--- |
| Route union | list/upload/metrics/detail/deliveries/download/action(cancel\|retry\|resume)/usage*/businesses*/worker-instances (`:43-113`) |
| Action gate | POST + CSRF; `retry` requires `admin` (`:168-175`) |
| Tenant scope | `authorizeAuditTenantRead` on list/metrics/usage; session proof forwarded for OIDC planes (`:231-251`, `:525-533`) |
| Detail | GET/DELETE relayed verbatim; body is whatever the internal route returns (`:292-303`) |

The BFF does not synthesize actions, which is correct. It also forwards **no** v2 fields because none exist upstream in the detail envelope (`toOperationDetailWire`, `mappers.ts:38-44`, composes `toOperationView`, `facade.ts:37-57`).

### 2.4 Upstream plumbing constraints that shape the design

| Constraint | Evidence | Impact on PC-08 |
| :--- | :--- | :--- |
| `callUpstream` builds a **fixed** header set (accept, correlation, auth, content-type, content-length, idempotency-key, cookie/csrf) | `upstream.ts:112-151` | `If-Match` cannot reach the v2 group service; needs an additive allowlisted passthrough |
| `relayUpstream` drops **all** response headers (including `ETag`) and rewrites problems: upstream `code` kept, upstream **title/message replaced** by "The admin API rejected the request", 5xx collapsed to `502 UPSTREAM_ERROR` | `upstream.ts:163-199`, `envelope.ts:58-72` | The UI must branch on `code`, never on title; `accessVersion` must ride the JSON body (it does) |
| Field errors are sanitized must-not-leak (pointer ≤128, message ≤200, max 50) | `envelope.ts:74-86` | Conversion-proof `errors[0].message = 'P3_SHARED_KEY'` survives (`receipt-pc03-service.md` §2 D-4) |
| `writeJson` always sets `cache-control: no-store` | `upstream.ts:201-208` | The one-time key secret never enters a cacheable response; `idempotent-replay` header is **lost** on relay |
| Context exposes plane/role/tenant/issuer/sub/roleVersion/CSRF/principal | `context.ts:36-57` | Same gates reusable for the v2 family; local-user filter needs the same primitives as `:71-93` |

### 2.5 `profile-group-state.ts` — the v1 draft model

| Element | Evidence | Gap to V2 |
| :--- | :--- | :--- |
| `ProfileGroupEditorDraft` | `groupId, tenantId, name, apiKeyId, revision, members, selectedFunctionsByVersion, functionDrafts` (`:37-46`) | no `accessVersion`, no `authMode`, no `authAuthority`, no `grants`, no `requestDefaults` per function |
| Function draft | `enabled, parameters, jobPriority, allowedFileExtensions, connectorBindings, readPolicy` (`:16-24`) | no `requestDefaults` sibling; `readPolicy` carries v1 policy fields (`allowedOrigins`, `connectionsOverride`, `requestRedaction`, `callbackPolicy`) |
| Read → draft | `profileGroupDraftFromRead` requires `group.apiKey.apiKeyId` (`:121-152`) | a v2 read has no `apiKey`; this function throws/mis-types on it |
| Validate | unconditional `if (!draft.apiKeyId) errors.push('Select an existing active API key…')` (`:154-204`) | contradicts R1 |
| Save body | `apiKey: { apiKeyId }` + `expectedRevision` (`:220-260`) | v2 save forbids `apiKey` and requires `authMode` (`profile-groups.ts:341-350`) |
| Conflict | `isProfileGroupRevisionConflict(409, REVISION_CONFLICT)` (`:262-264`) | still correct for v2 config saves; grants use 412 instead |

### 2.6 `profile-group-editor.tsx` — the v1 UI

- Loads **all active keys** of the tenant to populate the mandatory key select (`:283-303`), and **all groups via v1** (`:326-354`).
- Save is disabled unless the selected key is currently ACTIVE (`:1132`); warnings for "no active key" and "selected key inactive" (`:927-928`).
- Rollback is a single numeric input with `expectedRevision` + `targetRevision` (`:790-820`, `:1136-1137`).
- Function config edits `profileSchema` properties into `policy.parameters`, plus enabled/priority/extensions/connector picks (`:639-690`).
- No grant surface, no access version, no request defaults, no preview.
- Renders inside the Profiles route's `Groups` tab, platform-only (`profiles-screen.tsx:2015-2021`, `:2162-2164`).

### 2.7 `docs-screen.tsx` — the v1 workbench

- Endpoint inventory lists only v1 suffixes (`:55-63`).
- Body: `{tenantId, apiKeyId, businessId:'document-core', businessVersion, action, profileName, expectedProfileRevision, endpointSlug, parameters, artifacts, sourceUrl?}` (`:914-926`).
- Client-side schema validation + locked-field omission + secret-like field stripping + 32 KiB cap (`:745-820`); immutable attempt + idempotency-key retention and replay (`:852-889`, `:891-940`); prompt wizard equivalent (`:942-1030`).
- UI: Profile picker → assigned active key → action → schema-driven parameter form → file upload (≤20) → confirm dialog → submit; Prompt Wizard requires a pinned `ext-prompt-wizard` revision (`:1248`).
- No preview, no fingerprint, no group context, no zero-grant state.

### 2.8 `operations-screen.tsx` — supported actions, honest unknowns

- Terminal states `SUCCEEDED/FAILED/CANCELLED/TIMED_OUT` (`:39`).
- Row actions: Stop (non-terminal), Retry (admin, FAILED/CANCELLED/TIMED_OUT, not `UNKNOWN` outcome), Delete (terminal) (`:885-886`); detail actions mirror them (`:964-987`).
- Unknown provider outcome blocks retry with an explicit warning (`:999`).
- Detail renders tenant/business/action/timings/progress/deadline/error/retryOf/correlation, then task/lease/admission-parked tables (`:1010-1129`).
- No profile/group/connector/fingerprint refs; none are available upstream.

### 2.9 `businesses-screen.tsx` + cockpit

- Registry list, lifecycle enable/disable with `expectedLifecycleRevision`, version actions and pre-drain with `expectedActivationRevision` (`:139-316`, `:439-519`).
- Cockpit tabs: versions & workers, profiles, workflow schemas (`business-detail-cockpit.tsx:240-245`) — **no function catalog / input-output-profile schema inspector**.
- The function catalog is read in two places — the group editor (`profile-group-editor.tsx:200-281`, renders only `profileSchema`) and the Profiles editor's legacy endpoint selector (`profiles-screen.tsx:978`, `:2188`, uses only `endpointSlug`) — and **neither renders the catalog's `inputSchema`/`outputSchema`**. The group config pane is therefore the right home for the schema inspector.

### 2.10 Legacy server-rendered admin shell

- Section inventory: overview, operations, profile, business, connector, API-key, audit, crypto-config (`src/app/admin/*-section-*.ts`). **No profile-group section/renderer exists.**
- Grep for `profile-group` / `PROFILE_GROUP` / `key_mode` under `src/app/admin/**` returns hits only inside `bff/` (the new same-origin JSON surface); the server-rendered shell itself has **no** group section, renderer or key-mode projection.
- So R5's "keep the old UI on the safe v1 read projection" is satisfied **structurally** (it cannot write groups), but two obligations remain: (a) converted-group children must not appear as editable rows — already true for profile lists (`profile-list.ts:70`) and assigned reads (`self-service.ts:471`); (b) any upstream `409 PROFILE_GROUP_V2_REQUIRED` must be surfaced as a typed, actionable message instead of the generic upstream title — **not** done.

---

## 3. Backend surface already available to PC-08

No service change is needed to implement R1–R4. Exact surface:

### 3.1 V2 group routes (`services/orchestrator/src/http/routes/admin-profile-groups-v2.ts`)

| Route | Authz | Transport rules | Result |
| :--- | :--- | :--- | :--- |
| `GET /api/v2/admin/profile-groups?tenantId=` | `authorizeAuditTenantRead`; platform must pass `tenantId` (`:211-225`) | 422 on unknown/repeated query | `ProfileGroupV2List` |
| `POST /api/v2/admin/profile-groups` | platform only (`:227`) | body = `ProfileGroupV2Save`; `tenantId` required (`:230`); no query | `201 ProfileGroupV2` |
| `GET /api/v2/admin/profile-groups/:id[?tenantId=]` | tenant read (`:249-261`) | zero-grant safe; header `etag: "<accessVersion>"` (`:265`) | `ProfileGroupV2` |
| `PUT /api/v2/admin/profile-groups/:id` | platform only | body `expectedRevision` CAS; `REVISION_CONFLICT` 409 | `200 ProfileGroupV2` + ETag |
| `POST /api/v2/admin/profile-groups/:id/rollback` | platform only | v1 rollback body; config pointer only, `access_version` untouched | `200 ProfileGroupV2` + ETag |
| `POST /api/v2/admin/profile-groups/:id/keys` | platform only | **`Idempotency-Key` required** (`:181-187`) + **`If-Match` required** (`:155-179`: missing ⇒ `428 PRECONDITION_REQUIRED`, malformed ⇒ `400`); stale ⇒ service `412 PRECONDITION_FAILED` (`profile-groups.ts:1761`) | `201 {grant, secret?, secretAvailable}`; `cache-control: no-store`; replay answers `secretAvailable:false` (marker stores no secret, `:355-364`) |
| `POST /api/v2/admin/profile-groups/:id/keys/:keyId/revoke` | platform only | `Idempotency-Key` required; `expectedAccessVersion` travels in the **body** (missing ⇒ `422 INVALID_SCHEMA`; stale ⇒ `412 PRECONDITION_FAILED`) | `200 {grant: tombstone, accessVersion}` |
| `GET /api/v2/admin/profile-groups/catalog?businessId=&businessVersion=` | platform only | — | `ProfileGroupFunctionCatalog` (same shape the editor already consumes) |

Notes that the UI must respect:

- `authMode` has exactly one legal value today: `'API_KEY'` (`profile-groups.ts:149-150`) — still required on every v2 save (`:345`).
- A v2 group save carries **no key**; grant state is a separate ledger (`:341-350`).
- `apiKeyGrants[]` projects **ACTIVE grants only**; tombstones never come back on read (`:394-395`). The revoke response is the only place a tombstone is visible.
- Issue input schema has `{note?}` (`:220-225`) but `ProfileGroupKeyGrantSchema` has **no note field** (`:202-212`), so a note would be write-only and unverifiable. See D-06.
- v1 list answers `409 PROFILE_GROUP_V2_REQUIRED` for any group whose singular key cannot be projected (0 or >1 ACTIVE grant) — the whole page 409s (`receipt-pc03-service.md` §2 D-3). This is why the browser must not use v1 list for the group rail.

### 3.2 Workbench v2 (internal)

| Route | Schema | Behaviour |
| :--- | :--- | :--- |
| `POST /api/internal/admin-workbench/v2/preview` | `AdminWorkbenchProfilePreviewV2Request` (`tenantId`, `apiKeyId`, `businessId`, `businessVersion`, `action`, `functionId`, optional `endpointSlug`, `submission`) | resolves the group **from the key's root grant** (never from a group parameter), returns `{refs, resolutionFingerprint, effective, apiKeyId}` (`admin-workbench/service.ts:327-352`); empty/absent grant ⇒ `403 PROFILE_GROUP_UNAUTHORIZED` (`:285-300`) |
| `POST /api/internal/admin-workbench/v2/submit` | same + `resolutionFingerprint`, `Idempotency-Key` header | re-resolves, fence-checks the local USER against key **and** child profile, then submits; stale fingerprint ⇒ `409 PROFILE_CHANGED` before any write (`:354-410`) |

### 3.3 Contract DTOs the UI should import (never duplicate)

`ProfileGroupV2*`, `ProfileGroupKeyGrant/Revoked/Issue/Revoke*`, `ProfileGroupRequestDefaults*`, `ProfileGroupResolutionRefsV2`, `ProfileGroupEffectiveParametersV2`, `ProfileGroupPreviewV2Response`, `PROFILE_GROUP_PROBLEM_CODES`, `AdminWorkbenchProfile{Preview,Submit}V2*`, `AdminWorkbenchProfilePreviewV2Response` — all exported from `@du/contracts` (`packages/contracts/src/index.ts` re-exports both files).

### 3.4 Error taxonomy the UI must branch on (code, not title)

| Code | Status | Origin | UI obligation |
| :--- | :--- | :--- | :--- |
| `PROFILE_GROUP_V2_REQUIRED` | 409 | v1 read/save on a converted group; legacy child writes | Stop, explain, switch the pane to the V2 projection; never retry the v1 write |
| `PROFILE_CHANGED` | 409 | stale workbench fingerprint, changed profile/group/access version at admission | Keep the draft, re-run preview, require an explicit re-submit |
| `PROFILE_GROUP_UNAUTHORIZED` | 403 | selected key has no current root grant | Disable submit, name the key; **never** auto-select another key or group |
| `REVISION_CONFLICT` | 409 | v2 config save/rollback CAS | Banner + reload, preserve draft |
| `PRECONDITION_REQUIRED` | 428 | grant issue without `If-Match` | Programming error in the client; reload group first |
| `PRECONDITION_FAILED` | 412 | stale `accessVersion` on issue/revoke | Reload grants + group; do not auto-retry a mutating call |
| `STATE_CONFLICT` | 409 | conversion blocked, duplicate/ambiguous grant, disabled business, unavailable function | Show the sanitized field error pointer/message (e.g. `P3_SHARED_KEY`) |

---

## 4. Design

### 4.1 Screen and navigation decisions

| Decision | Rationale |
| :--- | :--- |
| Keep the `Groups` tab inside `/profiles` (no new top-level route) | The tab already exists, is platform-only, and is where grant/config discovery belongs; a new route would fork the shell navigation for no gain |
| Replace the v1 group editor in place; do not run v1 and v2 editors side by side | Two save paths for one resource is the drift the control plane exists to remove. v1 stays reachable only through the legacy server-rendered shell (read projection) |
| Split the editor into three panes: **Configuration**, **Root access**, **Revisions** | Directly encodes R2 (config vs access) so a reader cannot confuse `revision` with `accessVersion` |
| Group rail always reads V2 (`GET …/v2?tenantId=`) | v1 list 409s the whole page once any group has 0 or >1 ACTIVE grants (`receipt-pc03-service.md` D-3) |
| Workbench keeps both flows: v1 for legacy standalone profiles, v2 only for group functions | v1 bodies must stay byte-compatible; a legacy profile has no group to resolve |
| No tenant auto-selection and no key auto-selection anywhere | Plan: "No UI selects a first root key." The group rail requires a tenant; the workbench requires an explicitly picked key |

Proposed component map (new/changed files under `apps/admin-web/src/features/profiles/`):

```
profile-group-state.ts          (rewrite: V2 draft, access state, validation, save/mutation builders)
profile-group-editor.tsx        (rewrite: shell, rail, header, pane switch, rollback)
profile-group-config-pane.tsx   (new: businesses/functions + policy + requestDefaults)
profile-group-access-pane.tsx   (new: grants table, issue dialog, revoke confirm)
profile-group-request-defaults.tsx (new: per-field request defaults editor)
profile-group-search.ts         (unchanged: catalog search over function descriptors)
```

### 4.2 Draft and state model

```ts
// Read projection the editor holds. Never merges grants into config.
interface ProfileGroupV2ReadState {
  group: ProfileGroupV2;                    // @du/contracts (revision + accessVersion + authAuthority)
}

interface ProfileGroupV2Draft {
  groupId: string | null;                   // null = create
  tenantId: string;
  name: string;
  authMode: 'API_KEY';                      // single legal value today
  expectedRevision: number;                  // 0 on create
  accessVersion: number;                     // captured at read; 1 on create
  members: ProfileGroupV2MemberDraft[];      // business + version + function selection
  functionDrafts: Record<string, ProfileGroupV2FunctionDraft>; // policy + requestDefaults + pins
}

interface ProfileGroupV2FunctionDraft {
  enabled: boolean;
  parameters: Record<string, ProfileParameterValue>;        // profileSettings (policy.parameters)
  requestDefaults: Record<string, ProfileParameterValue>;   // v2 sibling of policy
  jobPriority: 'LOW' | 'MEDIUM' | 'HIGH';
  allowedFileExtensions: string;
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
  readPolicy: ProfileEndpointPolicyRead | null;             // preserve v1-only policy fields untouched
  childPin: { childProfileId: string; childRevision: number } | null; // read-only
  manifestDigest: string;                                   // read-only, from the catalog
}
```

Invariants the state module must enforce and test:

1. **`revision` and `accessVersion` move independently.** A config save returns a new `revision` and the **same** `accessVersion`; a grant issue/revoke returns a new `accessVersion` and the **same** `revision`. The editor must update only the matching field, never both.
2. **No key in the draft.** `ProfileGroupV2SaveSchema` rejects `apiKey` (`.strict()`, `profile-groups.ts:341-350`); the builder must not emit it.
3. **Server-owned fields are read-only:** `groupId`, `revision`, `accessVersion`, `authAuthority`, `apiKeyGrants`, `childProfileId`, `childRevision`, `manifestDigest`, `grantedAt/grantedBy`. No input control may write them.
4. **`requestDefaults` never carries credentials** — mirror the contract's secret-key refusal client-side for immediate feedback (`profile-groups.ts:257-269`), but the server remains authoritative.
5. **Conflict handling preserves the draft.** On `REVISION_CONFLICT` / `PRECONDITION_FAILED`, only the server snapshot is reloaded after an explicit user action; the local draft stays visible (existing pattern at `profile-group-editor.tsx:917`).

### 4.3 Group header (identity + the two counters)

Always visible above the panes:

| Field | Source | Notes |
| :--- | :--- | :--- |
| Group name | `ProfileGroupV2.name` | Editable only inside the Configuration pane |
| `groupId` | `ProfileGroupV2.groupId` | Mono, copyable, read-only |
| Tenant | `ProfileGroupV2.tenantId` | Read-only |
| **Config revision** | `revision` | Label exactly "Config revision"; a rollback moves it |
| **Access version** | `accessVersion` | Label exactly "Access version (grants)"; config saves never move it |
| Authority | `authAuthority` | Badge `GROUP_GRANT` vs `CHILD_PROJECTION`. On `CHILD_PROJECTION`, show the banner "This group still uses the legacy child projection. Configuration and root grants become editable only after the group is converted (an administrative operation outside this screen)." Every write control (Save, Rollback, Issue, Revoke) is disabled in that state — the service refuses all of them with `409 PROFILE_GROUP_V2_REQUIRED` (`profile-groups.ts:1506-1516`, `:1632-1639`) |
| Auth mode | `authMode` | Badge `API_KEY` |
| Timestamps | `createdAt`, `updatedAt` | Grant mutations intentionally do not bump `updated_at` (PC-03 D-7) — the header must not imply otherwise |

Copy rule: the two counters get **different** icons/labels and a one-line legend ("Editing configuration creates a new config revision. Issuing or revoking a key grant changes the access version and leaves the config revision untouched.").

### 4.4 Configuration pane (R1 + "nested typed endpoint config")

- Business rail/picker from the existing `listBusinesses` + version resolution and `ProfileGroupFunctionCatalog` reads (`profile-group-editor.tsx:144-281`, `:200-281`). Reuse as-is; only the projection switches from `ProfileGroupBusiness` to `ProfileGroupV2Business`.
- Per function, render three sub-sections that must never be conflated:
  1. **Profile settings** — `descriptor.profileSchema` → `policy.parameters` (existing renderer, `:654-683`).
  2. **Request defaults** — `descriptor.inputSchema.properties` → `requestDefaults` (new). Show, per property: default source (`requestDefaults` vs schema default vs client input), and mark locked properties (locked ones are refused in submissions — `effective.lockedParameters`).
  3. **Connector pins** — `descriptor.connectorSlots` + `connectorBindings` (existing selector, `:685-700`).
- Read-only inspector strip: `kind`, `functionId`, `action`, `endpointSlug`/`workflowRevision`, `manifestDigest`, `childProfileId`/`childRevision` (server-owned child pin), and collapsible `inputSchema` / `outputSchema` JSON (satisfies "inspect … input/output/profile schemas" without a new backend read).
- Save builds `ProfileGroupV2Save`: `{name, tenantId?, authMode:'API_KEY', expectedRevision, businesses:[{businessId, businessVersion, manifestDigest, functions:[{kind,functionId,action,endpointSlug?,workflowRevision?,policy,requestDefaults,connectorBindings}]}]}`.
- **Zero-key create** (R1): "New profile group" opens the name + tenant form only. On `201`, the group lands in the rail with `accessVersion: 1` and an empty grants table; the Access pane invites issuing the first root key **optionally**. Submit/save must stay enabled with zero grants.
- **Not-yet-converted groups are read-only.** A v2 create is the only writable path for a group that has never been converted; an existing `CHILD_PROJECTION` group can be inspected through this pane but every write is refused by the service (D-08). The pane must disable Save/Rollback/Issue/Revoke and explain the conversion requirement rather than surfacing a raw 409.

### 4.5 Root access pane (R3)

| Element | Behaviour |
| :--- | :--- |
| Active grants table | Columns: key prefix, key id, `status` (projected, never inferred), `grantedAt`, `grantedBy?`. Empty state: "No root grants. Configuration stays editable; workbench submission is disabled until a key is granted." No "0 grants" oracle beyond this empty state |
| Revoked history | Not readable (contract projects ACTIVE only). After a revoke, show the returned tombstone in an in-page "last revoke" note for the session only, labelled as session-local |
| **Issue** | Dialog with optional note; requires `accessVersion`; button label "Issue root key". Sends `POST …/keys` with `If-Match: "<accessVersion>"` + `Idempotency-Key: <uuid>` |
| Issue success | Reveal `secret` **once**, monospace, with a copy button and the explicit warning "This key cannot be shown again." Disable dialog close until acknowledged. If `secretAvailable === false` (idempotent replay), show "This issue was already processed in this session; the secret cannot be re-displayed — issue a new grant or rotate the key." |
| **Revoke** | Destructive confirm naming the prefix; body `{expectedAccessVersion}` + `Idempotency-Key`. On 412: close the dialog, reload the group, keep nothing queued |
| Version echo | Every mutation response carries the new `accessVersion`; the pane updates it and the header. A mismatch between the locally captured and returned version forces a full reload |

Interaction rules:

- Issue/revoke are **never** offered to non-platform sessions (BFF enforces too, `profile-groups.ts:180-192`).
- No bulk revoke, no "select all", no default key selection (plan: "No UI selects a first root key").
- The secret must never be placed in `location`, `localStorage`, a query string, an analytics event, or an error message. Only in component state until acknowledged.

### 4.6 Revisions pane (rollback)

- Input: target config revision + current `expectedRevision`.
- Copy must state what rollback does **and does not** do: "Rollback restores the configuration revision. It does not revoke, issue, or transfer root grants; the access version does not change."
- On success, refresh the group (new `revision`, unchanged `accessVersion`).
- Disabled when `revision < 1` or while a mutation is in flight.

### 4.7 Zero-key / zero-grant states (R1 + R4 boundary)

| State | Editor | Workbench submit |
| :--- | :--- | :--- |
| Group exists, 0 grants | Fully editable | Any key selected → disabled with reason "This key holds no active root grant" (after preview returns `PROFILE_GROUP_UNAUTHORIZED`) |
| Group exists, 1+ grants | Fully editable | Enabled only after a successful preview with the explicitly selected key |
| Key revoked mid-session | Group read still succeeds | Preview/submit `403 PROFILE_GROUP_UNAUTHORIZED` or `409 PROFILE_CHANGED` → disable and refresh; never swap keys |
| Legacy standalone profile (no group) | n/a | v1 workbench path unchanged |

### 4.8 Workbench v2 flow (R4)

Only for group functions; the legacy `document-core` v1 flow stays for standalone profiles.

1. **Select key first.** The key picker lists the tenant's ACTIVE keys (v1 endpoint already used) — no "first grant" shortcut and no group dropdown. Rationale: the server derives the group from the key (`admin-workbench/service.ts:285-300`).
2. **Select function.** The functions offered are the ones the tenant's v2 groups expose for that key. Read `GET /admin/api/profile-groups/v2?tenantId=` and filter groups whose `apiKeyGrants[].apiKeyId` contains the selected key, then list their functions. This is a UI-side filter only; the server still derives the group from the key and re-verifies the grant.
3. **Build the submission** exactly as `SubmissionSchema` (input/output/artifacts/sourceUrl), then **Preview**:
   `POST /admin/api/admin-workbench/v2/preview` with `{tenantId, apiKeyId, businessId, businessVersion, action, functionId, endpointSlug?, submission}`.
4. **Render the preview panel** (not a confirmation dialog):
   - `refs`: `groupId`, `groupRevision`, `accessVersion`, `businessId@businessVersion`, `manifestDigest`, `kind`, `functionId`, `action`, `endpointSlug`/`workflowRevision`+`workflowDigest?`, `childProfileId`, `childRevision`, `tenantDefaultsRevision` (null ⇒ "tenant defaults not pinned"), `connectorBindings[]`.
   - `effective.parameters` (the exact resolved request), `appliedRequestDefaults[]`, `appliedSchemaDefaults[]`, `lockedParameters[]` (must be absent from the submitted input).
   - `resolutionFingerprint` displayed truncated with a copy affordance — it is the submit proof.
5. **Submit** `POST …/v2/submit` with the same body + `resolutionFingerprint` + `Idempotency-Key`. The fingerprint must be held immutably with the attempt (reuse the existing `immutable-attempt` pattern; `docs-screen.tsx:852-889`).
6. **Failure handling**:
   - `409 PROFILE_CHANGED` → keep the draft, mark the preview stale, require an explicit "Preview again" (comparison of old/new fingerprint shown), never auto-submit.
   - `403 PROFILE_GROUP_UNAUTHORIZED` → disable submit for this key; show the key prefix.
   - `412/428` (should not occur on preview/submit) → treat as a programming error, reload.
7. **No simulation claims.** The panel says "Preview resolves configuration only; no provider call is made." Submit is the only action that can incur cost (existing honesty copy pattern, `docs-screen.tsx:1237`).

### 4.9 Operations detail & diagnostics (R6 — conditional)

Supported actions: unchanged by PC-08 (cancel/retry/resume/delete with the existing gates; retry semantics belong to PC-07).

Safe refs: **cannot be built from today's read projection.** `toOperationView` exposes no profile/group/connector fields (`facade.ts:37-57`), and the `operations` row persists no group id or access version (INSERT column list, `submission.ts:1793-1803`; only `profile_id`, `profile_revision`, `connector_bindings`, `endpoint_slug`, tenant-default pins and workflow pins).

Two honest options:

| Option | Work | Honesty |
| :--- | :--- | :--- |
| **A (recommended for PC-08)** | Add an additive, optional `resolution` object to the admin operation detail projection: `{profileId, profileRevision, endpointSlug, connectorBindings[], resolutionFingerprint?}`. Fingerprint comes from `submission_keys.resolution_fingerprint` joined by `operation_id`; connector pins from `operations.connector_bindings`. UI renders a "Pinned resolution" block | Truthful: only fields that are actually stored. No group id / access version claimed |
| **B** | Persist the group pin (`groupId`, `accessVersion`, `groupRevision`) on `operations` at admission, then project it | Requires a migration + submission change; belongs to PC-07/PC-09, not a UI packet |

If neither is approved, PC-08 must render **no** refs block and record R6 as partially unmet (documented gap), rather than inventing labels.

### 4.10 Legacy UI compatibility (R5)

1. Server-rendered shell: no group section exists; add **no** new group write affordances.
2. Map upstream 409 codes to explicit copy in the legacy profile/API-key panes and in the React editor fallback:
   - `PROFILE_GROUP_V2_REQUIRED` → "This profile is owned by a profile group that uses root grants. Edit it through Profiles → Groups."
   - `PROFILE_CHANGED` → "The pinned resolution changed. Reload before retrying."
   - `PROFILE_GROUP_UNAUTHORIZED` → "The selected key holds no current root grant for this group."
3. Key panes are **partly** safe already: PC-04 made rotate/revoke group-aware (rotation copies the same-group grant and revokes the old one; revoke tombstones the grant and bumps `access_version` — `admin-actions/dispatcher.ts:1055,1329`, `identity/api-keys.ts:380,454`). Only membership/attach edits on group children 409 (`PROFILE_GROUP_V2_REQUIRED`). Therefore the UI obligation is: (a) surface that 409 accurately, and (b) on revoke/rotate of a group-managed key, state that the root grant changes too (access version moves) — not that the action is impossible. Until `key_mode` is projected the UI cannot pre-label a key as group-managed, so the copy must be conditional on the observed outcome, never a guess.

---

## 5. BFF change plan

### 5.1 New route family and precedence

New file `services/orchestrator/src/app/admin/bff/profile-groups-v2.ts`:

```ts
export type ProfileGroupsV2Route =
  | { kind: 'list' }
  | { kind: 'group'; groupId: string }
  | { kind: 'rollback'; groupId: string }
  | { kind: 'keys'; groupId: string }
  | { kind: 'keyRevoke'; groupId: string; keyId: string }
  | { kind: 'invalid' };

export function matchProfileGroupsV2Route(relative: string): ProfileGroupsV2Route | null;
export async function handleProfileGroupsV2Route(...): Promise<void>;
```

BFF paths (all under `/admin/api`):

```
GET  /profile-groups/v2?tenantId=
POST /profile-groups/v2
GET  /profile-groups/v2/:groupId[?tenantId=]
PUT  /profile-groups/v2/:groupId
POST /profile-groups/v2/:groupId/rollback
POST /profile-groups/v2/:groupId/keys
POST /profile-groups/v2/:groupId/keys/:keyId/revoke
```

**Precedence (critical):** `handle.ts` must test `matchProfileGroupsV2Route(relative)` **before** `matchProfileGroupsRoute(relative)` (`handle.ts:147-150`). Otherwise `/profile-groups/v2` is captured by the v1 matcher as `{kind:'invalid'}` → 404 and never reaches the new family (`profile-groups.ts:48-55`). Recommended insertion point: immediately above the existing `profileGroupsRoute` block, with a comment stating the ordering invariant.

Workbench additions in `bff/admin-workbench.ts`:

```
POST /admin-workbench/v2/preview
POST /admin-workbench/v2/submit
```

matched in the existing `matchAdminWorkbenchRoute` (`:16-20`) and routed to new internal suffixes (`/api/internal/admin-workbench/v2/{preview,submit}`). All existing gates stay: POST-only, no query, session, CSRF, viewer/unscoped denial, `Idempotency-Key` (submit only — preview has no idempotency semantics), session proof for a local operator.

### 5.2 Handler gates per route

| Route | Authz gate | CSRF | Headers | Body validation |
| :--- | :--- | :--- | :--- | :--- |
| `GET /profile-groups/v2` | session + non-unscoped; tenant scope via `authorizeAuditTenantRead`; platform must supply `tenantId` | n/a | — | query: single `tenantId` |
| `POST /profile-groups/v2` | **platform admin only** | required | — | `ProfileGroupV2Save` server-side (relay validates anyway; BFF only enforces "JSON object") |
| `GET /profile-groups/v2/:id` | tenant read (platform: optional tenantId) | n/a | — | no query except single `tenantId` |
| `PUT /profile-groups/v2/:id` | platform admin | required | — | as above, body carries `expectedRevision` |
| `POST …/rollback` | platform admin | required | — | as above |
| `POST …/keys` | platform admin | required | **`If-Match` forwarded**, **`Idempotency-Key` forwarded** | `ProfileGroupKeyIssueInput` |
| `POST …/keys/:keyId/revoke` | platform admin | required | `Idempotency-Key` forwarded | `ProfileGroupKeyRevokeInput` |
| workbench v2 preview/submit | session (admin or operator), tenant must match for a tenant principal | required | submit: `Idempotency-Key`; operator: session proof | `AdminWorkbenchProfile{Preview,Submit}V2Request` |

Local-USER (OIDC `du-local` operator) policy for the group routes — **decision D-01**: default to **deny group reads/writes to local operators** in this packet (403 `PROFILE_GROUP_ASSIGNMENT_REQUIRED`, mirroring the v1 mutation rule) and keep the operator on the v1 workbench. Reason: there is no group-level assignment projection, so a filtered v2 list would have to invent one; and PC-05 already requires the operator to hold the key **and** the child profile for the v2 workbench (which the operator cannot discover today — see §9 D-01).

### 5.3 Additive `upstream.ts` changes (no behaviour change for existing callers)

```ts
export interface UpstreamCallOptions {
  // …existing…
  /** Allowlisted request headers forwarded verbatim (currently only `if-match`). */
  forwardHeaders?: Record<string, 'if-match'>;
}

export async function relayUpstream(
  res, response, correlationId,
  opts: { wrapInData?: boolean; relayHeaders?: readonly ('etag' | 'idempotent-replay')[] } = {},
): Promise<void>
```

Rules:

- `forwardHeaders` maps a BFF header name to a fixed upstream name; the BFF only accepts the exact names it lists. No generic header pass-through.
- `relayHeaders` copies only the named upstream headers, after the same bounded sanitization as any other value (digits/quotes for ETag; `true` for replay).
- Every other caller keeps the current signature; defaults are empty/absent.

### 5.4 Error mapping and body shaping

| Upstream | BFF behaviour |
| :--- | :--- |
| 200/201 JSON | relay body unchanged (no envelope) |
| 409 with code | pass status + code (`envelope.ts:58-72` already does); the UI branches on `code` |
| 412/428 | pass through as-is (codes match the allowlist regex `^[A-Z0-9_]{3,64}$`) |
| 5xx | `502 UPSTREAM_ERROR` (unchanged) |
| Non-JSON success | `502 UPSTREAM_ERROR` (unchanged) |
| Issue success | body relayed; `cache-control: no-store` already set by `writeJson`; optionally relay `idempotent-replay` |

Never log the issue response body (it may contain `secret`); the BFF logger only logs `{correlationId, route, status}` today, and PC-08 must not add body logging.

---

## 6. Client and type change plan (`apps/admin-web/src/lib/api/`)

New methods on `AdminApiClient` (implementation in `client.ts`, types re-exported from `@du/contracts` in `types.ts`):

```ts
listProfileGroupsV2(tenantId: string): Promise<AdminApiResult<ProfileGroupV2List>>;
getProfileGroupV2(groupId: string, tenantId?: string): Promise<AdminApiResult<ProfileGroupV2>>;
createProfileGroupV2(body: ProfileGroupV2Save): Promise<AdminApiResult<ProfileGroupV2>>;
replaceProfileGroupV2(groupId: string, body: ProfileGroupV2Save): Promise<AdminApiResult<ProfileGroupV2>>;
rollbackProfileGroupV2(groupId: string, body: ProfileGroupRollback): Promise<AdminApiResult<ProfileGroupV2>>;
issueProfileGroupKey(
  groupId: string, body: ProfileGroupKeyIssueInput,
  accessVersion: number, idempotencyKey: string,
): Promise<AdminApiResult<ProfileGroupKeyIssueResult>>;
revokeProfileGroupKey(
  groupId: string, keyId: string, body: ProfileGroupKeyRevokeInput, idempotencyKey: string,
): Promise<AdminApiResult<ProfileGroupKeyRevokeResult>>;
previewAdminWorkbenchProfileV2(
  body: AdminWorkbenchProfilePreviewV2Request,
): Promise<AdminApiResult<AdminWorkbenchProfilePreviewV2Response>>;
submitAdminWorkbenchProfileV2(
  body: AdminWorkbenchProfileSubmitV2Request, idempotencyKey: string,
): Promise<AdminApiResult<AdminWorkbenchOperationAccepted>>;
```

`request()` (`client.ts:525-619`) needs one additive capability: an optional `headers` map restricted to `if-match` (validated as `/^"?[1-9]\d*"?$/` before send). Everything else — CSRF bootstrap, idempotency header, problem decoding, 401 session expiry — is reusable unchanged.

`resolveProfileGroupV2Error(problem)` helper in `profile-group-state.ts` maps `code` → `{kind, title, recovery}` so every pane renders identical copy (single source).

---

## 7. Test plan (must be runnable without PostgreSQL)

### 7.1 BFF offline suites (`services/orchestrator/tests/`)

Follow the established loopback + scripted upstream pattern (`aweb09-profile-api-keys-bff.test.ts:1-90`).

`aweb10-bff-profile-groups-v2.test.ts`:

1. `matchProfileGroupsV2Route` wins over the v1 matcher for `/profile-groups/v2…` (ordering regression test); a v1 path still routes to v1.
2. List: platform without `tenantId` → 422; tenant operator with own tenant → 200; foreign tenant → 403; viewer/unscoped → 403 `PROFILE_SCOPE_GATE`.
3. Create/replace/rollback: non-admin → 403 `PROFILE_SCOPED_GATE`; missing/incorrect CSRF → 403 `CSRF_REJECTED`; admin → upstream called with `/api/v2/...` and the platform bearer.
4. Local operator (OIDC `du-local`) → 403 `PROFILE_GROUP_ASSIGNMENT_REQUIRED` on both read and write, per D-01 (if approved).
5. Issue: missing `Idempotency-Key` → 422 (`PROFILE_GROUP…` or `INVALID_SCHEMA`); missing `If-Match` → 428 forwarded from upstream (assert the header was actually forwarded); success body relayed verbatim including `secret`; response has `cache-control: no-store`; a replay (`secretAvailable:false`) is relayed without a secret.
6. Revoke: `expectedAccessVersion` body forwarded unchanged; 412 relayed with code `PRECONDITION_FAILED`.
7. Upstream 500 → `502 UPSTREAM_ERROR` with no upstream text; upstream 409 `PROFILE_GROUP_V2_REQUIRED` → same status + code, generic title.
8. No secret appears in any logger call (spy on the BFF logger; assert the raw secret string never appears).

`aweb10-bff-workbench-v2.test.ts`:

1. `/admin-workbench/v2/preview` requires POST/CSRF and rejects viewers.
2. Submit requires `Idempotency-Key`; preview does not.
3. Local operator forwards the session proof (cookie + `x-csrf-token`) and **no** bearer, exactly like v1 (`admin-workbench.ts:57-72`).
4. Tenant mismatch for a `tenant_operator` → 404.
5. Response is the accepted-operation envelope; a 409 `PROFILE_CHANGED` is relayed with its code.

### 7.2 Admin-web pure-module suites (jest importing the app tree)

Pattern already used by `orv13-*`/`orv14-*` tests (`import … from '../../../apps/admin-web/src/...'`).

`aweb10-profile-group-v2-state.test.ts`:

- create draft has no `apiKey`; save body deep-equals the contract shape; `ProfileGroupV2SaveSchema.safeParse(body).success === true`.
- config save updates `revision` only; grant issue/revoke updates `accessVersion` only.
- validation refuses: empty name (>120 chars), zero businesses, zero functions in a business, function absent/unavailable in the catalog, required `profileSchema` property missing, required connector slot missing, `requestDefaults` credential-shaped key.
- read → draft → save round-trip is lossless for `policy` fields the UI does not render (`connectionsOverride`, `requestRedaction`, `callbackPolicy`, `allowedOrigins`).
- error mapping: the five documented codes produce distinct `{kind, recovery}` and never a "retry automatically" action.

### 7.3 Browser suites (`tests/browser/admin-web/`)

`profile-groups-v2.spec.ts` (Playwright against the Vite build + BFF stub):

1. Zero-key create: tenant selected → New group → name only → 201 → rail entry with `accessVersion 1`, grants empty, save still enabled, no key field rendered.
2. Config save: edit a function's profile settings + request defaults + connector pin → PUT carries `expectedRevision` and no `apiKey`; header shows new config revision, same access version.
3. Revision conflict: stub 409 `REVISION_CONFLICT` → banner, draft intact, explicit reload required.
4. Grant issue: stale `If-Match` stub 412 → dialog closes, group reloads, no automatic retry; success → secret shown once, copy button, warning, not present after dialog close (assert absence in DOM and in `localStorage`).
5. Grant revoke: destructive confirm → body has `expectedAccessVersion` → access version badge increments, config revision unchanged.
6. Rollback: copy states grants are untouched; success updates config revision only.
7. Converted-group legacy fence: v1 list 409 stub → the rail must not render a broken page; the pane shows the V2 requirement message (if v2 read also fails, an explicit "switch required" banner, not a raw 409).
8. Workbench v2: pick key → function → Preview shows refs/effective/fingerprint → Submit sends the exact fingerprint + `Idempotency-Key`; stale fingerprint stub 409 → submit disabled until re-preview.
9. Workbench zero-grant: `PROFILE_GROUP_UNAUTHORIZED` → submit disabled, key named, no group picker present.
10. Operations: unsupported action buttons absent for viewer; retry hidden for non-admin/unknown outcome (regression of existing behavior, ensures the refs block does not alter action gating).
11. 320 px reflow of the three panes with no horizontal overflow; keyboard-only path through issue/revoke dialogs; axe scan zero critical/serious on the Groups tab and workbench preview.
12. `CHILD_PROJECTION` group: v2 read renders the configuration read-only; Save/Rollback/Issue/Revoke are disabled with the conversion banner; the raw `409 PROFILE_GROUP_V2_REQUIRED` never reaches the operator (D-08).

### 7.4 Honesty/a11y invariants worth asserting

- No string "simulat", "dry run" or "will succeed" in the preview/submit copy.
- The preview panel must not render provider text or a fabricated outcome.
- Every destructive dialog names the exact object (group name + key prefix).
- No secret in `console.*`, DOM after acknowledgement, `sessionStorage`, `localStorage`, URL, or problem text.

---

## 8. Acceptance matrix (PC-08 row)

| Plan requirement | Deliverable | Test |
| :--- | :--- | :--- |
| Zero-key V2 group CRUD | Config pane + create flow, no key selector | 7.1 (1-3), 7.2 (1-3), 7.3 (1-2) |
| `active_revision` ≠ `access_version` visible | Header counters + independent update invariants | 7.2 (2), 7.3 (2,5,6) |
| Root grant list + issue/revoke with `expectedAccessVersion` | Access pane + client methods + BFF routes | 7.1 (5-6), 7.3 (4-5) |
| Workbench key selection + fingerprint | Preview panel + v2 submit | 7.1 workbench (1-5), 7.3 (8-9) |
| Legacy UI safe v1 projection, 409 on converted writes | Legacy copy mapping + no group writes; React fallback | 7.2 (error mapping), 7.3 (7) |
| Operations supported actions + safe refs | Action gating unchanged; refs block only if D-02 option A is approved | 7.3 (10) + 7.1 if a projection is added |
| Inspect business/version/functions and schemas | Read-only schema inspector in the config pane | 7.3 (2) + snapshot assertions |
| Old UI remains compatibility only | No new group affordance in `src/app/admin/**` | grep assertion in the BFF/UI suites |

---

## 9. Risks and open decisions (need coordinator ruling)

| # | Decision | Options | Recommendation / impact |
| :--- | :--- | :--- | :--- |
| **D-01** | Local operator discovery for V2 group functions | (a) v2 group BFF routes platform-only; operators keep v1 workbench and cannot test group functions; (b) add an "assigned group functions" read that intersects the operator's assigned child profiles with group functions | **(a) for PC-08.** (b) needs a new read projection + assignment semantics; it is a PC-09 or PC-07 follow-up. Without a ruling, pick (a) and record the operator gap explicitly |
| **D-02** | Operations "safe effective refs" | (a) additive optional `resolution` field on the admin detail projection (`profileId`, `profileRevision`, `endpointSlug`, `connectorBindings[]`, `resolutionFingerprint?`); (b) persist the group pin on `operations` (migration + submission change); (c) ship no refs block | **(a) if the coordinator wants R6 met in PC-08** (small, additive, no migration). Otherwise (c) with a documented partial. Group `accessVersion` at admission is **not** recoverable either way |
| **D-03** | Group read used by the rail | v2 always; v1 with 409 fallback; dual read | **v2 always.** v1 409s whole pages (`receipt-pc03-service.md` D-3) and its single-key projection is misleading for multi-grant groups |
| **D-04** | Grant issue idempotency policy in the browser | (a) new UUID per dialog open, retained on transport failure; (b) new UUID per click | **(a).** A transport failure must be replayable without minting a second key; the server already refuses a secret re-emission on replay |
| **D-05** | Access version transport | Forward `If-Match` from the browser; or have the BFF construct it from a body field | **Forward `If-Match`.** The service requires the header (428 otherwise); a body field would be a contract delta |
| **D-06** | Issue note is write-only | Accept the note in the UI and never display it; or drop the note; or add `note` to the grant read DTO | **Drop or accept-and-label as write-only** for PC-08; adding a field to `ProfileGroupKeyGrantSchema` is a PC-01 delta |
| **D-07** | Client-side `requestDefaults` secret refusal | Mirror `findSecretParameterKeys`; or rely on the server 422 | **Mirror** for immediate feedback, but never claim the client is authoritative |
| **D-08** | `authAuthority === 'CHILD_PROJECTION'` UX | Read-only inspection with a banner; or hide the group entirely; or pretend it is editable | **Read-only inspection with the banner.** The service refuses v2 config save, rollback and grant issue for a still-`CHILD_PROJECTION` group with `409 PROFILE_GROUP_V2_REQUIRED` before any write (`profile-groups.ts:1506-1516`, `:1632-1639`, plus `issueGroupKey`/`revokeGroupGrant`). Conversion has no route (`receipt-pc03-service.md` §4), so Save/Rollback/Issue/Revoke must be disabled with copy explaining the out-of-band conversion step |
| **D-09** | Workbench function discovery (platform admin) | Filter the v2 group list by the selected key's grants (UI-side); or add a server "functions for key" read | **UI-side filter** for PC-08: the list is tenant-scoped and already carries `apiKeyGrants`; the server still derives and re-verifies the group |
| **D-10** | v1 group editor retirement | Delete; or keep behind a feature flag | **Delete from the React app.** Keep the v1 BFF family for the legacy shell/compat consumers; the React app must not call it for groups |
| **D-11** | Replay visibility | Rely on `secretAvailable:false`; or relay `idempotent-replay` | **Rely on the body** (`secretAvailable`) so the UI needs no extra header; relay the header only if it proves useful |
| **D-12** | Operations retry after a revoke | PC-08 asserts only that the action matrix is state-based; PC-07 owns re-authorization | Record as a cross-packet dependency, not a UI fix |

Additional recorded risks:

- **R-01 (HIGH): operator lockout after conversion.** `listAssignedProfileEndpoints` excludes group children (`self-service.ts:471`) and the profile catalog excludes them too (`profile-list.ts:70`). A tenant that converts groups removes the operator's ability to see or test those functions until D-01(b) lands.
- **R-02 (MEDIUM): v1 list page failure.** If any consumer still calls the v1 list (the legacy shell does not), one multi-grant group 409s the whole page. Ensure the React rail uses v2 and the error copy explains the switch.
- **R-03 (MEDIUM): generic upstream titles.** `upstreamProblem` replaces the upstream message (`envelope.ts:71`). Every new pane must render copy from `code`, otherwise "The admin API rejected the request" reaches the operator.
- **R-04 (LOW): secret surface.** The issue response is the only place a group key crosses the wire. Any component that keeps it in state after acknowledgement, or any logger/BFF body log, is a defect. Assert in tests.
- **R-05 (LOW): stale `accessVersion` after a config save.** A config save does **not** change `accessVersion`; the UI must not snapshot access version from a mutation response it did not perform (e.g. after rollback).

---

## 10. Sequencing and file lease (for the execute packet)

**Owned paths (proposed lease):**

```
orchestrator/services/orchestrator/src/app/admin/bff/profile-groups-v2.ts   (new)
orchestrator/services/orchestrator/src/app/admin/bff/admin-workbench.ts     (+2 routes)
orchestrator/services/orchestrator/src/app/admin/bff/handle.ts              (+import/dispatch line)
orchestrator/services/orchestrator/src/app/admin/bff/upstream.ts            (additive header option only)
orchestrator/apps/admin-web/src/lib/api/client.ts                            (+9 methods, +1 header capability)
orchestrator/apps/admin-web/src/lib/api/types.ts                             (+ re-exports)
orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts     (rewrite)
orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx   (rewrite)
orchestrator/apps/admin-web/src/features/profiles/profile-group-config-pane.tsx      (new)
orchestrator/apps/admin-web/src/features/profiles/profile-group-access-pane.tsx      (new)
orchestrator/apps/admin-web/src/features/profiles/profile-group-request-defaults.tsx (new)
orchestrator/apps/admin-web/src/features/docs/docs-screen.tsx                (v2 branch + preview panel)
orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx    (refs block only if D-02(a))
orchestrator/services/orchestrator/tests/aweb10-bff-profile-groups-v2.test.ts (new)
orchestrator/services/orchestrator/tests/aweb10-bff-workbench-v2.test.ts      (new)
orchestrator/services/orchestrator/tests/aweb10-profile-group-v2-state.test.ts (new)
du-rework/tests/browser/admin-web/profile-groups-v2.spec.ts                   (new)
```

**Not in the lease (request, do not edit):** `modules/profiles/**`, `modules/operations/submission.ts`, `packages/contracts/src/**`, `apps/admin-web/src/features/businesses/businesses-screen.tsx` (only a read-only schema inspector addition inside the group config pane is proposed, so the businesses screen stays untouched), `src/app/admin/**` (legacy shell; PC-08 only adds copy mapping if the coordinator grants it).

**Execution order (each step independently verifiable):**

1. `upstream.ts` additive option + `profile-groups-v2.ts` + `handle.ts` wiring → offline BFF suite for routes/auth/idempotency (no UI yet).
2. `client.ts`/`types.ts` methods → typecheck (`pnpm --filter @du/admin-web typecheck`).
3. `profile-group-state.ts` rewrite + pure-module test → contract-shaped save bodies.
4. Config pane + editor shell (create/save/rollback) → browser suite cases 1-3, 6, 11.
5. Access pane (issue/revoke/secret) → browser cases 4-5, 7.
6. Workbench v2 (BFF + preview panel + submit) → browser cases 8-9.
7. Operations refs block only if D-02(a); otherwise document the gap.
8. Full pass: BFF offline suites, pure-module suite, browser suite, `tsc --noEmit` on both packages; report literal `Tests: N passed` and exit codes.

**Definition of done:** every §8 row either passes its listed test or is recorded as an accepted partial with the coordinator's decision id. No claim of deployed behaviour from source or test receipts alone.

---

## 11. Reproduction appendix (read-only commands used)

```bash
# route/feature inventory
rg -n "ProfileGroupV2|accessVersion|apiKeyGrants|requestDefaults|resolutionFingerprint" orchestrator/services/orchestrator/src orchestrator/apps/admin-web/src
rg -n "PROFILE_GROUP_V2_REQUIRED|PROFILE_CHANGED|PROFILE_GROUP_UNAUTHORIZED" orchestrator/services/orchestrator/src orchestrator/apps/admin-web/src
rg -n "/v2|If-Match|etag" orchestrator/apps/admin-web/src          # → 0 hits today
rg -n "key_mode|GROUP_MANAGED" orchestrator/services/orchestrator/src/app/admin   # → 0 hits in the legacy shell

# BFF dispatch order (why precedence matters)
sed -n '110,160p' orchestrator/services/orchestrator/src/app/admin/bff/handle.ts

# v1 vs v2 group matchers
sed -n '24,56p'  orchestrator/services/orchestrator/src/app/admin/bff/profile-groups.ts
sed -n '45,90p'  orchestrator/services/orchestrator/src/http/routes/admin-profile-groups-v2.ts

# draft model (mandatory key)
sed -n '16,60p;103,260p' orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts

# workbench v1 body
sed -n '897,940p' orchestrator/apps/admin-web/src/features/docs/docs-screen.tsx
```

---

*End of report. No source files were modified; only this document was created.*
