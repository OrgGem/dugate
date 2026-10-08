# Public API — legacy wire parity contract (DUGate cũ → du-rework)

> **Trạng thái:** SPEC ĐÃ CHỐT (2026-10-02, yêu cầu user: *"với tất cả api tôi muốn response với spec api giống như luồng cũ"*).
> **Phạm vi:** mọi public endpoint của hệ cũ phải được dựng lại trên `du-rework` với **wire tương đồng**: method, path, query, form field, status code, header và JSON body (key + value).
> **Ngoại lệ duy nhất — identity:** shape/status/field giữ nguyên; **cách xác thực được hardening** (mục 6). Không tái hiện IDOR của hệ cũ.
> **Nguồn:** đọc trực tiếp từ legacy `D:\Git\dugate` (root repo, NGOÀI `du-rework/`), không dựa `CLAUDE.md` hay `docs-site`. Mọi khẳng định kèm `file:line`.
> **Quan hệ:** `docs/06-public-api.md` là spec canonical của rework; file này là **lớp compat wire** mà `docs/06` trỏ tới. `docs/14-reference-compatibility.md` là policy; file này là contract đo được.
> **Gate:** `G-COMP` phải đạt trước cutover. Không tick gate từ file này.

> **WFA implementation delta (2026-10-07):** Hai workflow facade đã được nối vào shared admission/outbox; encrypted tenant schema catalog và production `document-core@1.1.0` manifest đã có. Runtime/end-to-end acceptance vẫn OPEN trong [WFA plan](../tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md). Schema `input` hiện bị giới hạn thành JSON object, cùng các giới hạn DAG/file/egress; đây là hardening delta được ghi riêng, không được suy diễn toàn bộ wire parity đã ACCEPTED. Workflow luôn tạo operation mới 202, bỏ qua sync/idempotency như route workflow cũ; quyết định sync cho document routes không áp dụng vào hai route này.

## 0. Quyết định chốt

| # | Quyết định | Trạng thái |
|---|---|---|
| 1 | Mọi public API trả **wire giống hệ cũ** | **CHỐT** (user, 2026-10-02) |
| 2 | Identity được **hardening**, không copy lỗ hổng hệ cũ | **CHỐT** (user: *"làm theo khuyến nghị"*) |
| 3 | `billing/balance` cần cột `spending_limit`/`total_used` trên `api_keys` | **Cột đã có** (migration `0024_legacy_parity_columns.sql`); cơ chế cập nhật `total_used` còn OPEN (mục 5.2) |
| 4 | `?sync=true` trả 200 **kể cả khi `done:false`** | **CHỐT** — theo hệ cũ (mục 4.1) |

Câu hỏi `API-COMPAT-DUGATE-2026-09-28.md:108` (yêu cầu 200 chỉ khi hoàn tất, *"đừng làm yếu yêu cầu này để khớp legacy"*) **bị đảo** bởi quyết định #4. Mục 4.1 ghi lý do để không tái tạo mâu thuẫn.

## 1. Bảng parity tổng

| # | Legacy endpoint (path thật) | Method | Rework hiện tại | Hành động |
|---|---|---|---|---|
| 1 | `/api/v1/docs/{ingest,extract,analyze,transform,generate,compare}` | POST | Facade compat đã implement (`legacy-http-mount.ts:600-646`; 6 slug tại `legacy-wire-decoders.ts:12-19`); wire parity từng variant chưa có receipt | Kiểm chứng 31 fixture + status/header/body theo §8 (COMP-10) |
| 2 | `/api/v1/docs/workflows` | POST | Facade admission đã implement (WFA); runtime acceptance OPEN | Kiểm chứng ba process thực tế theo WFA matrix |
| 3 | `/api/v1/docs/workflows/schema` | POST | Facade + encrypted revision catalog đã implement (WFA); runtime acceptance OPEN | Kiểm chứng executor, pin, HITL/resume/cancel theo WFA matrix |
| 4 | `/api/v1/services` | GET | Route + auth + shape đã implement trong facade; **hiện trả 500** vì catalogue chưa wire (`serviceCatalogue`; pin bởi test rv01) | Wire catalogue rồi so fixture (§5.1, COMP-08 phần còn lại) |
| 5 | `/api/v1/billing/balance` | GET | Handler đã implement (per-API-key; cột `api_keys` từ migration `0024_legacy_parity_columns.sql`; `billingFor` wired) | OPEN: cơ chế cập nhật `total_used` (mục 5.2) + fixture §8 |
| 6 | `/api/v1/billing/usage` | GET | Handler đã implement (route legacy riêng; canonical `/api/v1/usage*` giữ nguyên) | Fixture §8 + chốt `total_used` theo §5.2 |
| 7 | `/api/v1/operations/{id}/download` | GET | chỉ có `/artifacts/{id}/download` | Dựng route legacy (COMP-07) |
| 8 | `/api/v1/operations/{id}` | GET | có, **envelope khác** | Đổi sang legacy envelope |
| 9 | `/api/v1/operations/{id}` | DELETE | **không có** | Dựng soft-delete 204 |
| 10 | `/api/v1/operations` | GET | có, **envelope khác** | Đổi sang `{operations, next_page_token}` |
| 11 | `/api/v1/operations/{id}/cancel` | POST | có, **status khác** | Khớp status + body |
| 12 | `/api/v1/operations/{id}/resume` | POST | có, **body khác** | Trả `{success,message}` |

Vị trí facade: mount tại `orchestrator/services/orchestrator/src/http/routes/public.ts:13-14` (import) và `:299` (gọi `handleLegacyRoute`); `server.ts` **0 tham chiếu** `compat/` sau khi CONV-02 tách route family, và `handleLegacyRoute` trả `null` cho path nó không sở hữu. Các dòng "đã implement" ở bảng trên đối chiếu trực tiếp compat mount + host adapter; không suy đoán từ tài liệu.

**WFA evidence split (2026-10-07):** đã verify độc lập — T04–T13/T29–T32 (admission/error/auth, không side-effect, real HTTP), T14/T37 (schema pin + provision/load trên DB sạch), T16/T17/T23/T24 (node `parallel`/`join`/`human`/`input` qua worker thật), cộng suite điều khiển 8/8 HTTP→PG→outbox→Redis→production worker. Vẫn **OPEN**: T01–T03 (named chains thật), T15/T18–T22 (node adapters còn lại), T25–T28 (lifecycle ngoài case đã test), T33–T36 (security bounds). Không tick ACCEPTED. Nguồn: [wfa-verification](../coordination/reports/wfa-verification-2026-10-07.md) + [wfa-integration](../coordination/reports/wfa-integration-2026-10-07.md).

## 2. Submit — 6 core action route

Sáu route **không có logic riêng**: tất cả gọi `runEndpoint(serviceSlug, req)`
(`app/api/v1/docs/ingest/route.ts:5-7`; `runner.ts:58`). Đường dẫn thật lấy từ filesystem;
comment dòng 1 trong mỗi file viết sai (`/api/v1/ingest`) và **không được theo**.

### 2.1 Discriminator + 31 sub-case

| Action | Form field | Sub-case (thứ tự là thứ tự trong allow-list) |
|---|---|---|
| ingest | `mode` | `parse`, `ocr`, `digitize`, `split` |
| extract | `type` | `invoice`, `contract`, `id-card`, `receipt`, `table`, `custom` |
| analyze | `task` | `classify`, `sentiment`, `compliance`, `fact-check`, `quality`, `risk`, `summarize-eval` |
| transform | `action` | `convert`, `translate`, `rewrite`, `redact`, `template` |
| generate | `task` | `summary`, `outline`, `report`, `email`, `minutes`, `qa` |
| compare | `mode` | `diff`, `semantic`, `version` |

**4+6+7+5+6+3 = 31.** Nguồn: `lib/endpoints/registry.ts:73-398`.

**Cảnh báo — claim "31 vs 28" đã lỗi thời.** `docs/14-reference-compatibility.md` và
`API-COMPAT-DUGATE-2026-09-28.md:53` đều nói rework thiếu `extract:id-card`,
`analyze:fact-check`, `analyze:summarize-eval`. **Đã kiểm chứng ngược lại trên source:**

| Bằng chứng | Vị trí | Nội dung |
|---|---|---|
| Manifest | `businesses/document-core/src/manifest/document-core.manifest.ts:79` | 6 extract gồm `id-card` |
| Manifest | `.../document-core.manifest.ts:112` | 7 analyze gồm `fact-check`, `summarize-eval` |
| Manifest | `.../document-core.manifest.ts:15` | mô tả tự ghi *"31 document variants"* |
| Input normalizer | `.../src/validation/input-normalizer.ts:99,149` | allow-list 6 + 7 |
| Recipe | `.../src/recipes/recipe-definitions.ts:101,220,235` | 3 recipe cho 3 variant này |
| Decoder | `orchestrator/services/orchestrator/src/compat/legacy-wire-decoders.ts:32-38` | `VARIANTS` đủ 31 |

⇒ **Hai file tài liệu trên cần sửa.** Không phải thiếu code; là tài liệu chưa đuổi theo code.
Không tick `COMP-03` cho tới khi claim này được sửa, vì `:53` dùng nó làm lý do cho một task.

### 2.2 Input chuẩn — `multipart/form-data`

| Field | Nguồn | Quy tắc |
|---|---|---|
| `files[]` | `runner.ts:36-54` | nhiều file; bỏ file `size === 0` |
| `file` | `runner.ts:53` | một file |
| `source_file` / `target_file` | `runner.ts:47-49` | 2 tài liệu (compare) |
| `file_urls` | `runner.ts:129-156` | JSON string, mảng; mỗi entry **bắt buộc** có `url` non-empty, phải parse được bằng `new URL()`; cap `MAX_FILE_URL_ENTRIES` |
| `<discriminator>` | `runner.ts:113-123` | sai → **400** kèm danh sách hợp lệ |
| `output_format` | `runner.ts:226` | `md`\|`json`\|`html`\|`csv`, default `json` |
| `webhook_url` | `runner.ts:227` | callback |
| `idempotency-key` | `runner.ts:228` | **header**, không phải form |
| `sync=true` | `runner.ts:229` | **query**, không phải form |
| `x-api-key` | `runner.ts:88-110` | sha256 lookup ngay trong runner |
| `x-correlation-id` | `runner.ts:59` | thiếu thì `randomUUID()` |

Thứ tự trong `normalizeFiles` là `files[]` → `source_file` → `target_file` → `file`; thứ tự này quyết định index `source/target` cho compare nên **phải giữ nguyên**.

### 2.3 Response submit

Body là output của `formatOperationResponse` (`lib/pipelines/format.ts:17-73`):

```json
{ "name": "operations/{id}", "done": false,
  "metadata": { "state", "pipeline[]", "current_step", "progress_percent",
                "progress_message", "create_time", "update_time", "pipeline_steps" },
  "result":  { "output_format", "content", "extracted_data", "pipeline_steps",
               "usage": { "input_tokens", "output_tokens", "pages_processed",
                          "model_used", "cost_usd", "breakdown" },
               "download_url": "/api/v1/operations/{id}/download" },
  "error":   { "code", "message", "failed_step" } }
```

| Tình huống | Status | Header |
|---|---|---|
| async bình thường | **202** | `Operation-Location: /api/v1/operations/{id}` |
| `?sync=true` | **200** | **không** có header |
| idempotent replay | **200** | **không** có header |

Quy tắc chọn status (`runner.ts:256-277`): `isSyncOrIdempotent = result.isIdempotent || executeSync`
→ 200 nếu đúng, ngược lại 202 kèm header.

**Ghi chú `sync` — cố ý khớp hệ cũ.** `executeSync=true` trả 200 **kể cả khi `done:false`**:
response body vẫn là operation chưa xong. Đây là hành vi hệ cũ và client cũ phụ thuộc vào nó
(nó đọc `done` trong body, không dựa vào status). Xem mục 4.1.

### 2.4 Lỗi submit

`apiError()` (`runner.ts:18-28`) — không có `code` trường, chỉ 4 field:

```json
{ "type": "https://dugate.vn/errors/<title-slug>", "title", "status", "detail" }
```

| Status | Title | Khi |
|---|---|---|
| 400 | `Invalid Parameter` | discriminator sai, `file_urls` hỏng |
| 400 | `Missing Parameter` | thiếu tham số bắt buộc |
| 403 | `Endpoint Disabled` | profile khoá endpoint |
| 404 | `Service Not Found` | service chưa đăng ký |
| 404 | `Workflow Not Found` | `process` không có trong registry |
| 500 | `Internal Error` | `type` cứng là `.../errors/internal` |

## 3. Operations — read, list, download, delete, cancel, resume

### 3.1 `GET /api/v1/operations/{id}`

Body = `formatOperationResponse(op)` (`lib/pipelines/format.ts:17-73`) — **cùng hàm với submit**,
không phải envelope riêng. Điều kiện phát `result` / `error` rất chặt và phải giữ nguyên:

| Điều kiện | Block phát |
|---|---|
| `done && state === "SUCCEEDED"` | `result` **đầy đủ** (mục 2.3) |
| `done && state === "FAILED"` | `error` + `result` **rút gọn** |
| `done && state === "CANCELLED"` hoặc `"TIMED_OUT"` | **không có** `result`, **không có** `error` |
| `!done` | **không có** cả hai |

Hai quirk phải copy nguyên vì client cũ dựa vào chúng:

1. **CANCELLED/TIMED_OUT là `done:true` nhưng rỗng.** Bán ra một `error` object cho cancellation là thay đổi wire.
2. **`result` của FAILED thiếu `pages_processed` và `model_used`** (`format.ts:56-63` dựng object riêng,
   không dùng object của SUCCEEDED). `legacy-action-router.ts` đã copy đúng quirk này.

Lỗi: 404 `{type:".../not-found", title:"Operation Not Found", status, detail, requested_id}` —
**có** trường `requested_id` riêng (`operations/[id]/route.ts:18-24`).

### 3.2 `GET /api/v1/operations` (list)

```json
{ "operations": [ { "name": "operations/{id}", "done": false,
                    "metadata": { "state", "endpoint_slug", "current_step",
                                  "progress_percent", "progress_message",
                                  "create_time", "update_time" },
                    "error":  { "code", "message", "failed_step" },
                    "result": { "usage": { "input_tokens", "output_tokens", "cost_usd" } } } ],
  "next_page_token": "..." | null }
```

| Query | Nguồn | Quy tắc |
|---|---|---|
| `page_size` | `operations/route.ts:31` | `Math.min(parseInt(..) ?? 20, 100)`; **không** clamp cận dưới |
| `page_token` | `:56-62` | là **id** của item cuối trang trước; server tra `createdAt` rồi `lt(createdAt)` |
| `filter` | `:41-52` | CSV `key=value`; hỗ trợ `state` và `processor` |

| `filter` | Hành vi |
|---|---|
| `state` ngoài `["RUNNING","SUCCEEDED","FAILED","PENDING"]` | **400** `{error: "Invalid state filter. Must be one of: ..."}` — body này là `{error}`, **không** phải problem+json |
| `processor=<v>` | `ilike(pipelineJson, "%v%")` |
| khoá lạ | **bỏ qua âm thầm** |

Thứ tự `createdAt DESC` cố định. Cursor là `id` (uuid), **không** phải keyset timestamp như rework.
Over-fetch `page_size + 1` để tính `hasMore`; `next_page_token` = id item cuối, `null` nếu hết trang.

**Hệ cũ chỉ lọc tenant khi header `x-api-key-id` còn tồn tại** (`:35-38`) — middleware đã xoá header
nên nhánh lọc thường không chạy. Xem mục 6; **không copy lỗi này**.

### 3.3 `GET /api/v1/operations/{id}/download`

**Stream trực tiếp, không 302** (`operations/[id]/download/route.ts:15`). Thứ tự nhánh:

1. 404 `not-found` nếu operation không có hoặc đã soft-delete.
2. 403 `forbidden` nếu lệch api key (chỉ khi header còn — mục 6).
3. 409 `not-ready` nếu `!done || state !== "SUCCEEDED"`.
4. Nếu `outputContent` có sẵn: trả **inline** với `Content-Type` + `Content-Disposition`.
5. Nếu `outputFilePath` có: stream từ storage backend, kèm `Content-Length` khi biết.
6. 404 `no-output` nếu không có cả hai.

| Nhánh | `Content-Type` | `Content-Disposition` |
|---|---|---|
| `outputFormat === "html"` | `text/html; charset=utf-8` | `attachment; filename="<base>.<ext>"` |
| `outputFormat === "json"` | `application/json; charset=utf-8` | như trên |
| còn lại | `text/markdown; charset=utf-8` | như trên |
| nhánh file, ext từ path | `text/html` / `application/json` / `text/markdown` | `attachment; filename="<basename>"` |

Tên file nhánh inline lấy từ **tên file input đầu tiên** đã lưu, không phải tên operation
(`filesData[0]?.name ?? "output"`). Không đổi sang tên do server tự sinh.
Local backend có kiểm path traversal; hành vi này giữ nguyên.

### 3.4 `DELETE /api/v1/operations/{id}`

Set `deletedAt = now()`, trả **204 No Content** với **body rỗng** (`operations/[id]/route.ts:40-68`).
404 khi không có / đã xoá; 403 khi lệch key. Mọi route khác đều coi `deletedAt` là không tồn tại.

**Chưa có cột soft-delete trong bảng `operations` của rework** (migration `0001_platform_v1.sql:36`)
⇒ cần migration, không chỉ route. Xem mục 5.1.

### 3.5 `POST /api/v1/operations/{id}/cancel`

| Tình huống | Status | Body |
|---|---|---|
| không tồn tại / đã xoá | 404 | problem+json `not-found` |
| lệch api key | 403 | problem+json `forbidden` |
| `op.done` đã true | **409** | problem+json `already-done`, detail *"Cannot cancel a completed operation."* |
| còn lại | **200** | `formatOperationResponse(updated)` |

Hệ cũ trả **200**, không phải 202. Set `done=true, state="CANCELLED", progressMessage=null`
(`cancel/route.ts:39-43`) dù worker có thể đang xử lý. **Hành vi này không copy** — xem mục 4.2.

### 3.6 `POST /api/v1/operations/{id}/resume`

```json
{ "success": true, "message": "Resumed successfully" }
```

| Tình huống | Status | Body |
|---|---|---|
| operation không tồn tại | 404 | `{error:"Operation not found"}` — **`{error}`**, không phải problem+json |
| `state !== "WAITING_USER_INPUT"` | **400** | `{error:"Operation is in state X, cannot resume. Must be WAITING_USER_INPUT."}` |
| thành công | **200** | `{success:true, message:"Resumed successfully"}` |
| lỗi server | 500 | message cố định + `correlationId` (đã harden, mục 6) |

Body nhận `{step, extracted_data}`: khi `step` khác null **và** có `extracted_data`, ghi đè
`stepsResult[stepIndex].extracted_data` và set `is_human_edited = true` (`resume/route.ts:57-63`).
Phải giữ cặt điều kiện **và** — chỉ `step` thì không sửa gì.

Các shape lỗi ở trên **không đồng nhất với problem+json** của phần còn lại. Đó là hệ cũ; copy nguyên vì
client có thể đang parse theo `{error}`.

**Hệ cũ `resume` không có fence nào** (`resume/route.ts:20-46`). Không copy — xem mục 6.

## 4. Ba quyết định cố ý lệch hệ cũ (đã chốt)

Ba mục này **không** copy hệ cũ. Mỗi mục ghi rõ lý do, để người đọc sau không tưởng là sơ suất.

### 4.1 `?sync=true` — 200 cả khi chưa xong

`API-COMPAT-DUGATE-2026-09-28.md:108` yêu cầu 200 **chỉ khi hoàn tất** và ghi
*"đừng làm yếu yêu cầu này để khớp legacy"*. Quyết định #4 **đảo** hướng đó.

| | Hệ cũ | Chốt ở đây |
|---|---|---|
| `sync=true`, operation chưa xong | **200**, body `done:false` | **200**, body `done:false` — **khớp** |
| `sync=true`, operation xong | 200, `done:true` | 200, `done:true` |
| `Operation-Location` khi `sync=true` | không gửi | không gửi |

Lý do theo hướng wire parity: client cũ đọc `done` trong **body**, không đọc status. Nếu rework trả 202
cho một request mà hệ cũ trả 200, client phân biệt được bằng status và sẽ đổi nhánh xử lý — đó là
thay đổi client behaviour, tức là **không phải parity**.

**Còn lại mở:** `COMP-10` (`API-COMPAT:59`) yêu cầu so status/header/body giữa hai hệ. Với `sync=true`
giờ đã chốt khớp, nên `COMP-10` nhất quán — nhưng dòng `:108` vẫn còn ghi ngược lại và **cần sửa**
để plan không tự mâu thuẫn (mục 7).

### 4.2 Cancel không giả terminal state

Hệ cũ set `done=true, state="CANCELLED"` ngay (`cancel/route.ts:39-43`) trong khi worker có thể đang
chạy. Điều đó làm client poll thấy `done:true` và tin là đã dừng, trong khi job vẫn ghi tiếp.

**Chốt:** trả **status + status code giống hệ cũ** (200, 409 `already-done`, 404, 403) nhưng trạng
thái nội bộ phải là `CANCEL_REQUESTED` cho tới khi worker xác nhận dừng. Response body dùng
`state: "CANCEL_REQUESTED"` — **đây là khác biệt duy nhất** và nó chỉ nằm trong `metadata.state`,
không phải shape. Nếu cần bám sát hệ cũ tuyệt đối, phải trả `CANCELLED`; nhưng như vậy là dựng
`done:true` giả, mà `API-COMPAT:56` đã cấm (*"không được che bằng fake terminal state"*).

**Cần Product/Architect ký** vì đây là lệch `metadata.state` — nằm trong 5 quyết định của `COMP-00`.

### 4.3 Không echo message lỗi 500

Hệ cũ trả `err.message` nguyên văn vào body 500 ở cả `runner.ts` (catch) và `resume/route.ts`.
`legacy-action-router.ts` đã thay bằng message cố định + `correlationId` theo `ADM-BASE-03`.
Giữ hành vi hardening; shape 500 vẫn là `{type,title,status,detail}` như legacy.

## 5. Discoverability + billing + workflows

### 5.1 `GET /api/v1/services`

```json
{ "status": 200,
  "message": "Lấy danh sách các dịch vụ AI khả dụng thành công.",
  "services": [ { "serviceId": "extract", "serviceName": "...",
                  "discriminatorKey": "type",
                  "subCases": [ { "id": "invoice" hoặc "_default", "displayName": "...",
                                  "description": "...", "clientParameters": { } } ] } ] }
```

| Hành vi | Nguồn |
|---|---|
| 401 khi thiếu `x-api-key-id` — body là **problem+json** `unauthorized` | `services/route.ts:12-22` |
| `message` là **chuỗi tiếng Việt cố định** — copy nguyên văn, không dịch | `services/route.ts:60` |
| Bỏ sub-case nếu `ProfileEndpoint.enabled === false` cho slug đó **hoặc** cho `serviceSlug` (wildcard) | `:44-52` |
| `subCases[].id` là `discriminatorValue`, fallback `_default` | `:56` |
| `clientParameters` **loại bỏ** mọi param có `defaultLocked: true` | `:53-58` |

Điểm dễ sót: `subCases` được **flatten từ registry** — một sub-case bị khoá generic sẽ không xuất hiện,
không phải trả `enabled:false`.

### 5.2 `GET /api/v1/billing/balance` — cột DB đã có; writer `total_used` còn OPEN

```json
{ "object": "billing_balance", "api_key_id": "...", "api_key_name": "...",
  "currency": "USD",
  "details": { "spending_limit": 100.0 hoặc null, "total_used": 12.5, "balance": 87.5 hoặc null },
  "updated_at": "ISO-8601" }
```

Quy tắc tính (`billing/balance/route.ts:35-49`): nếu `spending_limit > 0` thì
`balance = spending_limit - total_used`, **ngược lại `balance = null`** và `spending_limit = null`.
Không có ledger, không có bảng usage — đọc thẳng **hai cột trên bảng API key**.

**Đối chiếu source (cập nhật 2026-10-07):**

| Kiểm tra | Kết quả |
|---|---|
| `migrations/0024_legacy_parity_columns.sql:80-83` | `api_keys` nay có `name`, `spending_limit`, `total_used` (`ADD COLUMN IF NOT EXISTS`) |
| `orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts:620-664` (`loadLegacyBilling`) | đọc `name`/`spending_limit`/`total_used` từ `api_keys`; aggregate per-key từ `operations` (`state = 'SUCCEEDED' AND deleted_at IS NULL`) |
| `grep "total_used"` toàn cây | **không có writer** cập nhật cột khi operation `SUCCEEDED` |

=> **Còn OPEN:** cơ chế cập nhật `total_used` khi operation `SUCCEEDED` (grep toàn cây: không có writer).
Route đã trả đúng shape legacy, nhưng cho tới khi có writer thì `total_used` chỉ phản ánh dữ liệu được
ghi ngoài đường operation — chưa đủ để coi là parity hoàn chỉnh. `COMP-08:57` cho phép `DEFER` balance
nếu chưa có ledger — nhưng đó **không phải parity**, nên với quyết định #1 thì lối thoát defer bị loại.

**Cấm tuyệt đối:** tính `balance` từ tenant usage. Mục Endpoint catalog của `docs/06-public-api.md`
(hàng billing) đã cảnh báo và `API-COMPAT:57` nói rõ: không được đổi tenant total thành key total.
Balance là **per API key**.

### 5.3 `GET /api/v1/billing/usage`

```json
{ "object": "billing_usage", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD",
  "total_cost_usd": 0, "total_input_tokens": 0, "total_output_tokens": 0,
  "total_operations": 0,
  "usage": [ { "model": "...", "prompt_tokens": 0, "completion_tokens": 0,
                "pages_processed": 0, "cost_usd": 0 } ] }
```

| Quy tắc | Nguồn |
|---|---|
| 401 với body `{error:"Unauthorized"}` — **không** phải problem+json | `usage/route.ts:26-28` |
| Query là **`start_date`/`end_date`** (`YYYY-MM-DD`), không phải `from`/`to` của rework | `:33-35` |
| Mặc định `start_date` = **30 ngày trước**; `end_date` mặc định = hôm nay | `:37-38` |
| `end_date` được nối `T23:59:59Z` để phủ trọn ngày | `:38` |
| Ngày không parse được → 400 `{error:"Invalid date format. Use YYYY-MM-DD."}` | `:40-42` |
| Chỉ tính operation `state = SUCCEEDED` **và** `done = true` | `:57-59` |
| Gom nhóm **theo `modelUsed`**, model null → chuỗi `unknown` | `:74` |
| `total_operations` = **số dòng operation**, không phải số nhóm | `:96` |
| `start_date`/`end_date` trả dạng `toISOString().split("T")[0]` | `:101-102` |

Lưu ý: rework đã có `/api/v1/usage/summary` và `/api/v1/usage/events` với **envelope khác hẳn**.
Đó là canonical surface, giữ nguyên. Route legacy là **lớp compat riêng**, không thay thế nhau.

### 5.4 `POST /api/v1/docs/workflows`

```json
{ "name": "operations/{id}", "done": false,
  "metadata": { "state": "RUNNING", "workflow": "<process>",
                "progress_percent": 0, "progress_message": "Initializing workflow..." } }
```

| Hành vi | Nguồn |
|---|---|
| Trả **202** + `Operation-Location` | `workflows/route.ts:99-116` |
| **Không** qua `formatOperationResponse` — envelope riêng, `metadata` chỉ 4 field | `:99-110` |
| Thiếu `process` → 400 `Missing Parameter` | `:24-26` |
| `process` không có trong registry → 404 `Workflow Not Found` | `:29-31` |
| Không có file → 400 `Missing Files` | `:37-39` |
| Ba process: `disbursement`, `lc-checker`, `doc-compare` | `registry.ts:377-398` |

**KHÔNG copy (auth):** nhận `apiKeyId` từ **form field** (chấp nhận cả UUID lẫn raw key qua
sha256, `workflows/route.ts:49-75`) và **fallback sang API key role `ADMIN` cũ nhất** (`:77-86`).
Đây là đường gắn operation vào profile của key khác. `API-COMPAT:113` liệt kê nó trong
MUST-NOT-REPLICATE. Rework chỉ nhận identity từ `x-api-key`.

### 5.5 `POST /api/v1/docs/workflows/schema`

| Hành vi | Nguồn |
|---|---|
| Form field: `schemaSlug` (bắt buộc), `input` (JSON string, tuỳ chọn), files (tuỳ chọn) | `schema/route.ts:1-4,19-40` |
| Thiếu `schemaSlug` → 400 `Missing Parameter` | `:22-24` |
| Schema không import → 404 `Schema Not Found` | `:29-31` |
| Schema sai cấu trúc → 400 `Invalid Schema`, detail nối lỗi bằng dấu chấm phẩy | `:33-36` |
| **File là tuỳ chọn** — schema text-only vẫn chạy được | `:41` |
| Cùng kiểu 202 + envelope riêng như `/workflows` | `:95-110` |

Cùng cấm `apiKeyId` từ form như 5.4 (`schema/route.ts:76-79`).

### 5.6 `file_urls` — giữ contract, đổi implementation

`file_urls` là **SSRF vector** của hệ cũ: `API-COMPAT:107` ghi nhánh `fileUrlFieldName` của legacy
**tự bỏ SSRF guard** và đánh dấu tuyệt đối không tái hiện. `docs/06-public-api.md` (mục Multipart
compatibility) yêu cầu worker download theo allowlist + secret reference, không fetch trong
HTTP handler.

Giữ nguyên **contract**: field `file_urls` là JSON string, mọi lỗi validate trả đúng 400 như mục 2.2.
Đổi **implementation**: URL phải qua allowlist policy + auth tham chiếu từ profile, không truyền thẳng.

## 6. Identity — parity shape, hardening auth (NGOẠI LỆ DUY NHẤT)

Mọi endpoint trả **cùng shape, cùng status code, cùng field** như hệ cũ. Riêng **cách xác thực** được
harden. Đây là ngoại lệ duy nhất và nó đã được chốt (quyết định #2).

### 6.1 Vì sao không thể copy

`middleware.ts:33-40` cho phép mọi `/api/v1/*` đi qua và **xoá** `x-api-key-id`, `x-user-id`,
`x-user-role` khỏi request trước khi route chạy. Các route sau đó lại dựa vào chính header đó để fence:

| Route | Điều kiện fence | Hệ quả thực tế |
|---|---|---|
| `GET /operations` | `if (apiKeyId)` (`route.ts:35-38`) | header đã bị xoá ⇒ **không lọc tenant** ⇒ xem được operation của key khác |
| `GET/DELETE /operations/{id}` | `if (apiKeyId && ...)` (`:29-35`, `:54-60`) | nhánh fence **không chạy** |
| `POST .../cancel` | `if (apiKeyId && ...)` (`cancel/route.ts:24-30`) | nhánh fence **không chạy** |
| `GET .../download` | `if (apiKeyId && ...)` (`download/route.ts:29-35`) | nhánh fence **không chạy** |
| `POST .../resume` | **không có** (`resume/route.ts:20-46`) | không fence |
| `POST /docs/workflows` | `apiKeyId` từ form + fallback ADMIN key (`:49-86`) | gắn operation vào profile của key khác |

Đây là **IDOR**, không phải khác biệt hình thức. `API-COMPAT:38` đã chốt nguyên tắc:
compat **luôn** resolve identity từ `x-api-key` và fence theo tenant; nếu hardening làm consumer cũ
hỏng thì đó là **blocker migration** cần duyệt ở `COMP-00`, không được gọi là parity.

### 6.2 Quy tắc bắt buộc

1. **Identity chỉ từ `x-api-key`.** Resolve sha256 → `api_keys.hash` (giống `runner.ts:88-110`).
   Không nhận `tenantId`/`apiKeyId`/`userId` từ body, form, query hay header do client tự set.
2. **Fence luôn bật**, không có nhánh `if (apiKeyId)`. Thiếu key → 401, không phải bỏ qua.
3. **Ngoại lai ngoài workspace:** NextAuth session (UI admin) và admin bearer là đường auth riêng,
   không phải `x-api-key`. Giữ theo `docs/06-public-api.md`.
4. **Response 401/403 giữ shape legacy** (mục 2.4) để client không đổi parse.
5. **`middleware.ts` của hệ cũ không được port.** Rework không có edge xoá header; nếu sau này thêm
   edge/proxy thì nó **không được** xoá `x-api-key-id` theo kiểu cũ.

### 6.3 Rủi ro cần nói rõ

Có khả năng client cũ **dựa vào** hành vi thiếu-fence để đọc chéo dữ liệu. Nếu vậy, hardening sẽ làm
client hỏng — và đó là **blocker migration**, phải báo Product, không được gọi là parity hay là vô hại.
`COMP-00` phải có câu hỏi này.

## 7. Sai lệch trong tài liệu hiện có (cần sửa, không phải sửa code)

Bốn điểm dưới đây là **tài liệu sai so với code**, đã kiểm chứng bằng grep và đọc file:

| # | File | Nội dung sai | Bằng chứng đúng |
|---|---|---|---|
| 1 | `docs/14-reference-compatibility.md` | rework khai 28, thiếu `id-card`/`fact-check`/`summarize-eval` | `document-core.manifest.ts:79,112` có đủ; `:15` tự ghi 31 document variants |
| 2 | `API-COMPAT-DUGATE-2026-09-28.md:53` | cùng claim 31 vs 28, dùng làm lý do cho một task | như trên |
| 3 | `API-COMPAT-DUGATE-2026-09-28.md:108` | yêu cầu 200 chỉ khi xong, cấm khớp legacy | bị đảo bởi quyết định #4 (mục 4.1) |
| 4 | `docs/21-openapi.json` `x-absent` | không liệt kê `/docs/workflows`, `/services`, `/billing/*`, `/operations/{id}/download`, `DELETE /operations/{id}` | `docs/06-public-api.md` dẫn `x-absent` làm căn cứ cho các dòng đó |

Ngoài ra `tasks/README.md:132` (P9 không phải điều kiện mặc định của release đầu) mâu thuẫn với
`:13`, `:50`, `:105` (P9-01..05 trên đường găng cutover). Dòng 132 nằm cuối file trong mục Release
boundary nên người đọc tuần tự sẽ thấy sai.

**Không tự sửa các file này ở đây** — ngoài lease. Ghi lại để owner tương ứng xử lý.

## 8. Acceptance — cách chứng minh đạt parity

`API-COMPAT:59` (`COMP-10`) yêu cầu chạy cùng một legacy request trên cả hai hệ và so **status +
header + body (key và giá trị)**. Cụ thể hoá:

| Nhóm | Fixture bắt buộc | So sánh |
|---|---|---|
| 6 core action | 1 request mỗi variant = **31 fixture** | status, `Operation-Location`, toàn bộ body |
| submit sync | `?sync=true` cả 2 trường hợp (xong / chưa xong) | status **và** `done` |
| submit replay | cùng `idempotency-key` 2 lần | status 202 rồi 200, cùng `operationId` |
| lỗi decoder | discriminator sai, `file_urls` hỏng, thiếu field | status + `type` + `title` |
| `GET /operations/{id}` | 4 trạng thái: RUNNING, SUCCEEDED, FAILED, CANCELLED | có/không có `result`/`error` từng block |
| `GET /operations` | 3 trang + `filter` hợp lệ + `filter` sai | `{operations, next_page_token}` + shape item |
| `download` | chưa xong / xong-nội-tuyến / xong-file | status + `Content-Type` + `Content-Disposition` |
| `DELETE` | xoá rồi GET lại | 204 rồi 404 |
| `cancel` | operation chưa xong / đã done | 200 / 409 `already-done` |
| `resume` | đúng state / sai state | `{success,message}` / 400 `{error}` |
| `services` | profile có khoá generic | sub-case biến mất khỏi danh sách |
| `billing/balance` | limit > 0 / limit = 0 | `balance` = hiệu / `null` |
| `billing/usage` | không tham số / `start_date` sai | envelope + mặc định 30 ngày |
| workflows | 3 process + schema hợp lệ/lỗi | 202 + envelope riêng (không phải `formatOperationResponse`) |

**Fixture phải chạy offline trước.** `docs/14` ghi: không tuyên bố drop-in replacement trước khi
có fixture thực tế. 31 variant × 2 hệ là 62 lần chạy — mỗi lần ghi **status + header + body đầy
đủ** vào receipt, không chỉ ghi "pass".

**Cổng chặn:** `G-COMP` chỉ đạt khi bảng trên có receipt. Không tick gate từ file này.

**Hệ cũ echo `err.message` vào body 500** (`runner.ts`, catch block). `legacy-action-router.ts`
cố ý **không** copy (`ADM-BASE-03`): trả message cố định + `correlationId`. Giữ hành vi hardening này.
