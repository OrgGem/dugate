# Public API spec v1

Base `/api/v1`. JSON UTF-8; authentication `x-api-key`; operation/artifact luôn kiểm tra tenant+key/profile policy. Không tin `x-api-key-id`, `x-user-id`, `tenantId` do client truyền như identity. Generic API là canonical; sáu document routes là compatibility facade.

## Endpoint catalog

| Method/path | Input | Success | Errors chính |
|---|---|---|---|
| GET /businesses | cursor, limit | 200 enabled actions đã được profile cấp | 401 |
| GET /businesses/{id}/actions/{action}/schema | none | 200 schema theo version profile pin | 404 nếu không được cấp |
| POST /businesses/{id}/actions/{action} | Submission | 202 Operation | 400,401,403,409,413,415,422,429,503 |
| POST /docs/{action} | JSON hoặc multipart facade | 202 Operation | Như generic |
| POST /artifacts | multipart file | 201 ArtifactRef | 413,415,422 |
| GET /artifacts/{id} | none | 200 metadata | 404 không có quyền |
| GET /artifacts/{id}/download | none | 302 short-lived signed URL | 404,410 |
| GET /operations | cursor,limit,state | 200 cursor page | 400,401 |
| GET /operations/{id} | none | 200 Operation | 404 |
| GET /operations/{id}/result | none | 200 ResultEnvelope | 409 chưa succeeded; 410 expired |
| POST /operations/{id}/cancel | optional reason | 202 hoặc 200 replay | 409 terminal không cancellable |
| POST /operations/{id}/resume | waitId, input, expectedStateVersion | 202 hoặc 200 replay | 409 stale/terminal,422 invalid input |

V1 không expose arbitrary public route registration. `/docs/workflows` là facade tương lai ánh xạ process → registered business; xem compatibility scope.

## Submission

```json
{
  "input": { "type": "invoice", "language": "vi" },
  "artifacts": [{ "artifactId": "uuid", "role": "source" }],
  "output": { "format": "json" },
  "callback": { "url": "https://client.example/callback" },
  "clientReference": "invoice-123"
}
```

`input` validate theo action schema. `artifacts` optional nếu action cho text-only; roles action định nghĩa. Profile chọn version/connector; client không truyền queue, credential, model hay prompt bị khóa để override.

`Idempotency-Key` khuyến nghị; scope `(tenantId, apiKeyId, businessId/action, key)`, request hash chứa normalized input+artifact content identity+output+callback. Alias và generic action normalize cùng routeAction. Cùng key/body trả operation cũ (200 nếu replay); khác body 409. Recheck permission trước trả cached operation. Concurrent submissions dựa trên unique DB constraint.

`X-Correlation-Id` được validate length/charset hoặc thay bằng server-generated ID. Response trả correlation ID. JSON request size, multipart file/total size, schema complexity và max artifacts là giới hạn cấu hình có test.

## Operation và ResultEnvelope

```json
{
  "id": "operation-uuid",
  "businessId": "document-core",
  "businessVersion": "1.0.0",
  "action": "extract",
  "state": "ACCEPTED",
  "stateVersion": 1,
  "createdAt": "2026-09-20T00:00:00Z",
  "progress": { "percent": 0, "message": "Accepted" },
  "links": { "self": "/api/v1/operations/operation-uuid", "result": "/api/v1/operations/operation-uuid/result" }
}
```

ResultEnvelope = `{schemaVersion, data, artifacts, usage, warnings}`. `data` theo outputSchema business; output lớn lưu artifact, trả ref thay vì nhét vào polling. Usage gồm measured/estimated và trạng thái pending/final/corrected; operation có thể succeeded trước khi usage reconciliation hoàn thành.

WAITING_INPUT bổ sung `{waitId, inputSchema, uiSchema, expiresAt}` với quyền xem. V1 chỉ một human wait đang mở cho root; không hỗ trợ UI gộp nhiều human waits song song.

## Sync compatibility

Canonical mặc định async. Facade hỗ trợ `?sync=true` với wait window có giới hạn: xong thì 200, chưa xong thì 202 cùng operation ID; timeout HTTP không cancel job. Không thực thi business trong API process.

## Multipart compatibility

Facade chuẩn hóa `file`, `files[]`, `source_file`, `target_file`; JSON-string form fields được parse nghiêm ngặt. Upload tạo artifact trước submit; lỗi submit để staging artifact hết TTL. Remote `file_urls` chuyển thành source descriptor để worker download với policy; không fetch tùy ý trong HTTP request handler. Auth dùng secret reference do profile cấp, không ghi raw auth vào queue.

## Errors

`application/problem+json`: `{type,title,status,code,detail,correlationId,errors?}`. Field errors chứa JSON pointer, không echo secret/input nhạy cảm.

401 invalid/missing auth; 403 denied action/locked override; 404 inaccessible object; 409 idempotency/state conflict; 413 size; 415 mime; 422 schema/business validation; 429 client quota; 503 provider/platform admission unavailable. 429/503 có `Retry-After` khi biết. Không trả 200 cùng error payload.

## Webhook

At-least-once delivery; `{deliveryId,eventType,operationId,state,stateVersion,occurredAt}`; signed HMAC header + timestamp, secret do Admin cấp; client dedup deliveryId. Payload không chứa file/raw prompt. SSRF policy ở registration và lúc gửi, timeout/backoff/max attempts, manual redelivery có audit. Webhook failure không đổi operation success thành failure.
