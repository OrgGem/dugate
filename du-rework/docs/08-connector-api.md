# Connector service spec

Base `/internal/v1`, chỉ mạng nội bộ + service auth. Không có public ingress. Config management do Orchestrator proxy bằng riêng admin scope; invocation cần worker identity + signed runtime grant.

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

Response: `{invocationId,state,result:{content?,data?,artifacts?,sessionRef?},usage:{inputTokens,outputTokens,pages,costMicrousd,measurement},providerRequestId?,error?}`. Output lớn lưu object rồi finalize artifact qua service-scoped runtime grant. `sessionRef` là artifact/opaque reference có quyền; không giữ session bắt buộc trong RAM.

## Idempotency và deadline

Same invocationId+same inputHash trả trạng thái/kết quả đã biết; khác hash 409. Concurrent calls dedup bằng durable ledger + lease. Check ledger trước provider dispatch. Crash sau provider nhận request tạo UNKNOWN nếu adapter không reconcile được; không tự ghi FAILED rồi gọi lại ngay.

Business retry được SDK/runtime quyết định. Connector v1 không tự retry provider request không idempotent; trả error classification/retryAfter. Adapter có thể retry kết nối khi chứng minh chưa gửi request hoặc provider hỗ trợ idempotency, phải dùng budget chung và ghi attempt.

HTTP deadline không kéo dài operation deadline. Provider async trả 202 và nextPollAt; business task lưu invocationId rồi delayed continuation, không giữ worker slot lâu. Polling không tạo inference mới.

## Error taxonomy

| Code | HTTP | Runtime policy |
|---|---|---|
| INVALID_INPUT / CAPABILITY_UNSUPPORTED | 422 | Permanent |
| GRANT_INVALID / BINDING_DENIED | 403 | Permanent/security audit |
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

GET/POST `/connectors`; GET `/connectors/{id}`; POST `/connectors/{id}/revisions`; POST `/connectors/{id}/credentials/rotate`; POST `/connectors/{id}/test`; POST `/connectors/{id}/disable`. GET trả redacted metadata/revision/capabilities; secret write-only, rotation có audit.

Config revision gồm adapter ID, base URL, request mapping, response mapping, timeout, capability declarations, provider account/quota key và credential reference. Mapping là declarative được validate, không eval JS. Generic multipart/json adapter đủ v1; native provider SDK adapter là extension khi có nhu cầu xác định.

## Provider limiting

Limit theo provider account + quota domain/model, áp dụng chung mọi Connector replica. Redis atomic acquire/release với lease expiry; hỗ trợ max in-flight và request rate. Token budget dùng estimate/reservation và reconcile actual, không coi request rate là token rate. Quota exhausted trả 429 sớm; không tạo hàng đợi RAM vô hạn trong Connector.

## Usage ownership

Connector tạo immutable usage event cho từng actual provider attempt, kể cả usage sau cancel hoặc failed response khi provider báo có tính phí. Same event ID không ghi lại. Platform dedup projection; workflow parent chỉ sum. Unknown/estimated cost không hiển thị như measured final. Usage outbox retry được khi Orchestrator unavailable.
