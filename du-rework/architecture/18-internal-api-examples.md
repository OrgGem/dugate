# 18 — Runtime, Admin và Connector API: spec và ví dụ

**Phạm vi:** API giữa process và operator theo [Orchestrator router](../services/orchestrator/src/server.ts), [runtime contract](../packages/contracts/src/runtime.ts), [Connector contract](../packages/contracts/src/connector.ts), [Connector HTTP router](../services/connector/src/http/server.ts) ngày 2026-10-02. Token/ID trong ví dụ là giả; lệnh chưa được chạy trên deployment trong lượt viết tài liệu. Các endpoint nội bộ không dành cho client dùng `x-api-key`.

## 1. Bốn loại danh tính không được hoán đổi

| Caller | Header / nguồn identity | Quyền |
|---|---|---|
| Tenant client | `x-api-key: <tenant-key>` | Public API, tài nguyên đúng tenant/profile. |
| Business worker | `Authorization: Bearer <worker-business-token>` | Runtime route theo business/task; token map ở Orchestrator, không tự khai business qua body để đổi quyền. |
| Operator | `Authorization: Bearer <admin-token>` hoặc cookie session OIDC/local + CSRF | Admin JSON/shell theo role. Cookie mutation phải qua CSRF gate. |
| Connector/service caller | Connector nhận signed service identity có audience `connector`, scope `connector:invoke` hoặc `connector:manage`; invocation còn cần signed grant. Connector gửi usage tới Orchestrator bằng `USAGE_TOKEN` riêng. | Management/invocation/usage, không dùng worker runtime token thay thế. |

Tất cả token là secret của môi trường. Các ví dụ không chỉ cách tự ký token: xem [security/deployment](13-deployment-and-operations.md) và [Connector identity code](../services/connector/src/identity.ts) để cấu hình authority đúng.

## 2. Worker đăng ký và claim task

Worker SDK thường tự gọi runtime; HTTP trực tiếp hữu ích khi viết SDK hoặc kiểm contract. Base URL local `http://127.0.0.1:3000/api/runtime/v1`. `PUT /businesses/{id}/versions/{version}` nhận business manifest và yêu cầu platform runtime authority; worker heartbeat dùng business token. `POST /tasks/{id}/claim` nhận ba field bắt buộc từ `ClaimTaskRequestSchema`:

```bash
curl -i -X POST 'http://127.0.0.1:3000/api/runtime/v1/tasks/22222222-2222-4222-8222-222222222222/claim' \
  -H 'Authorization: Bearer <worker-business-token>' \
  -H 'Content-Type: application/json' \
  --data '{"deliveryId":"delivery-demo-001","workerInstanceId":"worker-demo-01","businessId":"document-core"}'
```

HTTP 200 trả `taskId`, `operationId`, `leaseEpoch`, `leaseExpiresAt`, `attempt`, `deadlineAt`, `executionSnapshot` và `checkpointRefs`. `executionSnapshot` chứa business/version/action, pinned profile/connector bindings, resolved input reference và task kind; không coi job payload Redis là nguồn authority. Claim sai business, task không đúng trạng thái hoặc delivery cũ bị từ chối theo auth/state contract.

Sau claim, worker gửi `POST /tasks/{id}/heartbeat` với `{ "leaseEpoch": 1 }`. Checkpoint step dùng `PUT /tasks/{id}/steps/{stepKey}` với `leaseEpoch`, `inputHash`, `outputRef`, tùy chọn `sessionRef` và `status`; kết quả giống hệt được replay idempotent. `POST /tasks/{id}/complete`/`fail` chỉ hợp lệ khi lease còn hiện hành. Các request/ack chính xác nằm trong [runtime schema](../packages/contracts/src/runtime.ts).

## 3. Cấp invocation grant

Trước khi gọi provider, worker xin grant cho một task/step/slot đã được profile pin. `POST /tasks/{id}/invocation-grants` dùng body `leaseEpoch`, `stepKey`, `bindingSlot`, `inputHash`, `artifactIds` (tối đa bốn ID duy nhất). Route trả HTTP 201 với `grant`, `invocationId`, `connectorId`, `connectorRevision`, `expiresAt`, `allowedOptions` khi grant service được cấu hình; nếu không, HTTP 503.

```bash
curl -i -X POST 'http://127.0.0.1:3000/api/runtime/v1/tasks/22222222-2222-4222-8222-222222222222/invocation-grants' \
  -H 'Authorization: Bearer <worker-business-token>' \
  -H 'Content-Type: application/json' \
  --data '{"leaseEpoch":1,"stepKey":"ocr-source","bindingSlot":"ocr","inputHash":"sha256-of-normalized-input","artifactIds":[]}'
```

`inputHash` ở đây phải bằng hash mà Connector kiểm trên invocation input; một chuỗi mô tả tùy ý như trong ví dụ chỉ minh họa field, không tạo grant dùng được. SDK/contract owner cần tính hash đúng từ input thực và dùng `invocationId` ổn định khi retry transport.

## 4. Connector invocation và polling

Connector standalone mặc định port 8080; dev runner có thể dùng 8088. `POST /invocations` yêu cầu service identity bearer đúng audience/scope **và** signed invocation grant ở body. Body theo `InvocationRequestSchema`:

```bash
curl -i -X POST 'http://127.0.0.1:8088/invocations' \
  -H 'Authorization: Bearer <signed-connector-service-identity>' \
  -H 'Content-Type: application/json' \
  --data '{"contractVersion":"1","invocationId":"invocation-demo-001","grant":"<signed-invocation-grant>","operationId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","stepKey":"ocr-source","bindingSlot":"ocr","input":{"text":"Noi dung tai lieu"},"options":{"maxTokens":512},"deadlineAt":"2026-10-02T03:05:00.000Z"}'
```

Mẫu trên đúng **shape JSON** nhưng chỉ chạy được khi grant thật khớp input hash, task, step, slot, revision và deadline. Khi trả ngay, HTTP 200 có `state: "SUCCEEDED"`; provider async có thể trả HTTP 202 với `state: "PENDING"`, `nextPollAt` và `providerRequestId`. Response contract:

```json
{
  "invocationId": "invocation-demo-001",
  "state": "SUCCEEDED",
  "result": {"content":"Da xu ly","data":{"summary":"..."}},
  "usage": {"inputTokens":12,"outputTokens":8,"costMicrousd":3,"measurement":"measured"}
}
```

`GET /invocations/{id}` và `POST /invocations/{id}/cancel` yêu cầu service identity; request get/cancel còn gửi `x-invocation-grant` để xác nhận quyền đọc/cancel. Cancel cần body `{ "reason": "user requested" }`. State `UNKNOWN` có nghĩa provider outcome mơ hồ; không retry cùng side effect theo suy đoán. Poll/reconciliation và retry phải đi theo ledger/contract của Connector.

Connector management có `/connectors`, `/connectors/{id}/revisions*`, credential rotate/disable/test, cần `connector:manage`. Response management redacts secret. Revision `vault-kv2` còn phụ thuộc Vault resolver trong composition; standalone wiring hiện tại chưa truyền resolver vào runtime, nên không xem ví dụ management là bằng chứng invocation qua Vault hoạt động.

## 5. Connector → Orchestrator usage

`POST /api/runtime/v1/usage-events` chỉ nhận dedicated `USAGE_TOKEN`, không nhận worker token. Body là một `UsageEvent` hoặc batch `{ "events": [...] }` (1–500). Event gồm ID idempotent, invocation/operation/task ID, `units`, `costMicrousd`, `currency='USD'`, `measurement='measured'|'estimated'`, `occurredAt`.

```bash
curl -i -X POST 'http://127.0.0.1:3000/api/runtime/v1/usage-events' \
  -H 'Authorization: Bearer <connector-usage-token>' \
  -H 'Content-Type: application/json' \
  --data '{"events":[{"eventId":"usage-demo-001","invocationId":"invocation-demo-001","operationId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","units":{"inputTokens":12,"outputTokens":8},"costMicrousd":3,"currency":"USD","measurement":"measured","occurredAt":"2026-10-02T03:00:00.000Z"}]}'
```

HTTP 200 trả `{"accepted":["usage-demo-001"],"duplicates":[]}` cho event mới; replay cùng nội dung vào `duplicates`. Cùng `eventId` nhưng nội dung khác là conflict. Usage có thể đến sau operation completion, vì vậy client Public API có thể thấy `measurement: pending` trước.

## 6. Operator Admin API

Admin JSON chủ yếu nằm dưới `/api/v1/admin/*`, khác với `/api/internal/v1` được mô tả như mục tiêu trong một số spec cũ. Route `POST /api/v1/admin/actions` là dispatcher cho mutation có RBAC/CSRF và idempotency. Ví dụ một operator được cấp quyền điều khiển operation của chính tenant:

```bash
curl -i -X POST 'http://127.0.0.1:3000/api/v1/admin/actions' \
  -H 'Authorization: Bearer <platform-admin-token>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: admin-cancel-demo-001' \
  --data '{"action":"operations.cancel","params":{"operationId":"11111111-1111-4111-8111-111111111111"}}'
```

Response tùy action; route bọc `{ "action": "operations.cancel", ... }` quanh body do dispatcher trả. Unknown action là 404, method khác POST là 405, thiếu role/tenant là 403. Cookie session phải kèm CSRF token hợp lệ; bearer token và cookie không có cùng quyền mặc định. Các admin read routes như businesses, profiles, connectors, API keys, audit và crypto config có schema/khả năng khác nhau; xem [catalog](16-interface-catalog.md), [Admin source](../services/orchestrator/src/app/admin/) và [dispatcher](../services/orchestrator/src/modules/admin-actions/dispatcher.ts) trước khi tự động hóa mutation.

## 7. Ma trận phản ứng với lỗi

| Bề mặt | Kiểu lỗi | Hướng xử lý |
|---|---|---|
| Orchestrator public/admin/runtime | `application/problem+json` với `status`, `code`, `correlationId`. | Phân biệt 401/403/404/409/422/503; chỉ retry khi contract cho phép, giữ idempotency key. |
| Connector | `{ "error": { "code", "message" } }` cho lỗi HTTP; invocation response còn có state `FAILED`/`UNKNOWN`/`PENDING`. | Đọc `state` và `retryable` theo Connector contract; `UNKNOWN` cần reconciliation. |
| Transport không có response | Không biết server đã ghi/dispatch hay chưa. | Query operation/invocation bằng ID ổn định hoặc retry với cùng idempotency key/grant theo đúng deadline. |

Đối với status/error chính xác từng endpoint, xem [spec 06–08](../docs/06-public-api.md) và source/test của version triển khai. Không dùng các mẫu JSON trong tài liệu này làm token hợp lệ hay bằng chứng end-to-end.
