# 03 — Public API và hướng dẫn tích hợp

**Wire contract theo source hiện tại; không phải chứng nhận deployment.** Base minh họa `https://du.example.com/api/v1`; `.example.com` không phải môi trường triển khai. Generic business submissions dùng UTF-8 JSON; sáu document aliases và hai workflow facades dùng multipart form data. Public client routes yêu cầu `x-api-key` kể cả đọc trạng thái và download.

> **Ingress (PM-M02):** các route public dưới đây phục vụ trên cả Public `:3000` và Internal `:3002`; route admin (`/api/v1/admin*`), runtime (`/api/runtime*`) và internal (`/api/internal*`) **bị chặn trên Public `:3000`** bằng generic 404 (`orchestrator/services/orchestrator/src/http/ingress-guard.ts`), kể cả khi caller có credential hợp lệ. BFF/workers/services dùng Internal `:3002`.

## Headers và submission

| Header | Yêu cầu | Ý nghĩa |
|---|---|---|
| `x-api-key` | Bắt buộc | Key do admin cấp, server resolve tenant/profile; không truyền tenant identity từ client |
| `Content-Type` | Theo route | Generic business action nhận `application/json`; `/docs/{action}` và `/docs/workflows*` nhận `multipart/form-data` với boundary do HTTP client tạo |
| `Idempotency-Key` | Khuyến nghị cho submit | Chuỗi 1–128 ký tự chữ/số/`._-`; giữ nguyên khi retry cùng logical request |
| `X-Correlation-Id` | Tùy chọn | 8–128 ký tự chữ/số/`._-`; phản hồi có correlation ID để tra cứu |

Body chung của `POST /businesses/{businessId}/actions/{action}`:

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `input` | object | Có | Theo schema action/version mà profile đã pin |
| `artifacts` | array | Theo action | Các `{artifactId: UUID, role: string}` đã upload và có quyền |
| `output` | object | Không | Ví dụ `{format:"json"}`; chỉ format được action hỗ trợ |
| `callback` | object | Không | `{url: HTTPS URL}` trong callback policy đã được cấp |
| `clientReference` | string | Không | Tối đa 512 ký tự; mã tham chiếu hệ thống khách, không phải idempotency key |

Không truyền `queue`, raw credentials, model tùy ý hay `_prompt` để vượt profile. Discriminator bắt buộc, không dựa vào default của project cũ. Giới hạn bytes/pages/files/schema do profile và deployment cấu hình; các số ví dụ ở field dictionary cũ chưa phải quota production.

## Endpoint catalog

| Method + path dưới `/api/v1` | Input | Success response | Chú ý |
|---|---|---|---|
| POST `/businesses/{id}/actions/{action}` | JSON `Submission` | 202 accepted; 200 idempotent replay | Canonical business action |
| POST `/docs/{action}` | Multipart; `mode`, `type`, `task`, or `action` discriminator by action | 202 legacy operation + `Operation-Location`; 200 for `?sync=true` or replay | `action` is one of `ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`; no JSON request body on this alias |
| POST `/docs/workflows` | Multipart `process`, optional `resolution_data`, files | 202 new legacy workflow operation + `Operation-Location` | `process` is `disbursement`, `lc-checker`, or `doc-compare`; requires at least one file |
| POST `/docs/workflows/schema` | Multipart `schemaSlug`, optional JSON-object string `input`, optional files | 202 new legacy workflow operation + `Operation-Location` | `input` defaults to `{}`; a valid schema workflow may be fileless; revision/digest is pinned at admission |
| GET `/operations` | Legacy `filter/page_size/page_token` or canonical `limit/cursor` and filters | 200 legacy `{operations,next_page_token}` or canonical `{items,nextCursor,prevCursor,total,limit}` | Select one query dialect. Both are tenant and exact API-key scoped; a canonical cursor is key-bound |
| GET `/operations/{id}` | Optional `wait` seconds | 200 legacy `{name,done,metadata,result/error}` | `wait` is parsed as integer seconds and clamped to 0–30; 404 for missing, foreign-key, or deleted operations |
| GET `/operations/{id}/result` | none | 200 `ResultResponse` | Plain ResultEnvelope or encrypted wrapper is selected by server tenant policy; 409 before success, 410 when timed out |
| DELETE `/operations/{id}` | none | 204 no content | Soft delete; 401 or 404 on missing/foreign ownership |
| POST `/operations/{id}/cancel` | Optional legacy JSON `reason` | 200 current legacy operation envelope | 404 unknown/foreign; 409 terminal operation |
| POST `/operations/{id}/resume` | Either legacy `{step, extracted_data}` or CAS `{waitId,input,expectedStateVersion}` JSON; do not mix fields | Legacy form: 200 `{success,message}`; CAS form: 202 fresh / 200 replay with `{operationId,state,stateVersion,replayed,taskId}` | Both are API-key and tenant scoped. CAS validation/state conflicts retain the runtime error response; malformed/mixed fields return 422 |
| GET `/operations/{id}/download` | none | 200 output bytes or policy-encrypted JSON | Key-scoped; 409 until SUCCEEDED, 404 when output is unavailable, 413/503 when encrypted delivery cannot be served |
| GET `/artifacts/{id}/download` | none | 200 raw bytes or encrypted artifact wrapper | Plain mode uses artifact MIME; encrypted mode includes `artifactId` and `mimeType`; no 302 |

The legacy and canonical list query dialects are exclusive. Legacy filters use comma-separated `state=RUNNING|SUCCEEDED|FAILED|PENDING` and `processor=<name>`, `page_size` defaults to 20 and is bounded to 100, and `page_token` is the operation ID from the previous page. Canonical filters use `limit` (default 20, clamped to 1–100), opaque `cursor`, state/sort/time and allow-listed search filters; malformed canonical filters or cursors return 422. A canonical `tenant` filter must match the authenticated key tenant or the route returns 403. Public API-key cursors are bound to the key population, so another key cannot replay one. Business discovery and standalone artifact metadata/upload paths remain outside this endpoint catalog when absent from `docs/21-openapi.json`.

## Ví dụ end-to-end: upload → extract → lấy kết quả

Các command dùng cú pháp Bash/curl; trên PowerShell dùng `curl.exe` và điều chỉnh nối dòng. API key lấy từ biến môi trường, không commit vào file.

```bash
curl --fail-with-body "$DU_BASE/api/v1/artifacts" \
  -H "x-api-key: $DU_API_KEY" \
  -F 'file=@invoice.pdf;type=application/pdf'
```

201, ArtifactRef minh họa:

```json
{
  "artifactId": "11111111-1111-4111-8111-111111111111",
  "role": "source",
  "fileName": "invoice.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 24576
}
```

Lưu body dưới thành `request.json`, thay artifact ID bằng ID thực tế:

```json
{
  "input": {"type": "invoice"},
  "artifacts": [{"artifactId": "11111111-1111-4111-8111-111111111111", "role": "source"}],
  "output": {"format": "json"},
  "clientReference": "ERP-INVOICE-2026-001"
}
```

```bash
curl --fail-with-body "$DU_BASE/api/v1/businesses/document-core/actions/extract" \
  -H "x-api-key: $DU_API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: ERP-INVOICE-2026-001-v1' --data-binary @request.json
```

202 Accepted, kèm `Location` trỏ operation là đề xuất cần chốt khi freeze HTTP contract:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "tenantId": "tenant-demo",
  "businessId": "document-core",
  "businessVersion": "1.0.0",
  "action": "extract",
  "state": "ACCEPTED",
  "stateVersion": 1,
  "createdAt": "2026-09-20T08:00:00Z",
  "updatedAt": "2026-09-20T08:00:00Z",
  "deadlineAt": "2026-09-20T08:05:00Z",
  "progress": {"percent": 0, "message": "Accepted"},
  "links": {
    "self": "/api/v1/operations/22222222-2222-4222-8222-222222222222",
    "result": "/api/v1/operations/22222222-2222-4222-8222-222222222222/result"
  }
}
```

```bash
curl --fail-with-body "$DU_BASE/api/v1/operations/$OPERATION_ID" -H "x-api-key: $DU_API_KEY"
curl --fail-with-body "$DU_BASE/api/v1/operations/$OPERATION_ID/result" -H "x-api-key: $DU_API_KEY"
```

Chỉ gọi result khi `state=SUCCEEDED`. Polling đề xuất bắt đầu 2 giây, tăng dần tới 10 giây kèm jitter và dừng ở terminal/deadline; đây là hướng dẫn client, không phải thời gian xử lý cam kết. Với FAILED, đọc `error.code/title/detail` trên operation, không chờ result vô hạn.

200 ResultEnvelope minh họa:

```json
{
  "schemaVersion": "1",
  "data": {
    "supplier": {"name": "Công ty Mẫu"},
    "buyer": {"name": "Khách hàng Mẫu"},
    "invoiceNumber": "INV-001",
    "invoiceDate": "2026-09-20",
    "lineItems": [{"description": "Dịch vụ A", "quantity": 1, "unitPrice": 100000, "amount": 100000}],
    "subtotal": 100000,
    "vatRate": 10,
    "vatAmount": 10000,
    "total": 110000,
    "currency": "VND"
  },
  "artifacts": [],
  "usage": {"inputTokens": 1200, "outputTokens": 250, "costMicrousd": 0, "measurement": "estimated"},
  "warnings": ["Dữ liệu và usage minh họa; giá chưa được đối soát."]
}
```

`data` theo action schema; `artifacts` chứa file kết quả thay vì base64. `costMicrousd` là integer micro-USD, số 0 trong ví dụ không có nghĩa provider miễn phí. Contract hiện tại gộp `measured/estimated/pending/final/corrected` vào `measurement`; cần thống nhất cách biểu diễn độ chính xác và trạng thái đối soát trước release.

## Idempotency và timeout

Cùng tenant/key/action + idempotency key + normalized body trả cùng operation; body khác trả 409. Alias và canonical route phải normalize về cùng action. Không sinh key mới chỉ vì HTTP timeout; retry cùng key hoặc đọc operation nếu đã nhận ID. Thời hạn lưu key phải dài hơn cửa sổ retry đã công bố.

`?sync=true` trên sáu document aliases chỉ là compatibility wait có giới hạn: route trả HTTP 200 với legacy operation envelope, kể cả `done:false` khi hết cửa sổ chờ; timeout HTTP không hủy operation. Submit mới ở chế độ async trả 202 kèm `Operation-Location`; idempotent replay trả 200. Generic business action trả 202 khi mới nhận và 200 khi replay. Workflow facades luôn tạo operation mới, trả 202 và bỏ qua `sync` cùng `Idempotency-Key` theo legacy behavior.

## Cancel và human resume

```json
{"reason": "Client no longer needs this result"}
```

Body `{reason}` là tùy chọn trên `POST /operations/{id}/cancel`. Thành công trả HTTP 200 với legacy operation envelope; tiếp tục polling tới terminal state vì cancellation của provider là best-effort và usage có thể đến muộn. Cancellation không bảo đảm xóa file; retention/deletion policy là cơ chế riêng.

WAITING_INPUT bổ sung `wait` trong OperationDetail:

```json
{
  "waitId": "approval-001",
  "inputSchema": {"type": "object", "properties": {"approved": {"type": "boolean"}}, "required": ["approved"], "additionalProperties": false},
  "expiresAt": "2026-09-21T08:00:00Z"
}
```

Resume request:

```json
{"waitId": "approval-001", "input": {"approved": true}, "expectedStateVersion": 7}
```

CAS resume trả 202 khi tạo lần tiếp tục mới hoặc 200 khi phát lại acknowledgement `{operationId,state,stateVersion,replayed,taskId}`. Dùng `waitId`, `input`, và `expectedStateVersion` từ operation hiện hành; 409 buộc client đọc lại operation. Legacy clients có thể tiếp tục gửi `{step,extracted_data}` và nhận HTTP 200 `{success:true,message:"Resumed successfully"}`. Không trộn hai body dialects. Chỉ action hỗ trợ human wait mới có luồng này; sáu core API không mặc định đều cần người duyệt.

## Lỗi và webhook

Error envelope mục tiêu `application/problem+json`:

```json
{
  "type": "urn:dugate:problem:invalid-input",
  "title": "Invalid input",
  "status": 422,
  "code": "INVALID_INPUT",
  "detail": "input.targetLanguage is required for translate",
  "correlationId": "demo-request-001",
  "errors": [{"pointer": "/input/targetLanguage", "message": "Required"}]
}
```

Field error `pointer/message` là đề xuất cần freeze. Không echo secrets hoặc toàn bộ tài liệu trong lỗi.

| Status | Ý nghĩa | Client xử lý |
|---|---|---|
| 400 | JSON/form/header không hợp lệ | Sửa request |
| 401 / 403 | Key không hợp lệ / action hoặc override bị cấm | Kiểm tra key/profile, không retry liên tục |
| 404 | Không tồn tại hoặc không có quyền object | Không suy ra tenant khác có dữ liệu |
| 409 | Idempotency, state, lease hoặc result conflict | Đọc context; sửa logical request khi thích hợp |
| 410 | Expired/terminal resource theo endpoint | Không polling mãi |
| 413 / 415 / 422 | Quá lớn / MIME / business schema | Sửa file hoặc tham số |
| 429 | Quota/admission theo client/provider | Backoff theo Retry-After, giữ key |
| 503 | Tạm thời chưa thể nhận | Retry có budget; không flood |

Webhook payload mục tiêu:

```json
{"deliveryId": "delivery-001", "eventType": "operation.completed", "operationId": "22222222-2222-4222-8222-222222222222", "state": "SUCCEEDED", "stateVersion": 9, "occurredAt": "2026-09-20T08:00:20Z"}
```

At-least-once: receiver xác minh HMAC trên raw body + timestamp, chống replay, dedup delivery ID, persist rồi trả 2xx nhanh; sau đó lấy result bằng API key. Tên header, canonical signing string, tolerance, retries và event enum **chưa freeze**, phải công bố và có test vector trước go-live. Webhook thất bại không đổi kết quả business đã success.
