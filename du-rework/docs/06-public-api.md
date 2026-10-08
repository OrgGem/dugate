# Public API spec v1

Base `/api/v1`. JSON UTF-8; authentication `x-api-key`; operation/artifact luôn kiểm tra tenant+key/profile policy. Không tin `x-api-key-id`, `x-user-id`, `tenantId` do client truyền như identity. Generic API là canonical; sáu document routes là compatibility facade.

## Endpoint catalog

Trạng thái theo **code hiện tại** (`orchestrator/services/orchestrator/src/server.ts`), đối chiếu `x-absent` của `docs/21-openapi.json`. "Chưa implement" nghĩa là client legacy chưa gọi được — plan [COMP-00..11](../tasks/API-COMPAT-DUGATE-2026-09-28.md) lo phần này; **không** tự tick hay dispatch từ tài liệu này.

| Method/path | Trạng thái | Input | Success | Errors chính |
|---|---|---|---|---|
| GET /health, GET /api/v1/health | Implement | none | 200 | — |
| GET /businesses | **Chưa implement** (`x-absent`) | cursor, limit | 200 enabled actions đã được profile cấp | 401 |
| GET /businesses/{id}/actions/{action}/schema | **Chưa implement** (`x-absent`) | none | 200 schema theo version profile pin | 404 nếu không được cấp |
| POST /businesses/{id}/actions/{action} | Implement | Submission | 202 Operation; 200 nếu idempotent replay | 400,401,403,409,413,415,422,429,503 |
| POST /api/v1/docs/{action} | Implement (facade compat; `action` ∈ `ingest, extract, analyze, transform, generate, compare`) — handler tại `legacy-http-mount.ts:600-646`, danh sách tại `legacy-wire-decoders.ts:12-19`. Mục `POST /docs/{action}` trong `x-absent` là tên rút gọn (thiếu `/api/v1`) **không** mô tả trạng thái route; 6 action path chưa có entry trong `docs/21-openapi.json` | JSON hoặc multipart facade | 202 Operation; 200 khi `?sync=true` hoặc idempotent replay | Như generic |
| POST /artifacts (upload standalone) | **Chưa implement** (`x-absent`) | multipart file | 201 ArtifactRef | 413,415,422 |
| GET /artifacts/{id} | **Chưa implement** (`x-absent`) | none | 200 metadata | 404 không có quyền |
| GET /artifacts/{id}/download | Implement | none | 200 raw bytes + artifact MIME (plain) hoặc 200 JSON {schemaVersion, encrypted, delivery, artifactId, mimeType} (encrypted) | 404,410 |
| GET /operations | Implement | cursor, limit, state, tenant, id, sort | 200 `{items,nextCursor,prevCursor,total,limit}` | 401,403,422 |
| GET /operations/{id} | Implement | none (`?wait=` long-poll) | 200 Operation | 404 |
| GET /operations/{id}/result | Implement | none | 200 ResultEnvelope strict v1 (plain) hoặc 200 JSON {schemaVersion, encrypted, delivery} (encrypted) | 409 chưa succeeded; 410 expired |
| POST /operations/{id}/cancel | Implement | optional reason | 202 hoặc 200 replay | 409 terminal không cancellable |
| POST /operations/{id}/resume | Implement | waitId, input, expectedStateVersion | 202 hoặc 200 replay | 409 stale/terminal,422 invalid input |
| GET /usage/summary, GET /usage/events, GET /usage | Implement (admin-bearer và public-key path trong `route(ctx)`) | filter allow-list | 200 | 401,403,422 |
| GET /connectors/{id}/test | Implement | none | 200 test result | 401,403,404 |
| POST /uploads, POST /uploads/{id}/{part,complete,abort} | Implement (multipart upload gateway) | multipart | 200/201 | 413,415,422 |
| GET/POST /api/v1/admin/audit, /api/v1/admin/crypto-config, /api/v1/admin/businesses*, /api/v1/admin/profiles*, /api/v1/admin/connectors*, /api/v1/admin/api-keys* | Implement (surface admin — không phải public client API) | admin bearer | 200 | 401,403,404,422 |
| Surface runtime `/api/runtime/v1/**` (tasks claim/heartbeat/steps/complete, artifacts finalize/access/multipart, invocation-grants, workspace-reference) | Implement (internal worker; worker credentials bị chặn khỏi surface public tại `route(ctx)`) | runtime auth | 200 | 401,403,404 |
| GET /api/v1/services | Implement (facade) — **hiện trả 500 `Internal Error`** vì `serviceCatalogue` chưa được wire trong host adapter (known gap; pin bởi test `rv01-loopback-http-offline.test.ts` "answers 500 while unwired, never an empty catalogue") | legacy query | 200 khi catalogue được wire | 401*,500 |
| GET /api/v1/billing/balance, GET /api/v1/billing/usage | Implement (facade, projection per API key) — handler tại `legacy-http-mount.ts:806-884`; `billingFor` wired tại `legacy-host-adapter.ts:428` (`loadLegacyBilling` đọc `api_keys.spending_limit/total_used` từ migration `0024_legacy_parity_columns.sql` + aggregate `operations`); **không** lấy từ tenant usage. OPEN: chưa có cơ chế cập nhật `total_used` trong cây | legacy query | 200 | 400,401*,404,500 |
| POST /api/v1/docs/workflows, POST /api/v1/docs/workflows/schema | Facade admission đã implement; admission/error/auth + schema pin có evidence độc lập; runtime còn lại OPEN theo WFA plan (chia theo nhóm acceptance ở mục Workflow compatibility facade) | multipart + process/schemaSlug | 202 + Operation-Location | 400,401,403,404,409,413,415,422,429,503 |

**Known gap của generator OpenAPI:** `tools/openapi/gen_openapi.py` sinh `docs/21` từ router + contracts nhưng chưa cover đủ các route admin/uploads/runtime liệt kê trên; khi chạy generator, path mới hơn `x-absent` cũ có thể chưa vào spec. Không sửa tay `docs/21` (serialize-point) — mở task cho docs/COMP-11 owner mở rộng generator thay vì patch JSON.

**Known gap auth của facade (RV01-F4, còn RED):** các nhánh legacy read dùng `safePrincipal` (operations, billing, services) khi thiếu hoặc sai key hiện trả **500 `Internal Error`** thay vì 401 — pin bằng `it.failing` trong `orchestrator/services/orchestrator/tests/rv01-loopback-http-offline.test.ts:1499-1510`; các ô `401*` ở bảng trên là mục tiêu contract, chưa phải hành vi hiện tại. `RV01-F5` (unknown `/api/v1/docs/<slug>` rơi về 404 canonical thay vì namespace legacy) cũng còn RED — owner: compat/API lane.

V1 không expose arbitrary public route registration. `/api/v1/docs/workflows` giữ route/tham số legacy và ánh xạ nội bộ tới registered business/action qua cùng admission/submission service, không redirect hoặc gọi HTTP vòng lại route business.

### Workflow compatibility facade (WFA, 2026-10-07)

Plan và acceptance matrix: [WORKFLOW-API-BACKWARD-COMPAT-2026-10-07](../tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md). Facade đã được nối trong `orchestrator/services/orchestrator/src/compat/legacy-http-mount.ts`; bằng chứng admission và schema catalog nằm trong [verification receipt](../coordination/reports/wfa-verification-2026-10-07.md). Đây chưa phải xác nhận hoàn tất runtime hoặc cutover.

`POST /api/v1/docs/workflows` nhận multipart `process` thuộc `disbursement`, `lc-checker`, `doc-compare`; nhận `resolution_data` cho disbursement. File được lấy theo thứ tự `files[]`, `source_file`, `target_file`, `file`, bỏ file rỗng; named process yêu cầu ít nhất một file. Mapping tương ứng là `document-core/disbursement`, `lc-checker/lc-checker`, `document-core/doc-compare`; adapter phải giữ semantics legacy thay vì chỉ đổi tên.

`POST /api/v1/docs/workflows/schema` nhận multipart `schemaSlug`, `input` là chuỗi JSON object (mặc định `{}`), cùng các file fields trên. Schema hợp lệ có thể không cần file. Schema được resolve theo tenant của API key, chốt revision/digest tại admission và lưu mã hoá; worker phải dùng pin đó cả khi resume, không đọc lại latest mutable schema.

Hai route trả operation mới `202`, `Operation-Location` là URL polling tương đối và envelope `{name,done:false,metadata:{state:"RUNNING",workflow,progress_percent:0,progress_message}}`. Giữ hành vi legacy: **luôn tạo operation mới** và **bỏ qua `?sync`/`Idempotency-Key`** — phạm vi "bỏ qua" chỉ đúng cho hai route workflow này; sáu core action `POST /api/v1/docs/{action}` tôn trọng cả hai (`?sync=true` trả 200 và idempotent replay trả 200 cùng operation — `legacy-http-mount.ts` `submitOptions`/`legacySubmitResponse`, xem [docs/39](39-legacy-parity-contract.md) §4.1). `x-api-key` đang hoạt động là bắt buộc; `apiKeyId` nếu gửi chỉ được khớp caller đã xác thực, không chọn identity khác và không fallback ADMIN key. Việc chỉ nhận JSON object là hardening được ghi riêng trong WFA plan. OpenAPI của hai route được sinh bằng generator, không sửa JSON trực tiếp.

Ví dụ client Bash sau khi admin đã đăng ký/activate business version, gắn profile/action/connector bindings, provision schema tenant và cấu hình mã hoá metadata/artifact. `DU_API_KEY` là biến môi trường của client; không đưa giá trị thật vào tài liệu hoặc git:

```bash
curl -i -X POST http://localhost:3000/api/v1/docs/workflows \
  -H "x-api-key: $DU_API_KEY" \
  -F 'process=disbursement' \
  -F 'resolution_data=approved-resolution' \
  -F 'files[]=@./synthetic-document.pdf'

curl -i -X POST http://localhost:3000/api/v1/docs/workflows/schema \
  -H "x-api-key: $DU_API_KEY" \
  -F 'schemaSlug=example-input-only' \
  -F 'input={"message":"synthetic-input"}'
```

Lấy URL từ `Operation-Location` để polling với cùng API key. Schema không tồn tại trả 404; deployment thiếu cấu hình mã hoá workflow trả lỗi trước khi upload/admission. Không provision bằng cách ghi JSON plaintext trực tiếp vào `legacy_workflow_schemas`.

#### Trạng thái kiểm chứng WFA (2026-10-07)

Chỉ các nhóm dưới đây có evidence độc lập tại [wfa-verification](../coordination/reports/wfa-verification-2026-10-07.md) / [wfa-integration](../coordination/reports/wfa-integration-2026-10-07.md); phần còn lại **OPEN** — không suy ra ACCEPTED.

| Nhóm acceptance (WFA) | Trạng thái | Evidence / còn lại |
|---|---|---|
| T04–T13, T29–T32 — admission/error/auth, không side-effect | **VERIFIED (real HTTP, pre-admission)** | 401/400/403/404 đúng contract; số operation/task/outbox/artifact/idempotency không đổi sau reject; admin fallback bị từ chối; route-projection giữ đúng 202 + envelope dù có `sync`/`Idempotency-Key` |
| T14, T37 — schema pin bất biến + provision/load trên DB sạch | **VERIFIED** | Worker giữ revision-1 admission pin dù active schema tiến revision 2; catalog test trên schema PostgreSQL mới (4 suites / 11 tests), teardown sạch |
| T16/T17, T23/T24 — node `parallel`/`join`/`human`/`input` | **VERIFIED (schema executor)** | Worker thật + rerun riêng; HITL resume tuần tự và parallel join với encrypted branch artifacts |
| T01–T03 — named chains thật | **OPEN** — owner: API/runtime + verifier | `disbursement`/`lc-checker` chưa có e2e độc lập; `doc-compare` mới có nhánh fail async; next: success chains trên stack cô lập |
| T15, T18–T22 — node adapters còn lại | **OPEN** — owner: runtime/API | connector/file_parse/file_url_download/callback/archive_compress/archive_extract chưa có worker evidence |
| T25–T28 — lifecycle ngoài case đã test | **OPEN** — owner: verifier | restart/retry tránh side effect, cancel dừng provider work; paused cancel đã nằm trong suite 8/8 |
| T33–T36 — security bounds | **OPEN** — owner: runtime + verifier | SSRF/egress/callback policy, archive/path/prototype, size bounds, redaction |
| T38 — docs + OpenAPI | **IMPLEMENTED (docs owner)** | Generator 61 paths · 0 drop, regen byte-identical qua 2 lan regen, validate exit 0; [wfa-docs receipt](../coordination/reports/wfa-docs-2026-10-07.md) — reviewer độc lập quyết định close |

Suite điều khiển đầy đủ HTTP → PostgreSQL → outbox → Redis → production worker **8/8** (10/7 19:35) là mốc lịch sử cho pin/HITL/cancel ở trên; trong cùng ngày nó đã được supersede bởi các full-file run **10/10 → 11/11 ×2 → 13/13 ×3** (mới nhất, đã gồm named T01–T03 và leaf-node/fence — bảng run: [wfa-qwen-handover-2026-10-07.md](../coordination/reports/wfa-qwen-handover-2026-10-07.md) §2–§3). Raw log nằm ở `tests/workflow-api/logs/` dạng file cục bộ (thư mục untracked, `*.log` bị gitignore) nên chỉ receipt `.md` là con trỏ citable; sau đợt T26/T27 fail-first, full file hiện RED ở đúng 2 test đó. Provider vẫn là loopback mock, **chưa** phải provider bên thứ ba.

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

`sort` là tham số thứ sáu của contract, sau `limit`, `cursor`, `state`, `tenant`, `id`. Danh sách hợp lệ **không** do route tự định nghĩa: `parseOperationsListSort` trong `orchestrator/packages/contracts/src/public-api.ts` là nguồn duy nhất, và cả schema `ListOperationsQuerySchema` lẫn route đều gọi đúng hàm đó — nên tài liệu công bố không thể nhận một giá trị mà route sẽ 422.

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
>> Nguồn: `orchestrator/services/orchestrator/src/server.ts` (`encodeOperationsListCursor`, `decodeOperationsListCursor`, `parseOperationsListQuery`, `parseOperationsListSortParam`, `bindOperationsCursor`) và `orchestrator/packages/contracts/src/public-api.ts` (`OPERATIONS_LIST_SORT_FIELDS`, `OPERATIONS_LIST_SORT_DIRECTIONS`, `OPERATIONS_LIST_SORT_VALUES`, `parseOperationsListSort`, `formatOperationsListSort`, `LIST_CURSOR_MAX_LEN`) — đọc trực tiếp từ source, **không chép từ lời Reviewer**.

### Tenant fence và lỗi

- **x-api-key**: API key là hàng rào. `tenant` chỉ được chấp nhận khi **bằng** tenant của key; giá trị khác trả **403 `PERMISSION_DENIED`** thay vì bị bỏ qua, để không caller nào tin rằng mình đã mở rộng tầm nhìn.
- **Admin bearer** (alternate path cho Admin shell, không phải bề mặt client public): platform principal hẹp được về bất kỳ tenant nào bằng `?tenant=`; tenant operator bị ghim vào tenant của nó bằng SQL predicate (fence ở server, không post-filter) và nhận 403 cho `tenant` ngoại lai, cùng cách diễn đạt cho id lạ và id ngoại lai.
- Mã lỗi của endpoint này: **401** (thiếu/sai auth), **403** (tenant ngoài phạm vi), **422** (`state` / `tenant` / `id` / `cursor` / `sort` không hợp lệ). Route này **không** sinh 400. Tên query nằm ngoài allow-list bị **bỏ qua**, không phải 422 — và route không bao giờ echo lại một tên lạ.
- Tham số này được đọc qua seam `AllowListedQuery`, có kiểu là phần tử của `OPERATIONS_LIST_QUERY_PARAMS`, nên `read("sort")` là **lỗi biên dịch**. Đọc một tham số ngoài allow-list là lỗi build, không phải một accept im lặng.

### Trạng thái bằng chứng

Mục này mô tả **hành vi đang triển khai** và được đồng bộ theo yêu cầu packet 1 của Reviewer Turn 40 (finding 1). Mức hiện tại: **IMPLEMENTED / offline VERIFIED** — Turn 30 ghi nhận `prevCursor` tính sai hướng là đã được sửa tại ranh giới code, và Qwen-Admin có roundtrip trang 1 → 2 → 1 trên fake DB có trạng thái. **Chưa ACCEPTED:** chưa có bằng chứng render trình duyệt, query plan / `EXPLAIN` trên dữ liệu seed thật, hành vi khi có insert chen giữa hai trang, hay tenant isolation trên service đã deploy. Quyết định index composite `(tenant_id, created_at DESC, id DESC)` và receipt query-plan do Tester giữ vẫn mở (Δ13); `G-ADMIN-OPS` mở.

**Đồng bộ `sort` (Reviewer Turn 140, finding T140-D1).** Bảng tham số ở trên nay có sáu tên, khớp `OPERATIONS_LIST_QUERY_PARAMS` đọc trực tiếp từ source. Mức của riêng phần `sort`: **IMPLEMENTED / offline VERIFIED** — W-ADMUX02-SORT-ALLOWLIST-1 báo 385/385 contracts, 108/108 targeted ×3, typecheck exit 0. **Chưa live VERIFIED:** chưa receipt nào chạy `sort=updated_at` hay `sort=deadline_at` trên PostgreSQL thật, và migration 0017 chỉ có index cho `created_at`, nên hai sort còn lại chưa có index khớp và chưa có query plan. **Chưa ACCEPTED** — một phần vì T140-A1 (cursor chưa ràng buộc với sort) vẫn mở, một phần vì Admin shell chưa có sort control nào.

**Hai chỗ khác trong cây tài liệu từng còn contract cũ, nay đã xử lý:** `docs/20-openapi-descriptions.md` đã mang envelope 5 trường và tập tham số allow-list, và `docs/19-traceability-audit-matrix.md` §4 đã có dòng cho contract list này (D-DOCS-CONTRACT-SYNC-1); câu chữ cũ trong renderer (Δ14) đã đóng upstream bằng W-ADMUX02-CLEAN-1 + W-ADMUX02-COPY-2. **Phần còn trôi của T140-D1** nằm ở `coordination/gates/contracts-v1.md` — bảng module map vẫn liệt kê contract cũ, và file đó tự ghi `Owner: Claude (platform lane)`, nên nó nằm ngoài phạm vi sửa của lane tài liệu; nó được ghi lại ở `docs/28` / `docs/35` thay vì bị sửa lặng lẽ. Nguồn: `orchestrator/services/orchestrator/src/server.ts` và `orchestrator/packages/contracts/src/public-api.ts`, đọc trực tiếp — **không chép từ lời Reviewer**. Mục này mô tả contract theo **symbol và hành vi quan sát được**, không neo vào số dòng, nên nó không bị cũ khi file dịch dòng; nhưng nếu envelope, tập tham số **hoặc chính sách cursor/sort** thay đổi, phần này **phải đồng bộ lại** — không suy ra từ vị trí dòng.

## Submission

`sourceUrl` hỗ trợ HTTPS và `s3://bucket/key` (tuỳ chọn `?versionId=...`). Nguồn S3 dùng IAM role của Orchestrator qua AWS SDK, không cần presigned URL/access key trong request; bắt buộc deployment có S3 artifact backend và rule tenant/bucket/prefix/region/owner. Xem [S3 role source ingestion](s3-role-source-ingestion.md) cho cấu hình, quyền cross-account, giới hạn và trạng thái kiểm chứng.

```json
{
  "input": { "type": "invoice", "language": "vi" },
  "artifacts": [{ "artifactId": "uuid", "role": "source" }],
  "output": { "format": "json" },
  "callback": { "url": "https://client.example/callback" },
  "clientReference": "invoice-123"
}
```

`input` validate theo action schema. `artifacts` optional nếu action cho text-only; roles action định nghĩa. `sourceUrl` (optional, `string` max 2048, contract `SubmissionSchema.sourceUrl`) chỉ được chấp nhận khi deployment backend là `s3` — khi `storageBackend !== 's3'` request chứa `sourceUrl` bị từ chối **422 `UNSUPPORTED_STORAGE_BACKEND`** (`submission.ts:113-122`) ngay sau schema parse thuần túy, trước bất kỳ DB write nào (zero rows: không operation/task/outbox, không parked `PENDING_INGESTION`). Quyết định T200-D1: giữ `sourceUrl` trong published schema và trả 422 thay vì capability-gating (ẩn field khỏi schema theo backend) — 422 là contract rõ ràng, client không thể dự đoán backend từ API nên cần mã lỗi wire-visible trong `PublicErrorCodes` (`orchestrator/packages/contracts/src/errors.ts`) thay vì silent omission; capability-gating sẽ làm cùng payload vừa hợp lệ vừa không hợp lệ tùy deployment mà không có tín hiệu nào. Profile chọn version/connector; client không truyền queue, credential, model hay prompt bị khóa để override.

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

**Delivery encryption cho webhook (W-ENC-08-WEBHOOK, receipt qwen-admin Mục 29):** payload webhook khi tenant bật recipient encryption được mã hóa trước khi gửi — **Δ120:** HMAC signature giờ phủ trên **ciphertext**, nên receiver phải verify chữ ký trên encrypted body rồi mới decrypt (đây là thay đổi hợp đồng nhận, lane sở hữu receiver và tài liệu tích hợp phải được thông báo); **Δ121:** cột `webhook_deliveries.payload` trong DB vẫn lưu plaintext (thuộc ENC-META-01, chưa đóng). `G-ENC`/`G6` vẫn NO-GO.

## Result delivery encryption (ADR-18 baseline — wire đã đóng, runtime còn mở)

> **Trạng thái (cập nhật mới):** `RESULT-WIRE-01` **ĐÃ ĐÓNG** ở contract freeze: xem mục *Frozen result/download response contract* bên dưới — result/download không còn 302. **Runtime delivery encryption đã có code path**: `delivery-encryption.ts` + `artifact-read-decrypt` + `metadata-key-adapter` (read path), `public-upload-encryption-gateway`, `runtime-encryption-metadata`, `webhook-delivery-encryption` — phủ bằng test offline (`delivery-encryption.test.ts` 50/50×3, `webhook-delivery-encryption.test.ts`, `artifact-read-decrypt-offline.test.ts`). Tuy nhiên `ENC-00` vẫn `[~]`, **ENC-04 NO-GO** (qwen-platform Δ114–Δ116 cần sửa production), `ENC-08` chưa ACCEPTED — nên section dưới đây là baseline ADR-18 **đã được code thừa hành một phần**, chưa phải runtime wire hoàn chỉnh để bật cho tenant. **Chính sách legacy:** theo COMP plan quyết định #5, tenant/client legacy giữ plaintext cho tới khi admin **và** external consumer chủ động opt-in/migrate; không tự đổi mặc định khi cutover; không có param/header bypass.

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


## Portal request controls

Operation views add nullable startedAt/completedAt, retryOf and errorCode. The admin detail also exposes safe task summaries. operations.retry is a platform-admin action; unavailable input returns 409 RETRY_INPUT_UNAVAILABLE. See [Portal request management](portal-request-management.md).
