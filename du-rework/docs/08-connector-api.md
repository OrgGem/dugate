# Connector service spec

## SC-04 / CB-05 — Secrets và callback contracts (2026-10-06)

Generated spec: [21-openapi.json](21-openapi.json), nguồn [generator](../tools/openapi/gen_openapi.py) và canonical `secret-catalog.ts` / `profile-callback.ts`. Không hand-edit JSON. Các Secrets routes là **Portal BFF origin 3001**, không phải Connector 8080 hoặc Internal JSON 3002: GET `/admin/api/secrets`, POST `/admin/api/secrets/{secretId}/rotate`, `/disable`, `/test`. Session cookie `du_session`; mutations yêu cầu platform-admin + `x-csrf-token`. Tenant operator không được widen tenant. Reads chỉ metadata, không có plaintext resolve API. Literal write-only dùng `{kind:'literal', value:...}`; catalog reference dùng `{kind:'secret_ref', secretId:uuid}`. Managed create cần literal; Vault locator cấm value và bắt buộc explicit pinned/latest version. Rotate/disable dùng CAS `expectedRevision`; BFF lấy secretId từ path.

**Current implementation gaps:** upstream `/api/v1/admin/secrets*` chưa có router/repository API trong snapshot này; BFF có thể trả 404/503, không phải live catalog đã hoạt động. POST `/admin/api/secrets` hiện trả 405 vì matcher chọn list và method gate chỉ cho GET; nhánh create có DTO nhưng unreachable. SC owner cần sửa dispatch và triển khai upstream, VFY cần verify no-readback/tenant/CAS/storage. Generated spec ghi unavailable trung thực, không thêm upstream endpoints giả.

Callback Policy là contract của Orchestrator, không tạo route mới tại Connector. `policy.callbackPolicy` editor gửi profile upsert nhưng field chưa có trong canonical profile/admission schema; production callback secret resolver và admission pin writer còn thiếu theo CB-02 receipt. Các model OpenAPI không đồng nghĩa plumbing hoặc live delivery đã hoàn tất.

- `notification_only` giữ event envelope legacy; `notification_with_result` dùng `CallbackResultEnvelope`: inline ≤256 KiB, body ≤512 KiB, ≤32 artifact descriptors. Artifact là authenticated relative `/api/v1/...` path + `expiresAt`, không bytes/raw storage URL; null result có `OVERSIZED`, `EXPIRED`, `UNAVAILABLE` hoặc `ENCRYPTED_ONLY`, không truncate.
- Receiver dedup theo `x-du-delivery-id`; retry at-least-once replay immutable terminal payload/occurredAt, manual resend không gia hạn expiry. HMAC signing headers tiếp tục áp dụng; result mode không tự thêm deliveryId vào strict body. Wire encryption envelope nếu được bật vẫn áp dụng theo delivery encryption contract.
- Auth: none / configured_headers / oauth2_client_credentials; credential auth phải có approved exact HTTPS origin/path scope, redirects denied. OAuth2 secret là `{kind:'managed-secret', ref:...}`, không plaintext; lifetime omitted nghĩa acquire per delivery. Format này khác catalog `secret_ref`; consumer mapping/resolution còn cần implementation, không coi hai dạng là interchangeable. Reserved/duplicate/injected headers, private destinations và invalid policies phải fail closed.

Status: generator/docs IMPLEMENTED, không thay independent VFY-SC/VFY-CB, storage encryption, real Vault/HTTPS receiver hoặc backend review acceptance. Canonical Zod refinements vẫn authoritative; OpenAPI structural projection đánh dấu `x-runtime-validation` cho các rule không biểu diễn đầy đủ bằng schema.

Base URL là origin của service Connector, ví dụ `http://connector:8080`; các path dưới đây bắt đầu trực tiếp từ `/`, **không có prefix `/internal/v1`**. Chỉ mạng nội bộ + service auth, không có public ingress. Config management do Orchestrator proxy bằng admin authorization riêng; invocation cần worker identity + signed runtime grant.

Nguồn wire: [router Connector](../services/connector/src/http/server.ts:169) dùng `url.pathname` trực tiếp; [client invocation](../packages/connector-client/src/transport.ts:177) và [management proxy](../services/orchestrator/src/modules/connectors/connector-management-store.ts:122) nối các root path vào base URL. Không thêm prefix khi cấu hình `DU_CONNECTOR_BASE_URLS`. `/management/connectors` và `/management/capabilities` không phải alias được router hiện tại hỗ trợ.

## Service identity và audience

Production [entrypoint](../services/connector/src/entrypoint.ts:18) inject `HmacServiceIdentityVerifier`. [Verifier](../services/connector/src/identity.ts:5) kiểm chữ ký HS256 và `exp` nguyên theo epoch seconds; [scope guard](../services/connector/src/identity.ts:43) yêu cầu `aud=connector`, subject không rỗng và scope phù hợp. Header là `Authorization: Bearer <signed JWT>`; `x-service-scope` hoặc một header identity tĩnh không thay chữ ký hay scope trong token.

| Surface thực tế | Service scope | Authorization bổ sung |
|---|---|---|
| `/connectors` và các child routes | `connector:manage` | Admin/tenant/account authorization ở Platform API và binding scope của Connector |
| `/invocations`, `/invocations/{id}`, `/invocations/{id}/cancel` | `connector:invoke` | Runtime invocation grant: trong body khi invoke, `x-invocation-grant` khi get/cancel |
| `GET /capabilities` | `connector:invoke` | Catalog adapter ở Connector; manage-only token bị từ chối |
| `GET /health/live`, `GET /health/ready` | Không cần Bearer | Internal ingress; readiness không gọi provider |

Scope selection là hành vi hiện tại tại [router](../services/connector/src/http/server.ts:178): path bắt đầu bằng `/connectors` dùng manage; các path khác ngoài health dùng invoke. Vì vậy không dùng management token để gọi `/capabilities`. Platform `GET /api/v1/admin/connectors/capabilities` là surface admin riêng, mô tả khả năng management theo composition; không phải alias hay passthrough của catalog adapter `/capabilities`.

Theo [quyết định signed identity](../coordination/reports/codex-arch-unblock-migration-2026-10-05.md), Orchestrator issuer dùng key server-side khớp `SERVICE_IDENTITY_SECRET` của Connector, token `sub=orchestrator-management`, `aud=connector`, `scopes=["connector:manage"]`, `iat=now`, `exp=iat+60`; header provider tạo token mới mỗi management request. Đây là yêu cầu implementation của lane identity, không phải bằng chứng boot đã được nghiệm thu. Không trả key/token cho Portal/browser, không gắn identity này vào public readiness probe. `DU_CONNECTOR_IDENTITY_EXPIRES_AT` ngoài token không thay `exp` do Connector xác thực.

### Threat-model note — HMAC service identity (CR06-05)

- **Tài sản và bề mặt:** `/connectors*` (quản trị revision/credential) và `/invocations*` (gọi provider) chỉ nằm trong mạng nội bộ; threat chính là caller nội bộ bị mạo danh, không phải public ingress.
- **Giả mạo chữ ký:** HMAC-SHA256 trên `encodedHeader.encodedPayload` với secret 32 byte chia sẻ giữa issuer và Connector; [so sánh dùng `timingSafeEqual`](../services/connector/src/contract-grants.ts:30) và từ chối `alg != HS256`. Secret lấy từ `SERVICE_IDENTITY_SECRET` (base64 32 byte) ở [entrypoint](../services/connector/src/entrypoint.ts:18) và không bị log.
- **Replay trong hạn:** token hợp lệ có thể bị phát lại trong TTL (`exp`); chấp nhận có kiểm soát vì token ngắn hạn (`exp=iat+60` cho management issuer) và bị ràng buộc audience/scope. Chưa có `nbf`/`iat`/revocation list — thu hồi dựa trên xoay secret.
- **Nhầm audience/scope:** mọi token phải có `aud=connector`; `/connectors*` cần `connector:manage`, các path khác ngoài health cần `connector:invoke`. Caller thiếu scope nhận 403 `BINDING_DENIED`; thiếu/sai/hết hạn token nhận 401 `GRANT_INVALID`.
- **Fail-closed và carve-out test (CR06-05):** [resolveIdentityVerifier](../services/connector/src/http/server.ts:80) từ chối dựng server khi không có verifier; nhánh `overrides` của composition dùng verifier từ config nếu override không cung cấp. Ngoại lệ duy nhất là `allowUnauthenticatedTestTraffic`: chỉ test harness khai báo tường minh, chỉ được chấp nhận khi chạy dưới test runner (Jest/Vitest) và log cảnh báo mỗi lần kích hoạt; production composition không có đường bật cờ này.
- **Residual risk:** giữ secret đồng nghĩa có thể mint mọi token (symmetric); phải giữ secret trong env/secret manager, xoay định kỳ và vẫn chặn public ingress vào Connector.


## Invocation endpoints

| Method/path | Input | Success |
|---|---|---|
| POST /invocations | InvocationRequest | 200 completed hoặc 202 provider pending/in-flight |
| GET /invocations/{id} | scoped auth | 200 state/result/usage; 404 inaccessible |
| POST /invocations/{id}/cancel | reason | 202 best-effort cancellation |
| GET /capabilities | service auth | 200 adapter capability catalog |
| GET /health/live, /health/ready | internal probe | 200 hoặc 503 |

```json
{
  "contractVersion": "1",
  "invocationId": "runtime-issued-id",
  "grant": "signed-short-lived-token",
  "operationId": "uuid",
  "taskId": "uuid",
  "stepKey": "extract-invoice",
  "bindingSlot": "reasoning",
  "input": {
    "prompt": "Extract the requested invoice fields.",
    "text": "optional text",
    "artifacts": [{ "artifactId": "uuid" }],
    "outputSchema": { "type": "object" }
  },
  "options": { "temperature": 0 },
  "sessionRef": null,
  "deadlineAt": "2026-09-20T00:05:00Z"
}
```

Grant binds tenant, operation/task/step, invocationId, inputHash, connector revision, allowed options/model, artifact IDs, expiry và audience Connector. Không chấp nhận worker đổi connector URL/headers/auth bằng input fields. Connector so sánh canonical hash payload và grant; refresh expired grant giữ invocationId nếu logical request không đổi.

Response: `{invocationId,state,result:{content?,data?,artifacts?,sessionRef?},usage:{inputTokens,outputTokens,pages,costMicrousd,measurement},providerRequestId?,nextPollAt?,sessionRef?,error?}`. Output lớn lưu object rồi finalize artifact qua service-scoped runtime grant. `sessionRef` là artifact/opaque reference có quyền; không giữ session bắt buộc trong RAM.

## Idempotency và deadline

Same invocationId+same inputHash trả trạng thái/kết quả đã biết; khác hash 409. Concurrent calls dedup bằng durable ledger + lease. Check ledger trước provider dispatch. Crash sau provider nhận request tạo UNKNOWN nếu adapter không reconcile được; không tự ghi FAILED rồi gọi lại ngay.

Business retry được SDK/runtime quyết định. Connector v1 không tự retry provider request không idempotent; trả error classification/retryAfter. Adapter có thể retry kết nối khi chứng minh chưa gửi request hoặc provider hỗ trợ idempotency, phải dùng budget chung và ghi attempt.

HTTP deadline không kéo dài operation deadline. Provider async trả 202 và nextPollAt; business task lưu invocationId rồi delayed continuation, không giữ worker slot lâu. Polling không tạo inference mới.

### Async 202 và sessionRef (CR06-04)

Quyết định contract: provider **được phép** trả `sessionRef` ngay trong body 202 accept (không bắt buộc — provider vẫn có thể chỉ trả ở result cuối). Khi 202 có `sessionRef`, Connector:

- coi `null`/vắng là "không có session mới"; chuỗi non-empty được nhận; giá trị sai kiểu/chuỗi rỗng fail-closed `INVALID_PROVIDER_RESPONSE` (không lưu gì);
- persist vào pending record (`connector_invocations.session_ref`, migration `009_connector_invocation_session_ref.sql`) và trả ở top-level `sessionRef` của mọi response PENDING kể cả khi replay trước `nextPollAt`;
- re-attach session đã lưu vào provider request ở lần poll đến hạn, giữ nguyên `Idempotency-Key`/invocationId/inputHash cũ — polling không tạo inference mới và không blind-retry;
- nếu provider không trả `sessionRef` ở kết quả cuối, session đã lưu được giữ làm continuation; `result.sessionRef` do provider trả vẫn thắng (provider có thể xoay session khi hoàn tất).

Worker-sdk: `classifyInvocation` mang session lên `pending-yield`, `PendingInvocationError.sessionRef` giữ token như một property (không vào message/log); resume sau yield dùng lại đúng invocationId và Connector tự khôi phục session từ pending record. Live provider-session semantics vẫn thuộc live window (`LIV-SS-01`).

## Error taxonomy

| Code | HTTP | Runtime policy |
|---|---|---|
| INVALID_INPUT / CAPABILITY_UNSUPPORTED | 422 | Permanent |
| GRANT_INVALID | 401 | Permanent/security audit; missing/invalid signature or expiry |
| BINDING_DENIED | 403 | Permanent/security audit; audience or scope denied |
| CREDENTIAL_INVALID / CONNECTOR_DISABLED | 422/503 | Không blind retry; operator fix |
| PROVIDER_RATE_LIMITED | 429 | Retry theo Retry-After và deadline |
| PROVIDER_UNAVAILABLE | 503 | Retry nếu outcome xác định an toàn |
| PROVIDER_TIMEOUT | 504 | Phân biệt not-sent / UNKNOWN |
| PROVIDER_REQUEST_REJECTED | 502 | Provider đã nhận yêu cầu và **từ chối** (4xx): task discriminator lạ, schema bị từ chối, hoặc auth. Không retry — lỗi nằm ở phía gọi/cấu hình, không phải sự cố provider |
| INVALID_PROVIDER_RESPONSE | 502 | Provider trả 200 nhưng body không khớp contract. Business quyết định repair hoặc fail |
| INVOCATION_UNKNOWN | 409 | Reconcile/manual policy |
| INPUT_HASH_MISMATCH | 409 | Permanent |

Lỗi không chứa secret, raw Authorization header hay full provider body mặc định.

## Management endpoints

| Method/path | Success | Nguồn router |
|---|---|---|
| GET `/connectors` | 200 redacted revisions | `http/server.ts:164` |
| POST `/connectors` | 201 revision | `http/server.ts:168` |
| POST `/connectors/{id}/revisions` | 201 pending revision | `http/server.ts:202` |
| POST `/connectors/{id}/revisions/bootstrap` | 201 revision + replayed | `http/server.ts:230` |
| POST `/connectors/{id}/revisions/{revision}/activate` | 200 activated; 409 CAS conflict | `http/server.ts:255` |
| POST `/connectors/{id}/revisions/{revision}/retire` | 204 | `http/server.ts:273` |
| GET `/connectors/{id}/revisions/current` | 200 redacted revision; 404 absent | `http/server.ts:282` |
| GET `/connectors/{id}/revisions/{revision}` | 200 redacted revision; 404 absent | `http/server.ts:288` |
| POST `/connectors/{id}/credentials/rotate` | 204 write-only | `http/server.ts:335` |
| POST `/connectors/{id}/test` | 200 provider test outcome | `http/server.ts:349` |
| POST `/connectors/{id}/disable` | 204 | `http/server.ts:344` |

Không có handler `GET /connectors/{id}`. Dùng revision/current hoặc revision cụ thể; GET trả metadata đã redacted, secret write-only. `POST /connectors/{id}/test` là provider test và khác với public readiness `GET /api/v1/connectors/{id}/test` → Connector `/health/ready`.

Luồng quản trị: Portal/BFF → Platform `/api/v1/admin/connectors` hoặc admin action → management store → Connector `/connectors/...`. Platform xác thực admin/CSRF/RBAC và tenant trước khi gọi service; Connector kiểm Bearer management identity, không nhận forwarded caller credentials. Workflow credentials chưa được cấu hình trả `503 TEMPORARY_UNAVAILABLE` ([admin handler](../services/orchestrator/src/http/routes/admin.ts:252)); capabilities phụ thuộc composition, không suy ra chức năng available chỉ từ việc route tồn tại. Tài liệu này không thay public wire hoặc legacy route precedence.

Config revision gồm adapter ID, base URL, request mapping, response mapping, timeout, capability declarations, provider account/quota key và credential reference. Mapping là declarative được validate, không eval JS. Generic multipart/json adapter đủ v1; native provider SDK adapter là extension khi có nhu cầu xác định.

## Provider limiting

Limit theo provider account + quota domain/model, áp dụng chung mọi Connector replica. Redis atomic acquire/release với lease expiry; hỗ trợ max in-flight và request rate. Token budget dùng estimate/reservation và reconcile actual, không coi request rate là token rate. Quota exhausted trả 429 sớm; không tạo hàng đợi RAM vô hạn trong Connector.

## Usage ownership

Connector tạo immutable usage event cho từng actual provider attempt, kể cả usage sau cancel hoặc failed response khi provider báo có tính phí. Same event ID không ghi lại. Platform dedup projection; workflow parent chỉ sum. Unknown/estimated cost không hiển thị như measured final. Usage outbox retry được khi Orchestrator unavailable.
