# 17 — Public API: spec thực thi và ví dụ sử dụng

**Phạm vi:** canonical Public API trong [Orchestrator router](../orchestrator/services/orchestrator/src/server.ts), [submission/result schema](../orchestrator/packages/contracts/src/operations.ts) và [document-core manifest](../businesses/document-core/src/manifest/document-core.manifest.ts), đối chiếu ngày 2026-10-02. Ví dụ dùng ID/token giả và là **mẫu wire**, chưa được chạy trên deployment trong lượt viết tài liệu. Legacy `/api/v1/docs/*` có contract riêng ở [docs/39](../docs/39-legacy-parity-contract.md); đừng trộn body/response legacy với canonical API này.

## 1. Điều kiện dùng API

- Base URL local: `http://127.0.0.1:3000/api/v1` khi Orchestrator chạy ở port mặc định. Client gửi `x-api-key` đang active, có tenant/profile/business version phù hợp. Không gửi `RUNTIME_TOKEN` hay `ADMIN_TOKEN` từ client ngoài.
- JSON request dùng `Content-Type: application/json`. `Idempotency-Key` nên được gắn cho submit để retry an toàn; cùng key và body trả lại operation cũ, cùng key với body khác trả conflict.
- Action chỉ chạy khi business version và profile binding đã được provision. Ví dụ `document-core/ingest` bên dưới dùng `input.mode=parse`, `input.text` theo input normalizer hiện có; triển khai không tự cấp API key/profile.
- `x-correlation-id` có thể do client cấp theo `[A-Za-z0-9._-]{8,128}` hoặc server sinh. Hãy lưu ID này khi hỗ trợ sự cố.

## 2. Submit một operation

`POST /businesses/{businessId}/actions/{action}`. Body có `input` bắt buộc (object), và tùy chọn `sourceUrl`, `artifacts[]`, `output`, `callback`, `clientReference`. `artifacts[]` gồm `{artifactId, role}`; `sourceUrl` chỉ được nhận khi backend S3 được bật. Các field khác ngoài schema ở top level bị từ chối. Nội dung `input` tiếp tục được kiểm theo action manifest/handler.

```bash
curl -i -X POST 'http://127.0.0.1:3000/api/v1/businesses/document-core/actions/ingest' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <tenant-api-key>' \
  -H 'Idempotency-Key: ingest-demo-001' \
  --data '{"input":{"mode":"parse","text":"Hop dong mau de phan tich","outputFormat":"json"},"clientReference":"demo-001"}'
```

Response mới có HTTP **202**; replay cùng key/body có HTTP **200** và `replayed: true`. Hình dạng response từ route:

```json
{
  "operationId": "11111111-1111-4111-8111-111111111111",
  "state": "ACCEPTED",
  "stateVersion": 1,
  "replayed": false,
  "correlationId": "b7f773f4-508d-4bd5-8ed5-220bad3ae240",
  "links": {
    "self": "/api/v1/operations/11111111-1111-4111-8111-111111111111",
    "result": "/api/v1/operations/11111111-1111-4111-8111-111111111111/result"
  }
}
```

`state` phụ thuộc đường admission; nguồn URL có thể bắt đầu ở `PENDING_INGESTION`, không phải `ACCEPTED`. Không suy `SUCCEEDED` từ HTTP 202.

## 3. Poll trạng thái và phân trang

`GET /operations/{id}` trả `OperationView` cho tenant của key. `?wait=<seconds>` cho long poll có giới hạn; hết thời gian đợi không cancel operation. `GET /operations` trả `{items,nextCursor,prevCursor,total,limit}`; `limit` mặc định 20, tối đa 100, sort mặc định `created_at:desc`. Filter `state`, `tenant`, `id`, `cursor`, `sort` được kiểm ở route; cursor phải khớp sort đã phát ra.

```bash
curl -sS 'http://127.0.0.1:3000/api/v1/operations/11111111-1111-4111-8111-111111111111?wait=10' \
  -H 'x-api-key: <tenant-api-key>'

curl -sS 'http://127.0.0.1:3000/api/v1/operations?state=RUNNING&limit=20&sort=created_at:desc' \
  -H 'x-api-key: <tenant-api-key>'
```

Public projection `toOperationView()` hiện trả `id`, `name`, `businessId`, `businessVersion`, `action`, `state`, `stateVersion`, `createdAt`, `updatedAt`, `deadlineAt`, `progress`, `links`. Ví dụ theo response **đang phát ra từ route**:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "operations/11111111-1111-4111-8111-111111111111",
  "businessId": "document-core",
  "businessVersion": "1.0.0",
  "action": "ingest",
  "state": "RUNNING",
  "stateVersion": 3,
  "createdAt": "2026-10-02T03:00:00.000Z",
  "updatedAt": "2026-10-02T03:00:02.000Z",
  "deadlineAt": "2026-10-02T03:05:00.000Z",
  "progress": {"percent": 0, "message": "RUNNING"},
  "links": {
    "self": "/api/v1/operations/11111111-1111-4111-8111-111111111111",
    "result": "/api/v1/operations/11111111-1111-4111-8111-111111111111/result"
  }
}
```

**MISMATCH schema ↔ projection:** [contract `OperationViewSchema`](../orchestrator/packages/contracts/src/operations.ts) yêu cầu `tenantId` và không khai báo `name`, còn [public projection `toOperationView()`](../orchestrator/services/orchestrator/src/modules/operations/facade.ts) trả `name` nhưng không trả `tenantId`. Đây là chênh lệch producer/consumer cần test và quyết định contract; ví dụ trên mô tả **wire hiện tại**, không tuyên bố nó đã đạt schema xuất bản.

Danh sách có thể trả `{"items":[],"nextCursor":null,"prevCursor":null,"total":0,"limit":20}`. `state` dùng nhóm filter `RUNNING`, `COMPLETED`, `FAILED`, `TIMED_OUT`; đây không phải toàn bộ enum state nội bộ. `sort` nhận sáu tổ hợp `created_at|updated_at|deadline_at` với `asc|desc`; `tenant` trên đường API key chỉ được bằng tenant của chính key. Đọc [docs/06](../docs/06-public-api.md) và [contract parser](../orchestrator/packages/contracts/src/public-api.ts) trước khi tự tạo cursor hoặc filter nâng cao.

## 4. Lấy result và artifact

`GET /operations/{id}/result` trả **409 `STATE_CONFLICT`** khi operation chưa `SUCCEEDED` hoặc đã `FAILED`/`CANCELLED`, **410 `GONE`** khi `TIMED_OUT`, và **200** khi thành công. Với tenant không bật recipient encryption, response là `ResultEnvelope` gồm `schemaVersion='1'`, `data`, `artifacts`, `usage`, `warnings`. `data` hiện chứa `resultRef` khi worker ghi ref; shape kết quả business chi tiết phụ thuộc business/version.

```bash
curl -sS 'http://127.0.0.1:3000/api/v1/operations/11111111-1111-4111-8111-111111111111/result' \
  -H 'x-api-key: <tenant-api-key>'
```

```json
{
  "schemaVersion": "1",
  "data": {"resultRef": "artifact://result/demo-001"},
  "artifacts": [],
  "usage": {"inputTokens": 0, "outputTokens": 0, "costMicrousd": 0, "measurement": "pending"},
  "warnings": []
}
```

Nếu tenant bật delivery encryption, route trả wrapper `{"schemaVersion":"1","encrypted":true,"delivery":{...}}`; client phải giải mã `delivery` theo contract. Không có query parameter để ép trả plaintext. `GET /artifacts/{artifactId}/download` trả bytes trực tiếp hoặc wrapper encrypted theo policy; chỉ artifact READY và được gắn với operation thành công của tenant mới đọc được. URL download là relative path trong `artifacts[].download` khi result có artifact.

## 5. Cancel, resume, upload và usage

| Route | Khi dùng | Ghi chú |
|---|---|---|
| `POST /operations/{id}/cancel` | Dừng operation còn có thể cancel. | 202 cho transition mới, 200 khi replay; tenant-fenced. |
| `POST /operations/{id}/resume` | Tiếp tục `WAITING_INPUT` bằng `waitId`, `input`, `expectedStateVersion` theo contract. | 202/200; sai state/version trả conflict. |
| `POST /uploads` và `PUT /uploads/{id}/content` hoặc nhánh multipart | Tải nguồn trước submit và lấy artifact reference. | Phụ thuộc S3/public upload gateway và policy mã hóa; đọc [upload spec](../docs/06-public-api.md) và [runbook](../docs/runbooks/data-02-public-uploads-live.md) cho geometry/token. |
| `GET /usage/summary?from=<ISO>&to=<ISO>` | Tổng usage của tenant theo khoảng `[from,to)`. | Cần cả hai mốc thời gian; thiếu trả 422. |

Ví dụ cancel: `curl -i -X POST 'http://127.0.0.1:3000/api/v1/operations/<operation-id>/cancel' -H 'x-api-key: <tenant-api-key>'`. Operation chuyển trạng thái bất đồng bộ; tiếp tục poll để xem kết quả cuối.

## 6. Lỗi và xử lý client

Orchestrator trả `application/problem+json` cho lỗi: `type`, `title`, `status`, `code`, có thể có `detail`, `correlationId`, `errors[]` (JSON pointer). Ví dụ shape minh họa cho validation:

```json
{
  "type": "urn:du:error:invalid_schema",
  "title": "request validation failed",
  "status": 422,
  "code": "INVALID_SCHEMA",
  "correlationId": "b7f773f4-508d-4bd5-8ed5-220bad3ae240",
  "errors": [{"pointer":"/input/mode","message":"Required"}]
}
```

`401` là auth thiếu/sai; `403` là ngoài scope; `404` che object không có quyền; `409` là idempotency/state conflict; `413`/`415` là giới hạn bytes/MIME; `422` là schema hoặc storage backend không hỗ trợ; `429`/`503` cần retry theo policy và `Retry-After` nếu được cấp. Không retry mù một POST với idempotency key khác sau lỗi transport mơ hồ.

## 7. Trình tự tích hợp khuyến nghị

1. Provision API key, profile binding và business version. Test health chỉ xác nhận dependency, không xác nhận business sẵn sàng.
2. Nếu có file, upload và đợi artifact reference READY rồi submit. Nếu text-only, submit `input` trực tiếp.
3. Lưu `operationId`, `correlationId`, `Idempotency-Key`; poll `links.self` tới terminal state. Nếu `WAITING_INPUT`, chỉ resume theo wait contract.
4. Khi `SUCCEEDED`, đọc `links.result`; tải artifact bằng relative `download` URL nếu có. Xử lý encrypted wrapper khi tenant policy bật.
5. Kiểm `usage.measurement`; `pending`/`estimated` có thể được cập nhật sau khi operation thành công vì usage event được giao độc lập.
