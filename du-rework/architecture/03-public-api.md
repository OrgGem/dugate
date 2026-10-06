# 03 — Public API và hướng dẫn tích hợp

**Contract mục tiêu, chưa phải API đang được chứng nhận hoạt động.** Base minh họa `https://du.example.com/api/v1`; `.example.com` không phải môi trường triển khai. UTF-8 JSON; file qua multipart/artifact. Tất cả endpoint trong tài liệu này cần `x-api-key`, kể cả đọc trạng thái và download.

> **Ingress (PM-M02):** các route public dưới đây phục vụ trên cả Public `:3000` và Internal `:3002`; route admin (`/api/v1/admin*`), runtime (`/api/runtime*`) và internal (`/api/internal*`) **bị chặn trên Public `:3000`** bằng generic 404 (`services/orchestrator/src/http/ingress-guard.ts`), kể cả khi caller có credential hợp lệ. BFF/workers/services dùng Internal `:3002`.

## Headers và submission

| Header | Yêu cầu | Ý nghĩa |
|---|---|---|
| `x-api-key` | Bắt buộc | Key do admin cấp, server resolve tenant/profile; không truyền tenant identity từ client |
| `Content-Type` | Theo body | `application/json`, hoặc boundary do HTTP client tạo khi upload multipart |
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
| GET `/businesses` | cursor, limit | 200 danh mục business/actions được cấp | Không lộ business ngoài profile |
| GET `/businesses/{id}/actions/{action}/schema` | path | 200 input/output schemas theo pinned version | Không cho client tự đổi version |
| POST `/businesses/{id}/actions/{action}` | Submission | 202 Operation; 200 replay | Canonical submit |
| POST `/docs/{action}` | JSON Submission hoặc multipart compatibility | 202 Operation | Sáu alias document-core; adapter cần test |
| POST `/artifacts` | multipart `file` | 201 ArtifactRef | MIME signature/size/ownership checks |
| GET `/artifacts/{id}` | path | 200 metadata | Không trả storage credentials |
| GET `/artifacts/{id}/download` | path | 200 raw bytes (plain) hoặc 200 JSON wrapper (encrypted) — **302 đã bị loại khỏi contract** | 410 khi hết retention |
| GET `/operations` | cursor, limit, state | 200 cursor page | Scope theo key/tenant/policy |
| GET `/operations/{id}` | path | 200 OperationDetail | 404 nếu không được xem |
| GET `/operations/{id}/result` | path | 200 ResultEnvelope | 409 chưa SUCCEEDED; 410 kết quả expired |
| POST `/operations/{id}/cancel` | `{reason?: string}` | 202 accepted / 200 replay | 409 terminal không cancellable |
| POST `/operations/{id}/resume` | waitId, input, expectedStateVersion | 202 accepted / 200 replay | 409 stale; 422 sai schema |

Shape phân trang/discovery chi tiết chưa freeze. Đề xuất pagination `{items:[], nextCursor:null}` và schema discovery `{businessId,businessVersion,action,inputSchema,outputSchema}`; phải đồng bộ `@du/contracts` trước phát hành SDK. Không suy ra đã tồn tại từ bảng này.

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

`?sync=true` chỉ là compatibility wait có giới hạn: kết thúc trong cửa sổ thì 200, chưa xong thì 202 với operation ID. Timeout HTTP không hủy operation. Shape của response 200 sync cần contract test riêng; hướng dẫn này dùng async để tránh phụ thuộc điểm chưa freeze.

## Cancel và human resume

```json
{"reason": "Client no longer needs this result"}
```

Gửi body trên tới `/operations/{id}/cancel`. Sau 202 tiếp tục đọc trạng thái; cancel provider là best-effort, usage có thể đến muộn. Cancellation không bảo đảm xóa file; retention/deletion policy là cơ chế riêng.

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

202/200 trả operation hiện hành theo contract cần freeze. 409 buộc client đọc lại operation; không tự chuyển `approved` hoặc gửi tiếp bằng state version đoán. Chỉ action hỗ trợ human wait mới có luồng này; sáu core API không mặc định đều cần người duyệt.

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
