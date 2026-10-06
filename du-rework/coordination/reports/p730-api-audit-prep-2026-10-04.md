# RESUME POINT — qwen_3 / P730-API-PREP (READ-ONLY)

- Packet: `coordination/dispatch-specs/2026-10-04-1835-P730-API-PREP.md` (run_069ecd6957cd, task_787eda7488).
- Lease (write set): CHỈ file này. Source/test: 0 byte sửa đổi. Không commit, không push, không DB window.
- Trạng thái: **HOÀN TẤT phần khảo sát**. 0 lệnh test được chạy (packet READ-ONLY, không có RUN REQUEST).
- Bước sau: P730-ADMIN-MUTATE (W3) integration — chờ W1 checkpoint (b) + publish/CAS invariant.
- Ghi chú write-set: lane ledger `reports/qwen3.md` KHÔNG được sửa vì packet giới hạn write set đúng một file này.

## 1 —CYCLE: Map T-API-01..03 + T-AUD-01 (read-only prep)

Toàn bộ file:line dưới đây đọc trực tiếp ở checkout hiện hành (branch `codex/fix-workflow-builder`), không lấy từ memory.

### 1.1 BFF surface hiện có (`services/orchestrator/src/app/admin/bff/`)

| Route BFF | Method | Handler | Fence hiện hành |
|---|---|---|---|
| `/admin/api/session` | GET | `handle.ts:74` handleBffRequest → handleSession | không cần fence, trả principal server-side |
| `/admin/api/audit` | GET | `handle.ts` handleAudit | `authorizeAuditTenantRead` (`rbac.ts`) + tenant từ SESSION |
| `/admin/api/api-keys[/:id]` | GET | handleApiKeys | như trên |
| `/admin/api/connectors/:id/revisions/:rev` | GET | handleConnectorRevision | `credentialFor` fail-closed |
| `/admin/api/profiles/:b/:v/:n` | GET | `profiles.ts:36` matchProfilesRoute → detail | viewer/scoped bị chặn `PROFILE_SCOPE_GATE` |
| `/admin/api/profiles/.../upsert|publish|rollback` | POST | `profiles.ts:194,201,209` | admin + platform + CSRF, forward `POST /api/v1/admin/actions` |
| `/admin/api/profiles/test-endpoint` | POST | `profiles.ts:162` | forward `POST /api/v1/admin/profile-test-endpoint` (route platform CHƯA tồn tại) |
| `/admin/api/businesses/:id/versions/:v/:action` | PUT | `operations.ts` | admin + CSRF, PUT as-is |
| `/admin/api/crypto-config` | GET/POST | `security.ts` | đọc: tenant fence; ghi: admin + platform + CSRF |
| `/admin/api/actions` | POST | `handle.ts` handleActions | role admin + principal platform + CSRF, ID-Key clamp 200 |

Kết luận kiến trúc: BFF đã là **lớp fence hoàn chỉnh** (authn server-side + CSRF + tenant + credential selection).
Nó KHÔNG chứa business logic và không cần sửa cho T-API-02/03, vì action là chuỗi passthrough (`handle.ts` validate `^[a-z][a-z0-9_.]*$`, dài tối đa 128).

### 1.2 Platform mutation surface (`src/http/routes/admin.ts`, `src/modules/admin-actions/`)

- `POST /api/v1/admin/actions` = **một composition point duy nhất** cho mutation admin: `admin.ts:296-341`, deps dựng inline tại `admin.ts:324-337`, gọi `dispatchAdminAction` (`dispatcher.ts:309`).
- Bảng action thật (`dispatcher.ts:97-127`) — 12 action ĐÃ dispatch: business.enable/activate/drain, operations.sweep-deadlines/cancel/resume, apikey.bind-profile/issue/revoke, connectors.rotate_credential/revoke_credential/test_credential.
- **7 action ĐÔNG ĐÓNG hợp đồng nhưng CHƯA dispatch** (`docs/21-openapi.json:1755-1763`, `packages/contracts/src/profile-policy.ts:477-485`): profile.upsert, profile.publish, profile.rollback, prompt-override.upsert, prompt-override.delete, assignment.grant, assignment.revoke. Hôm nay chúng trả 404 `unsupported` (`dispatcher.ts:770`).
- T-PROF-03 publish/CAS **đã có ở tầng service**: `modules/profiles/publish.ts:127` createProfileRevisionService, `publishRevision:138` (expectedRevision BẮT BUỘC), `rollbackTo:151`, lock `SELECT ... FOR UPDATE` trong `moveActiveRevision`, stale CAS → 409 `REVISION_CONFLICT` (`publish.ts:170`).
- T-API-01 read route **đã có nhưng là placeholder**: `admin.ts:419-455` trả `revision: 0`, `currentValues: {}`, `capabilities: []` từ manifest. `docs/21-openapi.json:2663` ghi rõ contract-frozen-not-dispatched.

### 1.3 T-AUD-01 — principal thật trong audit ledger

**Hiện trạng ĐO ĐƯỢC (không suy diễn):**

1. `AuditRecordInput.actor` là `text NOT NULL` (`audit.ts:43`, `migrations/0010_admin_audit.sql:28`). Bảng `admin_audit_events` KHÔNG có cột nào cho principal id / role / issuer — chỉ `tenant_id`, `actor`, `acted_at`... thực tế là `tenant_id, actor, action, resource, severity, correlation_id, created_at`.
2. Dispatcher quy diễn actor tại `dispatcher.ts:305` `actorOf()`: bearer → chuỗi `admin`; cookie → `shell:<role>`. Đây đúng là chuỗi mà task T-AUD-01 cấm.
3. Năm route inline cũ ghi cứng `actor: admin` — `admin.ts:81, 108, 136, 206, 280`. Bootstrap ghi `actor: platform` (`app/bootstrap/create-app.ts:484`).
4. **Precedent tốt nhất đã tồn tại**: `app/admin/crypto-config-api.ts:171-177` `actorFor()` → `admin:platform` / `admin:tenant_operator`, cho phép override qua `options.actorLabels` (`crypto-config-api.ts:90`). Vẫn KHÔNG phải principal id, nhưng là khuôn đang chạy thật.
5. **Dữ liệu principal ĐÃ CÓ SẴN nhưng không tới được ledger**: `SessionRecord` có `issuer` + `sub` + `role` + `tenantId` (`modules/auth/session-store.ts:36-47`), và `oidc-flow.ts:227` ghi `sub` lúc tạo session. Nhưng seam `AdminSessionView` (`rbac.ts`) chỉ lộ `role`, `csrfToken`, `tenantId`, `issuer` — **KHÔNG có `sub`**. Vì vậy `AdminActionCookieAuth` (`rbac.ts`) không thể mang principal id xuống dispatcher.

**Kết luận T-AUD-01 = CÒN THIẾU, và thiếu ở 3 tầng (không phải chỉ đổi chuỗi format):**

| Tầng | Thiếu gì | Nơi phải sửa |
|---|---|---|
| Store view | `sub` không đi qua `AdminSessionView` → MẤT danh tính sau bước resolve | `rbac.ts` `AdminSessionView`, `resolveAdminActionAuthAsync` |
| Gate | `AdminActionAuth` (cookie branch) không có field principal | `rbac.ts` `AdminActionCookieAuth`, `dispatcher.ts:291 principalOf`, `:305 actorOf` |
| Ledger | `admin_audit_events` không có cột principal/role; `actor` là free text | migration mới + `audit.ts` `AuditRecordInput` |

Ràng buộc tương thích: `toAuditWire` (`audit.ts:88`) và `audit-section-data.ts:402` render `actor` cho UI; đổi format actor làm đổi nội dung hiển thị, và mọi test pin chuỗi cũ phải cập nhật cùng lúc. `admin.ts` đang đọc ledger theo tenant-scoped page (`admin.ts:660-695`) — không đổi schema đọc nếu chỉ thêm cột.

## 2 — principal / CSRF / CAS / idempotency / tenant: ĐÃ CÓ vs CÒN THIẾU

### 2.1 ĐÃ CÓ (pin bằng file:line tại checkout hiện hành)

- **Authn ba tầng máy, thứ tự bắt buộc**: bearer platform/tenant_operator -> `du_session` (opaque, server-side store) -> legacy `du_admin` chỉ khi KHÔNG có `du_session` (`rbac.ts` resolveAdminActionAuthAsync; bản BFF riêng `bff/context.ts` resolveBffContext). Session chết = 401, không downgrade. Bearer so sánh constant-time; tenantAdminTokens chỉ quét own entries chống prototype-pollution (`rbac.ts` resolveAdminPrincipal).
- **CSRF trước role** (`dispatcher.ts` assertRoleActionTenant): auth(401) -> action-table(404) -> CSRF(403) -> role(403) -> operator phải có tenant server-side(403) -> tenant binding(403). Thiếu CSRF trả 403 `PERMISSION_DENIED` + event `auth.csrf_denied` qua sink tiêm được; gate không I/O.
- **CAS profile publish/rollback** (`modules/profiles/publish.ts`): `moveActiveRevision` SELECT ... FOR UPDATE trên pointer; stale `expectedRevision` -> 409 `REVISION_CONFLICT`; rollback target sai -> composite FK 23503 bị DB từ chối; `pinActiveRevision` INSERT..ON CONFLICT. T-DB-02: `createRevision` (`profiles.ts:327-405`) ghi row mới + re-pin pointer CÙNG transaction (`profiles.ts:398`).
- **Idempotency** (`modules/idempotency/idempotency.ts` executeIdempotent): marker `admin_idempotency` (migration 0012) nằm cùng tx với mutation + audit qua withMarker; key trùng payload khác -> 409 `IDEMPOTENCY_CONFLICT`; race first-request -> loser replay phản hồi của winner.
- **Transaction boundary chuẩn**: `auditedMutation` (`audit.ts`) = mutate + audit INSERT + idempotency marker trong ĐÚNG một `db.tx`; audit fail thì mutation rollback (R3-01). Action có external side effect (connectors.rotate/revoke) dùng `deps.db.tx` trực tiếp vì Vault write ngoài DB.
- **Tenant fence**: `authorizeAuditTenantRead` cho READ (`rbac.ts`); `assertRoleActionTenant(auth, action, resourceTenantId)` với resource tenant đọc từ DB (không phải claim caller) — `apikey.revoke` SELECT row rồi fence, foreign/unknown không phân biệt được; `operations.cancel/resume` resolveOpTenant rồi fence lần hai trong tx; `apikey.issue` fence trước INSERT.

### 2.2 CÒN THIẾU (điều kiện cho P730-ADMIN-MUTATE)

1. **7 action dispatcher** (profile.*, prompt-override.*, assignment.*): params schema đã freeze trong `@du/contracts` (`profile-policy.ts:442,460,471` và các PromptOverride*/UserProfileAssignmentParams) — thiếu case trong switch của `dispatchAdminAction` và dòng trong `ADMIN_ACTIONS`.
2. **Principal id xuống ledger** (T-AUD-01): ba tầng thiếu, xem mục 1.3.
3. **Bảng role cho 7 action profile**: BFF đã gate admin+platform+CSRF (`bff/profiles.ts`); khi mở dispatcher phải chốt bearerRoles/cookieRoles — đề xuất admin-only toàn bộ, cùng lý do OIDC-03 như `apikey.*` (credential write).
4. **profileName -> profileId**: `ProfileKey` (businessId/businessVersion/profileName) không map 1-1 tới `profile_bindings.profile_id` uuid — không có bảng name-mapping, `CreateBindingInput` nhận `profileId` optional (`profiles.ts:133`). Đây là quyết định schema (có thể cần migration) — ghi ở Δ2.

## 3 — Đề xuất leaf modules / routes + transaction boundaries

Nguyên tắc: KHÔNG đụng `src/server.ts`, `src/modules/admin-actions/dispatcher.ts`, hay `src/modules/profiles/**` khi W1 còn active (lease packet). Các leaf dưới đây là **đề xuất**, đường dẫn mới, không sửa file đang có lease.

### 3.1 Leaf module mới cho slice Profile mutation

- `src/modules/admin-actions/profile-actions.ts` — leaf thuần (chỉ import `@du/contracts`, `profiles/profiles`, `profiles/publish`, `http/errors`). nhiệm vụ: parse params bằng `ProfileUpsert/Publish/RollbackParamsSchema` (fail-closed 422 INVALID_SCHEMA), resolve (businessId, businessVersion, profileName) -> profileId (xem Δ2), rồi gọi primitive đã tồn tại: `profiles.createRevision(input, client)` / `revisions.publishRevision({profileId, expectedRevision}, client)` / `revisions.rollbackTo(...)`).
- **Re-export seam** `PROFILE_ACTIONS: Record<string, ActionDef>` từ leaf này; khi W1 release lease, dispatcher chỉ thêm 3 case mỏng + spread bảng role — không logic trong switch.

### 3.2 Transaction boundary đề xuất (bắt buộc, không tùy chọn)

- Mọi action mutation đi qua `auditedMutation(db, audit, mutate, auditOf, afterWithMarker)` — cùng pattern 12 action hiện hành (`dispatcher.ts:340-760`).
- `mutate(client)` **phải nhận client** và chuyển xuống service: `createRevision(input, client)` đã hỗ trợ (`profiles.ts:327,404` `activeClient ? run(activeClient) : db.tx(run)`); `publishRevision`/`rollbackTo` cùng chữ ký `client?` (`publish.ts:138-160`). Nếu quên client, service tự mở tx riêng -> **audit row VÀ mutation không còn nguyên tử** (đúng loại lỗi R3-01 đã sửa cho resume ở cycle-99).
- Với `prompt-override.upsert/delete`: repo `createPromptOverrideService(db)` (`prompt-overrides.ts:68`) **chưa nhận client** — cần seam `client?` trước khi nối dispatcher, nếu không sẽ có committed mutation không có audit row. Ghi ở Δ3.
- Với `assignment.grant/revoke`: bảng `user_profile_assignments` (migration 0026 section 4) FK RESTRICT cả hai phía; gate truy cập thuộc T-AUTH-03/VFY-LOCAL đang **fail-closed có chủ đích** — action này chưa được phép mở trong P730-ADMIN-MUTATE.

### 3.3 Route/BFF: không cần thêm endpoint mới

- BFF `bff/profiles.ts` và `bff/handle.ts` đã forward đúng action + params + Idempotency-Key + CSRF. **Không sửa** cho T-API-02.
- `GET /admin/api/profiles/:b/:v/:n` forward tới `GET /api/v1/admin/profiles/...` (route placeholder `admin.ts:419`). T-API-01 = thay body projection của route ĐÓ bằng dữ liệu thật (revision từ `getEffectiveRevision` `publish.ts:62`, policy từ row active) — đường dẫn route không đổi, client không đổi (fetcher `ProfileManifestWireRow` đã freeze theo `21-openapi.json:948`).
- `POST /api/v1/admin/profile-test-endpoint` (T-UI-06) **chưa tồn tại ở platform** (BFF forward -> 404 relays, pin ở `tests/aweb04-bff-profiles.test.ts:103`). Route thật là follow-up riêng, ngoài phạm vi packet này.

## 4 — DTO + error examples

Envelope lỗi dùng `problem()` RFC 9457 của `@du/contracts` (`packages/contracts/src/errors.ts:106-114`): BFF **không bao giờ** echo upstream body; 4xx giữ status+code và lọc `errors[]` (tối đa 50, pointer<=128), 5xx塌 xuống cố định 502 `UPSTREAM_ERROR` (`bff/envelope.ts` upstreamProblem).

### 4.1 profile.publish (CAS) — ví dụ đầy đủ

Request (BFF -> platform, do `bff/profiles.ts` dựng):
```
POST /api/v1/admin/actions
authorization: Bearer <platform admin token>
idempotency-key: 8-200 printable ASCII
{ "action": "profile.publish",
  "params": { "businessId": "invoice", "businessVersion": "1.0.0",
              "profileName": "extract.invoice", "expectedRevision": 7 } }
```
Thành công: 200/202, BFF bọc `{"data": ...}` cho `/actions` (`relayUpstream` wrapInData).
CAS thất bại (revision đã trôi): 409 `REVISION_CONFLICT` — message hiện hành `publish.ts:104` ghi `expected active revision 7 but the profile is at 9`.
```
{ "type": "urn:du:error:revision_conflict", "title": "The admin API rejected the request",
  "status": 409, "code": "REVISION_CONFLICT",
  "detail": "expected active revision 7 but the profile is at 9",
  "correlationId": "b7f0..." }
```
Lệch tenant (operator tác động profile tenant khác): 403 `PERMISSION_DENIED` / `mutations are scoped to the caller tenant` — cùng wording cho foreign và unknown (`dispatcher.ts` tenant binding).

### 4.2 Bảng mã lỗi nên có cho slice Profile (đã freeze, `profile-policy.ts:493-509`)

| Code | Status | Khi nào |
|---|---|---|
| PROFILE_LOCKED_FIELD | 400 | client gửi param đã khoá, kể cả giá trị giống hệt |
| PROFILE_UNKNOWN_FIELD | 400 | param không có trong manifest |
| PROFILE_FORBIDDEN | 403 | endpoint tắt, hoặc scoped-user ngoài assignment |
| PROFILE_NOT_FOUND | 404 | không có profile cho (key, business, version, action) |
| REVISION_CONFLICT | 409 | expectedRevision != active revision |
| PROFILE_SLUG_UNKNOWN | 422 | slug không có trong manifest (`admin.ts:441` manifest read hiện chỉ 404 NOT_FOUND — xem Δ5) |
| PROFILE_EXTENSION_DENIED | 422 | extension ngoài allowedFileExtensions |
| INVALID_SCHEMA | 422 | params fail schema (`.strict()` -> unknown key bị từ chối) |
| IDEMPOTENCY_CONFLICT | 409 | cùng key, payload/route khác |

**Lưu ý chưa khớp (Δ5)**: bảng trên là mã do `@du/contracts` khai báo, còn HTTP mapper hiện hành (`http/errors.ts` + `upstreamProblem`) chỉ relay đúng code字符串 nếu match `^[A-Z0-9_]{3,64}$`; PROFILE_* chưa xuất hiện ở bất kỳ throw site nào trong `services/orchestrator/src` (grep 0 hit ngoài contracts). Khi P730-ADMIN-MUTATE implement, các code này phải được throw thật để UI branches (`profiles-screen.tsx`) hoạt động.

## 5 — Composition points (nơi sẽ nối mutation + audit cùng transaction)

| # | Điểm nối | file:line | Vai trò |
|---|---|---|---|
| C1 | `handleAdminRoutes` -> `POST /api/v1/admin/actions` | `http/routes/admin.ts:296-341` | DUY NHẤT một HTTP entry cho admin mutation; deps dựng inline tại :324-337 |
| C2 | `dispatchAdminAction` switch | `modules/admin-actions/dispatcher.ts:309, 340-770` | thêm 3 case profile tại đây (sau lease release) |
| C3 | `auditedMutation` | `modules/audit/audit.ts:141-158` | ranh giới transaction duy nhất: mutation + audit + marker |
| C4 | `executeIdempotent` + `withMarker(client, resp)` | `modules/idempotency/idempotency.ts:130-190` | marker phải nằm trong tx của C3 |
| C5 | `profiles.createRevision(input, client)` | `modules/profiles/profiles.ts:327-405` | INSERT revision + `pinActiveRevision` cùng tx (:398) |
| C6 | `profileRevisionService.publishRevision/rollbackTo(.., client)` | `modules/profiles/publish.ts:138-160` | CAS pointer move, FOR UPDATE serialize |
| C7 | `resolveAdminActionAuthAsync` -> `AdminActionCookieAuth.tenantId` | `rbac.ts` | điểm DUY NHẤT mà principal id (sub) có thể chui vào auth context cho T-AUD-01 |
| C8 | `actorOf` / `principalOf` | `dispatcher.ts:291, 305` | điểm duy nhất sinh chuỗi `actor` của ledger |
| C9 | BFF `handleActions` + `bff/profiles.ts` mutations | `bff/handle.ts:296-...`, `bff/profiles.ts:130-215` | CSRF gate phía browser, clamp Idempotency-Key |

## 6 — Δ-DEVIATION (chờ Coordinator phân xử; tôi KHÔNG tự tick gate)

- **Δ1 (T-AUD-01, cần quyết định schema)**: để actor là principal id thật thì phải sửa đồng thời 3 tầng: `AdminSessionView` thiếu `sub` (`rbac.ts`), `AdminActionCookieAuth` không có principal, `admin_audit_events` không có cột principal/role (`migrations/0010_admin_audit.sql:25-33`). Chọn (a) nhét `iss:sub` vào `actor` text (0 migration, đổi hiển thị UI, không query được theo principal), hay (b) migration thêm cột `actor_kind/actor_id/actor_tenant_id` (query được, cần CONV/Docs cập nhật docs-28/35 và `toAuditWire` `audit.ts:88`). Đề xuất: (b), vì T-AUD-01 nói rõ principal kèm role/tenant.
- **Δ2 (schema, chặn T-API-02)**: không có chỗ lưu `profileName`. Cần quyết định: hoặc thêm cột `profile_name` vào `profile_bindings` + unique (business_id, business_version, action, profile_name) (migration 0028+), hoặc định nghĩa profileName == action slug và map profileId từ (api_key_id, business, version, action). Tôi **không** chọn hộ — cả hai đều đổi schema/semantics đang chạy (0004 PK là (profile_id, revision), `CreateBindingInput` nhận profileId optional).
- **Δ3 (nguyên tử, chặn prompt-override.*)**: `createPromptOverrideService` (`prompt-overrides.ts:68`) không nhận `PoolClient`. Nối dispatcher mà không thêm seam `client?` = mutation commit trước khi audit row ghi -> đúng cái R3-01 cấm. Cần lease owner `modules/profiles` thêm chữ ký trước.
- **Δ4 (idempotency key hai chuẩn)**: BFF clamp im lặng 200 byte (`bff/profiles.ts` clampKey / `handle.ts` MAX_IDEMPOTENCY_KEY_LENGTH), platform route 422 khi sai chuẩn `^[!-~]{8,200}$` (`idempotency.ts` readIdempotencyKey). Hệ quả: key 5 ký tự qua BFF im lặng -> platform 422 (hành vi đúng nhưng gây khó); key chứa ký tự ngoài in được bị BFF cắt rồi platform vẫn có thể 422. Đề xuất: BFF validate trước và trả 422 với cùng message, thay vì cắt.
- **Δ5 (ĐÃ ĐÍNH CHÍNH 2026-10-04, sau khi ghi)**: tôi từng viết "7 code PROFILE_* chưa có throw site" — **sai**, tôi grep thiếu. Đo lại: `PROFILE_LOCKED_FIELD` và `PROFILE_UNKNOWN_FIELD` THẬT sự throw ở `modules/profiles/policy.ts:136,143` (HttpError 400); `PROFILE_EXTENSION_DENIED` throw ở `modules/operations/submission.ts:790,801,816` (unprocessable 422). CÒN thiếu throw site: `PROFILE_FORBIDDEN`, `PROFILE_NOT_FOUND`, `PROFILE_SLUG_UNKNOWN` (0 hit trong src). Hệ quả còn lại của Δ5: route profile read trả 404 `NOT_FOUND` cho slug lạ (`admin.ts:441`) trong khi UI mong `PROFILE_SLUG_UNKNOWN` 422 — vẫn phải sửa khi implement T-API-01.
- **Δ6 (assignment.* ngoài phạm vi)**: `user_profile_assignments` là storage của T-AUTH-03/VFY-LOCAL, tài liệu ghi rõ chưa được phép đọc để cấp quyền. `assignment.grant/revoke` nằm trong danh sách 7 action pending nhưng gate còn NO-GO -> đề xuất tách khỏi P730-ADMIN-MUTATE.

## 7 — Trạng thái kết thúc packet

- Loại: READ-ONLY. **0 byte** sửa đổi ngoài file receipt này. Không chạy test (không có RUN REQUEST trong packet), nên không có Exit Code literal để dẫn — mọi phát biểu trên là bằng chứng đọc trực tiếp tại `codex/fix-workflow-builder` HEAD, kèm file:line để Reviewer kiểm lại độc lập.
- Điều kiện kích hoạt bước sau theo packet: W1 CHECKPOINT (a) cho API prep; **integration** P730-ADMIN-MUTATE chờ checkpoint (b) + publish/CAS invariant.
- Việc của Coordinator khi dispatch P730-ADMIN-MUTATE: phân xử Δ1..Δ6 (Δ2 và Δ3 là blocker kỹ thuật thật, không phải cosmetic), cấp lease `dispatcher.ts` + `modules/profiles/**` + migration mới cho đúng một writer.
