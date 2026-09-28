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
| GET /artifacts/{id}/download | none | 200 raw bytes + artifact MIME (plain) hoặc 200 JSON {schemaVersion, encrypted, delivery, artifactId, mimeType} (encrypted) | 404,410 |
| GET /operations | cursor, limit, state, tenant, id, sort | 200 `{items,nextCursor,prevCursor,total,limit}` | 401,403,422 |
| GET /operations/{id} | none | 200 Operation | 404 |
| GET /operations/{id}/result | none | 200 ResultEnvelope strict v1 (plain) hoặc 200 JSON {schemaVersion, encrypted, delivery} (encrypted) | 409 chưa succeeded; 410 expired |
| POST /operations/{id}/cancel | optional reason | 202 hoặc 200 replay | 409 terminal không cancellable |
| POST /operations/{id}/resume | waitId, input, expectedStateVersion | 202 hoặc 200 replay | 409 stale/terminal,422 invalid input |

V1 không expose arbitrary public route registration. `/docs/workflows` là facade tương lai ánh xạ process → registered business; xem compatibility scope.

## GET /operations — filter, keyset cursor, envelope

`GET /operations` trả **một envelope duy nhất**, dùng chung cho cả hai auth path (x-api-key và admin bearer):

```json
{
  "items": [],
  "nextCursor": "<base64url cua 2026-09-26T00:00:00.000Z|<uuid>>",
  "prevCursor": "<base64url cua 2026-09-26T00:00:00.000Z|<uuid>|p>",
  "total": 1284,
  "limit": 20
}
```

`items` dùng cùng projection `OperationView` với `GET /operations/{id}` (`toOperationView`), nên shape từng phần tử giống hệt object Operation ở mục kế tiếp. `total` là `COUNT(*)` của **tập đã lọc**, không phải `items.length`, và không phụ thuộc cursor. `limit` là giá trị đã clamp thực sự dùng cho truy vấn.

### Query parameters

| Param | Giá trị | Sai thì |
|---|---|---|
| `limit` | 1..100, default 20; parseInt rồi clamp | clamp, **không** 422 — tham số duy nhất không báo lỗi |
| `state` | `RUNNING`\|`COMPLETED`\|`FAILED`\|`TIMED_OUT`, không phân biệt hoa thường | 422 `INVALID_SCHEMA` |
| `tenant` | tenant id **chính xác**; charset `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}` | 422; chuỗi hex ≥32 ký tự bị từ chối vì là API-key material, không phải id |
| `id` | **substring** operation id, không phân biệt hoa thường | 422 |
| `cursor` | token keyset, xem dưới | 422 |
| `sort` | `<field>:<direction>` — allow-list đúng 6 giá trị: `created_at:asc`, `created_at:desc`, `updated_at:asc`, `updated_at:desc`, `deadline_at:asc`, `deadline_at:desc`; không phân biệt hoa thường, khoảng trắng được trim; vắng mặt hoặc rỗng = `created_at:desc` | 422 `INVALID_SCHEMA` nếu ngoài allow-list |

Filter không hợp lệ **bị báo lỗi, không bị bỏ qua âm thầm** — caller không bao giờ tin rằng filter đã áp dụng khi nó chưa. Query key lạ bị bỏ qua, không phải 422. `state` trên wire **không** nhận `ALL`; vắng mặt `state` mới là không lọc.

Mapping enum `state` → wire state (nhóm cho UI, không phải state máy mới):

| `state` | gồm |
|---|---|
| `RUNNING` | ACCEPTED, QUEUED, RUNNING, RETRY_PENDING, WAITING_CHILDREN, CANCEL_REQUESTED, WAITING_INPUT |
| `COMPLETED` | SUCCEEDED |
| `FAILED` | FAILED |
| `TIMED_OUT` | TIMED_OUT |

### Sort

`sort` là tham số thứ sáu của contract, sau `limit`, `cursor`, `state`, `tenant`, `id`. Danh sách hợp lệ **không** do route tự định nghĩa: `parseOperationsListSort` trong `packages/contracts/src/public-api.ts` là nguồn duy nhất, và cả schema `ListOperationsQuerySchema` lẫn route đều gọi đúng hàm đó — nên tài liệu công bố không thể nhận một giá trị mà route sẽ 422.

| Quy tắc | Hành vi đang triển khai |
|---|---|
| Tập giá trị | đúng 6: `created_at:asc`, `created_at:desc`, `updated_at:asc`, `updated_at:desc`, `deadline_at:asc`, `deadline_at:desc` (`OPERATIONS_LIST_SORT_VALUES`) |
| Vắng mặt hoặc rỗng | `created_at:desc` — đúng thứ tự route đã có trước khi tham số này tồn tại, nên mọi deep link cũ giữ nguyên hành vi |
| Hoa thường | không phân biệt: `UPDATED_AT:DESC` được chuẩn hoá thành `updated_at:desc`, và dạng phát ra trong link luôn là chữ thường |
| Cách tách | trên **dấu hai chấm cuối cùng**; giá trị có dấu hai chấm thừa bị từ chối thay vì bị cắt còn chạy |
| Sai | 422 `INVALID_SCHEMA`, message liệt kê cả 6 giá trị. Không bao giờ lặng lẽ rơi về default — người dùng gõ oldest-first mà nhận newest-first sẽ đọc sai cả danh sách |
| `ORDER BY` | cột lấy từ bảng tra cứu theo field **đã validate** (`OPERATIONS_LIST_SORT_COLUMN_SQL`), ghép `, id <ASC\|DESC>`; tên cột do caller đưa vào không bao giờ được nội suy vào SQL |
| Cột nullable | `deadline_at` là cột nullable duy nhất. Khóa của nó được COALESCE với sentinel **literal inline** (`'0001-01-01T00:00:00.000Z'::timestamptz` khi `desc`, `'9999-12-31T23:59:59.999Z'::timestamptz` khi `asc`) — một **Const node** nằm ngay trong câu SQL `ORDER BY`, **không phải placeholder `$n` đã bind** — vì bốn index biểu thức của migration 0019 chỉ match đúng hình Const này; hình `$n` là plan node khác nên planner rơi về Seq Scan + Sort và cả bốn index thành code chết (T-35, tái xác nhận ở review W-INGEST-0019-2). Giá trị lấy từ compile-time constant theo direction đã validate, không phải text của caller; chính chuỗi này được cursor predicate dùng lại nên `ORDER BY` và keyset boundary không thể lệch nhau. Mục đích: khối NULL luôn nằm cuối thứ tự và predicate row-value không bao giờ FALSE vì NULL. Không có bước này thì trang 1 đúng và **mất sạch mọi operation không deadline từ trang 2 trở đi**, trả 200 với một trang trông rất hợp lệ |

`limit` vẫn là tham số duy nhất **clamp** thay vì 422. `sort` không có ngoại lệ đó: nó theo đúng quy tắc báo-lỗi-thay-vì-bỏ-qua mà `state`/`tenant`/`id` đang tuân thủ. Tham số ngoài allow-list vẫn bị bỏ qua, không phải 422.

### Keyset cursor

Cursor **mang cả hướng đi lẫn thứ tự trong chính token**: `base64url("<ISO>|<uuid>|<field>:<direction>")`, hậu tố `p` nghĩa là đi **ngược**. Route chỉ có một tham số `?cursor=` nên không có chỗ nào khác để nói hướng — không có `p` thì link "trang trước" âm thầm thành trang kế tiếp, và dòng ngay trên biên là không với tới bằng keyset chỉ-đi-tới. Slot thứ ba **đặt tên thứ tự mà vị trí đó thuộc về** (`created_at:desc` khi không có `?sort=`), vì cùng một cặp `(sortKey, id)` là một ranh giới trang khác nhau trong mỗi sort — đọc nó dưới thứ tự khác là đọc một lát cắt khác. Token cũ `<ISO>|<uuid>` và `<ISO>|<uuid>|p`, sinh trước khi có tham số `sort`, vẫn decode và đọc thành `created_at:desc` — thứ tự duy nhất chúng có thể từng mang, nên link cũ phân trang y hệt.

- **Đi tới**: `ORDER BY <sortKey> <dir>, id <dir>` + `(sortKey, id) < cursor`
- **Đi ngược** (`|p`): đảo chiều quét, so sánh `(sortKey, id) > cursor`, lát cắt được đảo lại để vẫn hiển thị mới-trước
- `<sortKey>` là **giá trị của cột sort đang chọn** tại thời điểm dựng trang. Khi `sort` vắng mặt thì đó là `created_at`, nên hành vi cũ không đổi một byte token nào
- `nextCursor`: chỉ khác null khi probe `limit + 1` thấy dòng thứ `(limit+1)`; lấy từ dòng **cũ nhất** trang, token thuận
- `prevCursor`: chỉ khác null khi tồn tại dòng mới hơn dòng đầu trang; lấy từ dòng **mới nhất** trang, token `|p`. Trang đầu (không `cursor`) luôn có `prevCursor: null`
- **Lệch thứ tự là lỗi, không phải lần đọc lại**: token mang thứ tự của nó, nên gửi cursor của `created_at:desc` cùng `sort=updated_at:asc` trả **422 `INVALID_SCHEMA`** với message nói rõ cursor được ban cho sort nào, chứ không phải 200 với một trang đúng hình thức nhưng sai tập bản ghi

Phân trang keyset, không phải OFFSET: operation tạo mới giữa hai lần gọi không làm lệch hay lặp trang. Mỗi request chỉ chạy **hai câu có giới hạn**: một probe `limit + 1` và một `count(*)` trên tập đã lọc. `total` không đổi theo thứ tự — sắp xếp lại không làm thay đổi tập.

> **MISMATCH T140-A1 — đã chốt trong source, live acceptance còn mở (D-EVID-A27, sau Reviewer Turn 180). Đoạn dưới đây mô tả hành vi đang triển khai, không phải hợp đồng đã được nghiệm thu.**
>
>> Slot thứ ba đã được gắn vào. `decodeOperationsListCursor` tách payload theo `|` thành 2..4 phần, đọc `p` như một phần riêng (nó không phải `field:direction` hợp lệ nên hai hình dạng không lẫn được vào nhau), rồi đưa phần còn lại qua `parseOperationsListSort`. Route từ chối **khi lệch sort**: `decoded.sort.field !== sort.field || decoded.sort.direction !== sort.direction` thì **422 `INVALID_SCHEMA`**, message nói cả thứ tự đã ban lẫn cách sửa (bỏ `cursor` để bắt đầu thứ tự mới ở trang đầu). Từ chối chứ không bỏ qua là có chủ ý — caller đổi sort rồi gửi kèm cursor để tiếp tục phân trang sẽ âm thầm nhận trang 1 của thứ tự mới, đọc như vòng lặp với caller và như trang bình thường với operator. Cursor hỏng (id không phải uuid, ISO không round-trip, slot rỗng, hai slot thứ tự, `field:direction` lạ, dài quá `LIST_CURSOR_MAX_LEN` = 128) cũng là **422 `INVALID_SCHEMA`**, không phải 422 im lặng rơi về trang đầu.
>
>> **Đoạn trước được giữ làm lịch sử và không bị viết lại thành acceptance.** Reviewer Turn 140 đã ghi đây là finding **T140-A1** (owner contracts/Platform/Admin UI) và yêu cầu chốt chính sách **trước khi** câu chữ tài liệu thành hành vi đã chốt; trạng thái nó mô tả là token chỉ chứa `<ISO>|<uuid>[|p]` và `bindOperationsCursor` đem giá trị đó so với cột mà request hiện tại chọn, nên một cursor sinh dưới `created_at:desc` vẫn dùng được làm biên dưới `updated_at:asc` hay `deadline_at:desc`. Packet `W-ADMUX02-SORT-CURSOR-BIND-1` đã đáp; Reviewer Turn 180 xác nhận mức hiện tại là **IMPLEMENTED / offline VERIFIED, live acceptance OPEN** — chưa có receipt live nào cho cross-sort 422, legacy-token, six-sort walk hay query plan của sort mới. `bindOperationsCursor` vẫn so `(sortKeySql, id)` với `($N::timestamptz, $M::uuid)`; cái đổi là route chặn cursor lệch thứ tự **trước** khi bind.
>
>> Nguồn: `services/orchestrator/src/server.ts` (`encodeOperationsListCursor`, `decodeOperationsListCursor`, `parseOperationsListQuery`, `parseOperationsListSortParam`, `bindOperationsCursor`) và `packages/contracts/src/public-api.ts` (`OPERATIONS_LIST_SORT_FIELDS`, `OPERATIONS_LIST_SORT_DIRECTIONS`, `OPERATIONS_LIST_SORT_VALUES`, `parseOperationsListSort`, `formatOperationsListSort`, `LIST_CURSOR_MAX_LEN`) — đọc trực tiếp từ source, **không chép từ lời Reviewer**.

### Tenant fence và lỗi

- **x-api-key**: API key là hàng rào. `tenant` chỉ được chấp nhận khi **bằng** tenant của key; giá trị khác trả **403 `PERMISSION_DENIED`** thay vì bị bỏ qua, để không caller nào tin rằng mình đã mở rộng tầm nhìn.
- **Admin bearer** (alternate path cho Admin shell, không phải bề mặt client public): platform principal hẹp được về bất kỳ tenant nào bằng `?tenant=`; tenant operator bị ghim vào tenant của nó bằng SQL predicate (fence ở server, không post-filter) và nhận 403 cho `tenant` ngoại lai, cùng cách diễn đạt cho id lạ và id ngoại lai.
- Mã lỗi của endpoint này: **401** (thiếu/sai auth), **403** (tenant ngoài phạm vi), **422** (`state` / `tenant` / `id` / `cursor` / `sort` không hợp lệ). Route này **không** sinh 400. Tên query nằm ngoài allow-list bị **bỏ qua**, không phải 422 — và route không bao giờ echo lại một tên lạ.
- Tham số này được đọc qua seam `AllowListedQuery`, có kiểu là phần tử của `OPERATIONS_LIST_QUERY_PARAMS`, nên `read("sort")` là **lỗi biên dịch**. Đọc một tham số ngoài allow-list là lỗi build, không phải một accept im lặng.

### Trạng thái bằng chứng

Mục này mô tả **hành vi đang triển khai** và được đồng bộ theo yêu cầu packet 1 của Reviewer Turn 40 (finding 1). Mức hiện tại: **IMPLEMENTED / offline VERIFIED** — Turn 30 ghi nhận `prevCursor` tính sai hướng là đã được sửa tại ranh giới code, và Qwen-Admin có roundtrip trang 1 → 2 → 1 trên fake DB có trạng thái. **Chưa ACCEPTED:** chưa có bằng chứng render trình duyệt, query plan / `EXPLAIN` trên dữ liệu seed thật, hành vi khi có insert chen giữa hai trang, hay tenant isolation trên service đã deploy. Quyết định index composite `(tenant_id, created_at DESC, id DESC)` và receipt query-plan do Tester giữ vẫn mở (Δ13); `G-ADMIN-OPS` mở.

**Đồng bộ `sort` (Reviewer Turn 140, finding T140-D1).** Bảng tham số ở trên nay có sáu tên, khớp `OPERATIONS_LIST_QUERY_PARAMS` đọc trực tiếp từ source. Mức của riêng phần `sort`: **IMPLEMENTED / offline VERIFIED** — W-ADMUX02-SORT-ALLOWLIST-1 báo 385/385 contracts, 108/108 targeted ×3, typecheck exit 0. **Chưa live VERIFIED:** chưa receipt nào chạy `sort=updated_at` hay `sort=deadline_at` trên PostgreSQL thật, và migration 0017 chỉ có index cho `created_at`, nên hai sort còn lại chưa có index khớp và chưa có query plan. **Chưa ACCEPTED** — một phần vì T140-A1 (cursor chưa ràng buộc với sort) vẫn mở, một phần vì Admin shell chưa có sort control nào.

**Hai chỗ khác trong cây tài liệu từng còn contract cũ, nay đã xử lý:** `docs/20-openapi-descriptions.md` đã mang envelope 5 trường và tập tham số allow-list, và `docs/19-traceability-audit-matrix.md` §4 đã có dòng cho contract list này (D-DOCS-CONTRACT-SYNC-1); câu chữ cũ trong renderer (Δ14) đã đóng upstream bằng W-ADMUX02-CLEAN-1 + W-ADMUX02-COPY-2. **Phần còn trôi của T140-D1** nằm ở `coordination/gates/contracts-v1.md` — bảng module map vẫn liệt kê contract cũ, và file đó tự ghi `Owner: Claude (platform lane)`, nên nó nằm ngoài phạm vi sửa của lane tài liệu; nó được ghi lại ở `docs/28` / `docs/35` thay vì bị sửa lặng lẽ. Nguồn: `services/orchestrator/src/server.ts` và `packages/contracts/src/public-api.ts`, đọc trực tiếp — **không chép từ lời Reviewer**. Mục này mô tả contract theo **symbol và hành vi quan sát được**, không neo vào số dòng, nên nó không bị cũ khi file dịch dòng; nhưng nếu envelope, tập tham số **hoặc chính sách cursor/sort** thay đổi, phần này **phải đồng bộ lại** — không suy ra từ vị trí dòng.

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

`input` validate theo action schema. `artifacts` optional nếu action cho text-only; roles action định nghĩa. `sourceUrl` (optional, `string` max 2048, contract `SubmissionSchema.sourceUrl`) chỉ được chấp nhận khi deployment backend là `s3` — khi `storageBackend !== 's3'` request chứa `sourceUrl` bị từ chối **422 `UNSUPPORTED_STORAGE_BACKEND`** (`submission.ts:113-122`) ngay sau schema parse thuần túy, trước bất kỳ DB write nào (zero rows: không operation/task/outbox, không parked `PENDING_INGESTION`). Quyết định T200-D1: giữ `sourceUrl` trong published schema và trả 422 thay vì capability-gating (ẩn field khỏi schema theo backend) — 422 là contract rõ ràng, client không thể dự đoán backend từ API nên cần mã lỗi wire-visible trong `PublicErrorCodes` (`packages/contracts/src/errors.ts`) thay vì silent omission; capability-gating sẽ làm cùng payload vừa hợp lệ vừa không hợp lệ tùy deployment mà không có tín hiệu nào. Profile chọn version/connector; client không truyền queue, credential, model hay prompt bị khóa để override.

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

401 invalid/missing auth; 403 denied action/locked override; 404 inaccessible object; 409 idempotency/state conflict; 413 size; 415 mime; 422 schema/business validation **và `UNSUPPORTED_STORAGE_BACKEND` khi `sourceUrl` gửi tới deployment không phải S3**; 429 client quota; 503 provider/platform admission unavailable. 429/503 có `Retry-After` khi biết. Không trả 200 cùng error payload.

## Webhook

At-least-once delivery; `{deliveryId,eventType,operationId,state,stateVersion,occurredAt}`; signed HMAC header + timestamp, secret do Admin cấp; client dedup deliveryId. Payload không chứa file/raw prompt. SSRF policy ở registration và lúc gửi, timeout/backoff/max attempts, manual redelivery có audit. Webhook failure không đổi operation success thành failure.

## Result delivery encryption (ADR-18 baseline — CHƯA triển khai)

> **Trang thai (cap nhat D-EVID-A27):** `RESULT-WIRE-01` **DA DONG** o contract freeze: xem muc *Frozen result/download response contract* ben duoi. `ENC-00` van `[~]`; phan delivery encryption duoi day van la baseline ADR-18, chua co runtime wire hoan chinh.

Khi tenant bật `deliveryEncryptionEnabled` (Admin per-tenant toggle, mặc định `disabled`):

- Server giải mã lớp storage DEK trong bộ nhớ streaming, rồi bọc lại bằng **recipient delivery DEK mới** cùng public key của tenant. Không có query parameter hay header client-controlled nào bypass policy.
- Hai cipher suite, định danh qua field versioned:
  - **Suite 1 (ưu tiên):** HPKE RFC 9180 — DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM payload.
  - **Suite 2 (enterprise/legacy):** RSA-OAEP-SHA256 key wrapping + AES-256-GCM payload.
- Envelope delivery: `{ version: 1, suite: "hpke"|"rsa-oaep-aes-gcm", recipientKeyId, enc, nonce, tag, ciphertext }`.
- Tenant đăng ký public key qua Admin API kèm **Proof-of-Possession** challenge. Metadata: `fingerprint` (SHA-256), `algorithm`, `version`, `effectiveAt`, `revokedAt`.
- Result ghim `recipientKeyVersion` tại thời điểm sinh. Key revoke/không tìm thấy → **422/409 fail-closed**, tuyệt đối không plaintext fallback.
- Lỗi delivery encryption dùng taxonomy hiện hành (`PublicErrorCodes`); mã lỗi cụ thể sẽ thêm khi ENC-01 contract freeze.



### Frozen result/download response contract (RESULT-WIRE-01, D-EVID-A27)

> **Trang thai:** contract **da freeze va verify offline** tai `coordination/reports/tester.md` muc `RESULT-WIRE-01` (04:07:35 +07). Cac route duoi day **khong con** la 302 / short-lived signed URL.

- `GET /api/v1/operations/{id}/result`: **HTTP 200 JSON** ca hai mode. Plain mode tra **strict version-1 `ResultEnvelope` (`schemaVersion, data, artifacts, usage, warnings`). Encrypted mode tra **strict version-1** `{schemaVersion, encrypted: true, delivery}` ; giai ma `delivery` cho ra **dung** ResultEnvelope do.
- `GET /api/v1/artifacts/{id}/download`: **HTTP 200 raw bytes** kem artifact MIME o plain mode; o encrypted mode la **HTTP 200 JSON** `{schemaVersion, encrypted: true, delivery, artifactId, mimeType}`. `RecipientDeliveryEnvelopeSchema` dung chung va **strict** cho ca hai bien the encrypted.
- **Khong con 302.** Catalog o tren da doi tu 302 sang 200. Day chinh la **scope note** ma chinh receipt ghi (`docs/06-public-api.md still documents a 302 download`) — muc tai lieu nay la follow-up do chinh dispatch do dat ra.
- Bang chung offline: `@du/contracts` build 0, test **19 suites / 427 tests** 0; `@du/orchestrator` `tests/delivery-encryption.test.ts` **22/22** 0; `tsc --noEmit` sach 0 cho ca hai package. Fixture route validate schema, noi artifact reference cua result da giai ma, roi **giai ma ben ngoai va so byte** payload that.
- **Chua co independent receipt trong cay.** Mot lan verify doc lap co chay (coordinator log 3978: 64/64 = contracts 42/42 + delivery 22/22) nhung **khong append duoc** vao `tester.md` do byte 0x97 non-UTF8; receipt `V-OFFLINE-RESULT-WIRE-01-REVAL` duoc re-dispatch nhung **van chua co** trong tester.md — D-A37-3.
