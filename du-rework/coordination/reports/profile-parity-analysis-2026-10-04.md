# Phân tích Profiles Tab Parity — du-rework vs dugate cũ (2026-10-04)

Nguồn: tách từ plan đã approve tại `C:\Users\Gem\.claude\plans\typed-discovering-wall.md` (Phần 0). Plan chính chứa scope/quyết định user đã chốt (đủ bộ legacy PAR-12 + PAR-13; auth gồm scoped user; secret AES-256-GCM trong DB). File này chỉ chứa **findings đã verify bằng đọc source**, để các agent khác dùng chung một framework mà không cần đọc lại code.

## 1. Legacy dugate cũ — UI (`D:\Git\dugate\app\profiles\page.tsx`, 2687 dòng)

| Nhóm chức năng | Chi tiết đã xác minh |
|---|---|
| Client selector | Dropdown API keys (`GET /api/internal/apikeys`), modal Add Client (`POST /api/internal/apikeys` → rawKey hiện 1 lần) |
| Service tabs | Tab theo service, mặc định `extract`; toggle showOnlyEnabled; Endpoints Hierarchy |
| ProfileEndpointCard / endpoint | Toggle `enabled`; params editor từng key `{value, isLocked}` + thêm/xóa key + raw JSON view; `jobPriority` select; `fileUrlAuthConfig` editor; `allowedFileExtensions` CSV; `connectionsOverride` editor ConnStep[] |
| Prompt wizard | Per-step prompt override, modal riêng; cURL preview; nút copy |
| Test Endpoint modal (dòng 1265–1450) | Params grid tôn trọng `isLocked` (badge 🔒, không cho sửa); upload file `accept=".pdf,.docx,.txt,.jpg,.jpeg,.png"`; textarea `file_urls`; `POST /api/internal/test-profile-endpoint` chạy pipeline thật áp đủ profile params + prompt override; panel result `extracted_data/content/error` |
| Bulk save | Lưu song song `POST /api/internal/profile-endpoints` cho từng endpoint đã đổi |

## 2. Legacy — API + runtime semantics

| File | Phát hiện |
|---|---|
| `app/api/internal/profile-endpoints/route.ts` | Record duy nhất theo `(apiKeyId, endpointSlug)`; `enabled` default true; `parameters` JSON `{key:{value,isLocked}}`; `connectionsOverride` (string[] slug cũ + `ConnectionStep[] {slug,stepId?,captureSession?,injectSession?}`); `jobPriority` LOW/MEDIUM/HIGH → BullMQ 20/10/1; `fileUrlAuthConfig` AES-256-GCM (fallback plain JSON); `allowedFileExtensions` CSV; `_workflowPrompts` override per-step; POST upsert: **non-admin chỉ được sửa `parameters/connectionsOverride` khi endpoint enabled (else 403)**; admin full-field + validate slug + VALID_PRIORITIES |
| `app/api/internal/ext-overrides/route.ts` (PAR-13) | Unique `(connectionId, apiKeyId, endpointSlug, stepId default '_default')`; POST upsert `{connectionId,apiKeyId,endpointSlug,stepId,promptOverride,isActive}`; `isActive:false` → delete; non-admin cần `requireProfileAccess` + endpoint enabled |
| `lib/auth-guard.ts` | `requireProfileAccess(apiKeyId)`: ADMIN pass hết, USER cần row `userProfileAssignments` else 403; `getAssignedProfileIds`: ADMIN → null (unfiltered), USER → mảng |
| `docs/API_PROFILES_SPEC.md §1.3` + `lib/endpoints/profile-resolver.ts:49-86` | Merge: profile default trước, client override chỉ khi được phép; **field bị lock mà client vẫn gửi (dù giá trị giống hệt) → 400**; unknown/disabled → fail-closed; precedence Code > Profile > Connector default |
| `app/api/internal/test-profile-endpoint`, `prompt-wizard`, `user-profiles`, `ext-connections`, `apikeys` | Đủ bộ route hỗ trợ UI legacy; du-rework port có chọn lọc (test-endpoint → quyết định T-UI-06 trong plan) |

## 3. du-rework hiện trạng (đã đọc source trực tiếp)

| Seam | File:line | Thực trạng |
|---|---|---|
| Profile service | `services/orchestrator/src/modules/profiles/profiles.ts` (165 dòng) | Chỉ có pin connector-bindings: `createRevision` append-only, `resolveBinding` latest per (key,business,version,action); ≥1 binding + no match → 403; no bindings → legacy mode. **Chưa có enabled/parameters/lock/priority/mimetype/authconfig/prompt-override** |
| Submission seam | `services/orchestrator/src/modules/operations/submission.ts:214` | `profiles.resolveBinding(...)` rồi `:318` INSERT operations kèm `profile_id/profile_revision/connector_bindings`. Điểm duy nhất được phép chèn policy seam (PAR-XA-03) |
| Migration | `migrations/0004_profile_bindings.sql` | Bảng `profile_bindings(profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings jsonb, PK(profile_id,revision))` + index key_action; operations đã có 3 cột pin |
| Shell form | `src/app/admin/profile-section-renderer.ts` (524 dòng) | `renderProfileSection` → form POST `/admin/profiles` ("Save draft") **không handler**; widgets textarea/boolean/select/number/secret/readonly-hint/text-fallback; locked slots readonly+disabled+data-locked; states ok/empty/unauthorized/not-found/error |
| Shell data | `src/app/admin/profile-section-data.ts` (633 dòng) | `ProfileFetcherInput/Result`, `ProfileManifestWireRow` (actions[].slots[] locked/lockedValue, connectorSlots promptConfigSchema); note W40: có POST profile-bindings nhưng **chưa có GET read route** |
| Mutation pattern | `src/app/admin/mutation-dispatch.ts` (`handleAdminMutationPost`) | Chỉ match `/admin/api-keys/new`, `/revoke`, `/connectors/.../test\|rotate-secret`; 401 no claims, 403 non-admin, CSRF `verifySessionCsrf` (OIDC) hoặc `validateCsrfToken` (du_admin+cookieSecret), 503 nếu thiếu `config.adminAction`. Mẫu để clone cho profile POSTs |
| Dispatcher | `src/modules/admin-actions/dispatcher.ts` (774 dòng) | Các case: business.enable/activate/drain, operations.*, `apikey.bind-profile` (:483), `apikey.issue` (:540), `apikey.revoke` (:619), connectors.rotate/revoke/test. Auth kinds bearer/cookie; actor `shell:<role>` |
| Session/RBAC | `src/modules/auth/session-store.ts`, `src/modules/admin-actions/rbac.ts` | `SessionRole admin/operator/viewer`, `principalFromSession`, `verifySessionCsrf`, cookie `du_session`; `resolveAdminPrincipal`, `requireResourceTenant`, `deriveCsrfToken/validateCsrfToken`, `ADMIN_SESSION_COOKIE='du_admin'`. Nền cho scoped-user |
| Local auth | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md`, migration `0023_admin_local_users` | LOCAL-01/02 đã có code trên đĩa nhưng **thiếu receipt VFY-LOCAL** → scoped-user phải stage sau dependency này |

## 4. Khung plan hiện có — agent phải đồng nhất (không đẻ tên mới)

| Plan | Nội dung dùng lại |
|---|---|
| `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` | ORCH-PAR-00..10 (khung tổng); PAR-12 = ProfileEndpoint policy + merge/lock; PAR-13 = prompt override key-4 |
| `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` | ORCH-PAR-11..17 field-level; quy tắc **serialize single-writer**: 1 writer tại 1 thởi điểm cho `src/http/routes/admin.ts`, `src/app/bootstrap/create-app.ts`, `modules/admin-actions/dispatcher.ts`, `src/app/admin/{auth,section,mutation,crypto-config}-dispatch.ts`, migrations, `packages/contracts`, `docs/21-openapi.json` |
| `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md` | PAR-XA-03: policy schema/repo/revision/migration/enforcement dưới `modules/profiles/**`; **1 admission seam** trong `submission.ts` trả typed `{effectiveInput, effectiveProfileRevision, connectorBindings, policyDenial}`; canonical + legacy decoder chung seam; deny → **không tạo operation/task/outbox**; worker đọc snapshot đã pin, không đọc live profile; locked-field presence → 400 dù trùng giá trị; no credential trong snapshot |
| `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` | ACUI-04 (Profiles UI: list/create/draft/diff/validate/publish/activate/rollback, effective-config preview); ACUI-M01 (form POST không ghi), ACUI-M02 (revision:0 placeholder), ACUI-M07 (BFF đọc bằng platform token, bỏ qua session role) |
| `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md` | LOCAL-00..06, `DU_ADMIN_AUTH_MODE=local\|oidc\|both`; scoped-user dựa vào session/RBAC + assignment |

## 5. Gap analysis (hiện trạng → đủ bộ legacy)

| Legacy có | du-rework có | Còn thiếu |
|---|---|---|
| enabled per (key,endpoint) | Không | Cột + enforcement unknown/disabled fail-closed |
| parameters {value,isLocked} + merge 400-khi-lock | Không | Schema + merge trong seam + golden test same-value-400 |
| jobPriority → BullMQ | Không | Cột + ánh xạ 20/10/1 lúc enqueue |
| allowedFileExtensions | Không | Cột CSV + enforce tại upload/test path |
| fileUrlAuthConfig mã hóa | Không | Cột AES-GCM + decrypt đúng lúc download (SSRF path giữ nguyên) |
| connectionsOverride ConnStep[] | Chỉ slot→connector pin | Mở rộng bindings giữ tương thích `renderPinnedBindings` |
| prompt override key-4 (PAR-13) | Không | Bảng + CRUD + áp lúc resolve prompt (precedence Code>Profile>Connector) |
| publish/rollback + revision pin | createRevision append-only | Version pointer + rollback action + snapshot pin cho op cũ |
| scoped user (requireProfileAccess) | session/role thô, thiếu assignment | Bảng assignment + gate per-action + stage sau VFY-LOCAL |
| Test Endpoint thật | Không | Quyết định port tối thiểu (T-UI-06) |
| Bulk save | Không | Dispatcher batch + UI song song |
