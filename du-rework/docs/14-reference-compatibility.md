# Reference mapping và compatibility policy

Repository cũ là read-only reference. Không copy `.env`, DB dumps, uploads, private document fixtures, generated worker.js hay node_modules. Không import `../../../../lib` từ implementation mới.

## Source pointers

| Reference | Tham khảo | Thiết kế mới |
|---|---|---|
| [registry](../../lib/endpoints/registry.ts) | Six actions, **31 subcases** (4/6/7/5/6/3) + 3 workflows (`:73`–`:396`) | Business manifest/versioned schemas |
| [runner](../../lib/endpoints/runner.ts) | Public facade, multipart normalization | Thin adapter → generic submission |
| [profile resolver](../../lib/endpoints/profile-resolver.ts) | Defaults/locks | Separate ProfileRevision + key binding |
| [submit](../../lib/pipelines/submit.ts) | Async/sync/idempotency | Transactional operation+outbox |
| [pipeline engine](../../lib/pipelines/engine.ts) | Step chaining/session/usage | document-core + SDK/full checkpoint |
| [workflow engine](../../lib/pipelines/workflow-engine.ts) | Child tasks and human wait | Business-owned workflow + generic runtime persistence |
| [external processor](../../lib/pipelines/processors/external-api.ts) | Request/response mapping | Connector adapters; native parsing tách document-kit |
| [storage](../../lib/storage/index.ts) | Local/S3 adapter pattern | Object refs+scoped access, no cross-container local paths |
| [schema builder types](../../lib/workflow-builder/types.ts) | DSL/node families | Future schema-workflow business, no DSL interpreter in platform |

## Legacy API spec (from code)

Nguồn: **root repo `D:\Git\dugate`, ngoài `du-rework/`** — `app/api/v1/**` + `lib/**`. Toàn bộ mục này là **characterization** của wire cũ, đọc trực tiếp từ code, không phải từ `CLAUDE.md` hay `docs-site`.

### Đường dẫn thật (filesystem là chuẩn)

| Route | File | Ghi chú |
|---|---|---|
| `POST /api/v1/docs/ingest` | `app/api/v1/docs/ingest/route.ts:5-7` | Comment dòng 1 viết `/api/v1/ingest` — **sai**; registry khai `POST /api/v1/docs/ingest` (`registry.ts:73`) |
| `POST /api/v1/docs/extract` | `app/api/v1/docs/extract/route.ts` | `registry.ts:115` |
| `POST /api/v1/docs/analyze` | `app/api/v1/docs/analyze/route.ts` | `registry.ts:174` |
| `POST /api/v1/docs/transform` | `app/api/v1/docs/transform/route.ts` | `registry.ts:241` |
| `POST /api/v1/docs/generate` | `app/api/v1/docs/generate/route.ts` | `registry.ts:287` |
| `POST /api/v1/docs/compare` | `app/api/v1/docs/compare/route.ts` | `registry.ts:341` |
| `POST /api/v1/docs/workflows` | `app/api/v1/docs/workflows/route.ts:15` | Comment `:1` viết `/api/v1/workflows` — **sai**; `registry.ts:376` |
| `POST /api/v1/docs/workflows/schema` | `app/api/v1/docs/workflows/schema/route.ts:15` | Trigger schema-driven workflow |
| `GET /api/v1/operations` | `app/api/v1/operations/route.ts:29` | `page_size`/`page_token`/`filter` |
| `GET`/`DELETE /api/v1/operations/{id}` | `app/api/v1/operations/[id]/route.ts:14,40` | DELETE = soft delete, 204 |
| `POST /api/v1/operations/{id}/cancel` | `.../[id]/cancel/route.ts:10` | 409 nếu `done` |
| `POST /api/v1/operations/{id}/resume` | `.../[id]/resume/route.ts:20` | Chỉ `WAITING_USER_INPUT`; **không fence** |
| `GET /api/v1/operations/{id}/download` | `.../[id]/download/route.ts:15` | 200 stream, không 302 |
| `GET /api/v1/services` | `app/api/v1/services/route.ts:8` | 401 nếu thiếu `x-api-key-id` |
| `GET /api/v1/billing/balance` | `app/api/v1/billing/balance/route.ts:17` | `spending_limit - total_used` |
| `GET /api/v1/billing/usage` | `app/api/v1/billing/usage/route.ts:24` | `start_date`/`end_date` |

Sáu core route **không** có logic riêng — tất cả gọi `runEndpoint(serviceSlug, req)` (`lib/endpoints/runner.ts:58`). Swagger sinh từ chính registry (`app/api/swagger/route.ts`), bỏ param `defaultLocked`.

### Discriminator + 31 sub-case

| Service | Discriminator (form field) | Sub-case | Registry |
|---|---|---|---|
| ingest | `mode` | `parse`, `ocr`, `digitize`, `split` | `:74`, `:76-101` |
| extract | `type` | `invoice`, `contract`, **`id-card`**, `receipt`, `table`, `custom` | `:116`, `:118-158` |
| analyze | `task` | `classify`, `sentiment`, `compliance`, **`fact-check`**, `quality`, `risk`, **`summarize-eval`** | `:175`, `:177-229` |
| transform | `action` | `convert`, `translate`, `rewrite`, `redact`, `template` | `:242`, `:244-272` |
| generate | `task` | `summary`, `outline`, `report`, `email`, `minutes`, `qa` | `:288`, `:290-326` |
| compare | `mode` | `diff`, `semantic`, `version` | `:342`, `:344-361` |
| workflows | `process` | `disbursement`, `lc-checker`, `doc-compare` (`isWorkflow: true`) | `:377`, `:379-398` |

**31 core sub-case** (4+6+7+5+6+3). Rework manifest khai **28** — thiếu `extract:id-card`, `analyze:fact-check`, `analyze:summarize-eval`; đây là nguồn của mismatch "31 vs 28", không phải lỗi đếm của một bên.

### Input chuẩn (multipart/form-data)

| Field | Vị trí | Ý nghĩa | Nguồn |
|---|---|---|---|
| `file` / `files[]` | form | Một / nhiều file | `runner.ts:36-54` |
| `source_file`, `target_file` | form | 2 tài liệu (compare) | `runner.ts:47-49` |
| `file_urls` | form (JSON string) | `[{url, filename?, mime_type?}]`, cap `MAX_FILE_URL_ENTRIES`, validate URL | `runner.ts:129-156` |
| `mode`/`type`/`task`/`action`/`process` | form | Discriminator; sai → 400 kèm danh sách hợp lệ | `runner.ts:113-123` |
| `output_format` | form | `md\|json\|html\|csv`, default `json` | `runner.ts:226`, `registry.ts:40` |
| `language`, `pages` | form | `vi\|en\|ja\|zh`; `"1"`, `"1-5"`, `"1,3,5"` | `registry.ts:41-42` |
| param riêng sub-case | form | `fields`, `schema`, `categories`, `criteria`, `reference_data`, `extract_fields`, `focus`, `focus_areas`, `target_language`, `tone`, `glossary`, `style`, `redact_patterns`, `template`, `max_words`, `format`, `audience`, `questions` | `registry.ts:43-62` |
| `webhook_url` | form | Callback khi xong | `runner.ts:227` |
| `sync=true` | **query** | Bounded wait; mặc định async | `runner.ts:229` |
| `idempotency-key` | header | Chống submit trùng | `runner.ts:228` |
| `x-api-key` | header | Sha256 lookup trong chính runner | `runner.ts:88-110` |
| `x-correlation-id` | header | Trace, default random | `runner.ts:59` |
| `schemaSlug`, `input` | form | Chỉ route `workflows/schema` | `schema/route.ts:19,40` |

Param đã `defaultLocked` trong profile không lộ ra client (`services/route.ts:53-58`, swagger generator).

### Response wire

**Submit (6 core)** — `formatOperationResponse` (`lib/pipelines/format.ts:17-73`), `202` async + header `Operation-Location: /api/v1/operations/{id}`, `200` khi `sync=true` hoặc idempotent hit (`runner.ts:256-277`):

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

`result` chỉ có khi `done && SUCCEEDED`; `error` khi `done && FAILED` (kèm `result.pipeline_steps` + `usage` nếu có dữ liệu chạy dở) — `format.ts:35-70`.

**Lỗi** — problem+json nhưng namespace là `https://dugate.vn/errors/*`, kèm `title`, `status`, `detail` (`runner.ts:18-28`): 400 `Invalid Parameter` / `Missing Parameter`, 403 `Endpoint Disabled`, 404 `Service/Workflow Not Found`, 500 `Internal Error`.

**List** — `{ "operations": [ {name, done, metadata{state, endpoint_slug, current_step, progress_percent, progress_message, create_time, update_time}, result|error? } ], "next_page_token": string|null }`; `page_size` default 20 max 100, cursor là `id` của item cuối, sort `createdAt desc` (`operations/route.ts:29-130`). `filter` = CSV `state=…`,`processor=…` (`:42-56`).

**Workflows** — không dùng `formatOperationResponse`: trả thẳng `{name, done:false, metadata:{state:'RUNNING', workflow, progress_percent:0, progress_message}}` 202 (`workflows/route.ts:99-116`, `schema/route.ts:95-110`).

**Resume** — `{ success: true, message: 'Resumed successfully' }`; body `{ step, extracted_data }` ghi đè step và đánh dấu `is_human_edited` (`resume/route.ts:57-63,98`).

**Services** — `{ status, message, services: [{ serviceId, serviceName, discriminatorKey, subCases: [{ id, displayName, description, clientParameters }] }] }`, bỏ endpoint bị khoá theo `ProfileEndpoint.enabled` kể cả khoá ở mức service (`services/route.ts:44-66`).

**Billing** — `balance`: `{ object:'billing_balance', api_key_id, api_key_name, currency:'USD', details:{ spending_limit, total_used, balance }, updated_at }`, `balance = spending_limit - total_used`, `null` nếu không đặt limit (`balance/route.ts:35-49`). `usage`: `{ object:'billing_usage', start_date, end_date, total_cost_usd, total_input_tokens, total_output_tokens, total_operations, usage:[{model, prompt_tokens, completion_tokens, pages_processed, cost_usd}] }`, mặc định 30 ngày, chỉ tính `SUCCEEDED && done` (`usage/route.ts:34-95`).

### Auth/fence thật của legacy (nguồn của yêu cầu "không copy lỗ hổng")

`middleware.ts:33-53` cho phép mọi `/api/v1/*` đi qua, **xoá** `x-api-key-id`/`x-user-id`/`x-user-role` từ request rồi chỉ inject lại `x-user-*` từ NextAuth session. Hệ quả trực tiếp:

- Core submit an toàn vì runner tự hash `x-api-key` (`runner.ts:88-110`) và fence profile bằng `apiKeyId` đó.
- `GET /operations` chỉ filter `eq(operations.apiKeyId, apiKeyId)` khi header có mặt (`operations/route.ts:35-38`) → client gọi bằng `x-api-key` thuần **không có điều kiện tenant** ⇒ xem được operation của key khác.
- `GET|DELETE /operations/{id}`, `cancel`, `download` fence bằng `if (apiKeyId && op.apiKeyId !== apiKeyId)` (`[id]/route.ts:29-35,54-60`; `cancel/route.ts:24-30`; `download/route.ts:29-35`) ⇒ header bị xoá thì nhánh fence không chạy.
- `resume` **không** có fence nào (`resume/route.ts:20-46`).
- `services`, `billing/balance`, `billing/usage` 401 khi thiếu `x-api-key-id` (`services/route.ts:12-22`, `balance/route.ts:19-21`, `usage/route.ts:26-28`) ⇒ wire cũ phụ thuộc header mà edge đã xoá.
- Workflows nhận **`apiKeyId` từ form field** (UUID **hoặc** raw key, `workflows/route.ts:49-75`) và **fallback sang API key role ADMIN cũ nhất** (`:77-86`, `schema/route.ts:76-79`); operation bị gắn vào profile của key khác.
- `cancel` set `done=true, state='CANCELLED'` dù worker vẫn có thể đang xử lý (`cancel/route.ts:39-43`).

Ràng buộc đã chốt ở [API-COMPAT-DUGATE-2026-09-28](../tasks/API-COMPAT-DUGATE-2026-09-28.md): compat **luôn** resolve identity từ `x-api-key` và fence theo tenant; nếu hardening làm consumer cũ hỏng thì đó là blocker migration cần duyệt ở `COMP-00`, không được gọi là parity.

## Compatibility dispositions

| Feature | Release đầu | Release sau / ghi chú |
|---|---|---|
| Six `/api/v1/docs/*` action routes | Giữ path và legacy wire mặc định qua facade, 31 variants | Canonical DTO trên surface/version riêng hoặc explicit opt-in cho client mới; COMP-02 freeze |
| JSON/multipart, single/multi/source/target files | Hỗ trợ input normalization | Exact accepted fields P0 inventory |
| sync=true | Bounded wait → 200/202 | Không blocking business execution tại API |
| Profile routing/locked parameters | Bắt buộc | Prompt policy mới minh bạch, không raw `_prompt` |
| Operations polling/list/cancel/resume/DELETE/download | Legacy default trên method/path cũ; continuity IDs/cursor/lifecycle | COMP-05..07 + CONT-03/04; canonical surface không thay default client cũ |
| file_urls | Worker download theo allowlist và secret ref | Không mặc định chuyển arbitrary URLs đến provider |
| `/docs/workflows` disbursement/lc-checker/doc-compare | Bắt buộc trước cutover qua COMP-09/P9 | Per-business deployment/queue; không alias sang sáu core action |
| `/docs/workflows/schema` | Bắt buộc trước cutover, P9-04/COMP-09 | schemaSlug và config import/ownership theo CONT; không interpreter trong Orchestrator |
| Workflow visual builder | Theo cutover register PAR-00 | Tách public schema execution bắt buộc khỏi phạm vi visual designer |
| Billing balance/usage legacy | Parity nếu consumer inventory đang dùng, COMP-08 | Không suy balance từ tenant usage; retire chỉ sau approved consumer decision |
| Data/credential continuity | CONT-00..05 planning/tool/rehearsal trước G-COMP/G6 | Project/DB mới độc lập; authorized export/import, giữ key hash/config/operations, rollback; production migration/traffic switch là bước riêng |

Không tuyên bố drop-in replacement trước khi consumer compatibility matrix có fixture request/response thực tế được cấp quyền. Đầu ra lỗi/shape cũ cần characterization tests trước khi quyết định giữ hay sửa.

[Bổ sung plan 2026-10-04](../tasks/PLAN-COMPLETION-2026-10-04.md) là acceptance continuity: fixture client/key có trước migration và operation/HITL/cursor/download còn sống phải tiếp tục hoạt động qua owner routing đã freeze; không chỉ key mới + happy-path submit. P9 → G-COMP → G6; actual production migration/cutover không được tự thực hiện từ tài liệu này.

## Known issues cần tránh mang sang

Pipeline catch lỗi nhưng BullMQ không thấy failure; checkpoint dùng preview 500 ký tự; parent workflow giữ slot khi chờ child; DB create/enqueue không atomic; child+parent cộng phí; local paths giữa containers; runtime config đổi giữa các attempts. Test catalog có RUN/OPS/USE cases tương ứng.
