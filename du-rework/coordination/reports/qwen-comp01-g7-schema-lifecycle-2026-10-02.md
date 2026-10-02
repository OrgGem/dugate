# COMP01-G7 — schema lifecycle trace end-to-end (read-only characterization)

- **TaskRef**: `task_8c05e0eba07d`
- **Spec**: `du-rework/coordination/dispatch-specs/2026-10-02-0335-COMP01-G7-schema-lifecycle.md`
- **Date**: 2026-10-02
- **Lane**: `qwen_4` (codex) — characterization only
- **Gates ticked**: NONE. All `G-*` remain NO-GO.
- **Commits**: NONE. No existing file modified, created or deleted.
- **Security**: legacy issues are recorded as **factual lifecycle facts only** (§4 GAP-1), marked MUST-NOT-REPLICATE. Not reproduced, not analysed for exploitability, no payload used.

---

## 0. Method, scope, boundaries

**Xuất phát từ citations có sẵn** (spec bước 1): slice-G §1.4 (UI caller), slice-A §3 (run route
shape), slice-C §4 (output materialization), và slice-G §1–§3. Từ đó đọc source **chỉ để nối
mạch** và ghim `file:line` cho từng hop.

**De-dup**: slice-G đã phủ CRUD field-level và shape của hai override, **chưa** trace mạch
chạy. Gap mà CONSOL nêu (`G-7`: *"the run path is not traced"*) là phần `submitPipelineJob`
→ queue → worker → interpreter → persist → download, tức H5–H10 dưới đây. Slice A/C đã phủ
route shape và cột lưu kết quả ở mức một dòng; ở đây mạch được nối liền và **đo được một đứt mạch
cụ thể** (GAP-2) mà các slice trước không nêu.

Files read (read-only): `app/api/internal/workflow-schemas/route.ts`,
`app/api/v1/docs/workflows/schema/route.ts`, `lib/workflow-builder/{loader,run-schema}.ts`,
`lib/pipelines/{submit,workflow-engine,format}.ts`, `worker.ts`,
`app/api/v1/operations/[id]/{route,download/route}.ts`, `lib/db/schema.ts`.
Cross-read only: `lib/pipelines/workflows/{disbursement,lc-checker,doc-compare}.ts` (grep, để
đối chiếu `ctx.stepsResult`).

Không chạm: `server.ts`, `contracts/src`, `businesses/document-core/**` (D3 lease), `tasks/*.md`,
`AGENTS.md`, lockfile, execution overlay. Không chạy suite live/infra, không cài gói, không claim
DB window, không nhắn `nocobase-10`. Không đề xuất nào chạm public wire → COMP-02..09 không bị
chặn.

**Không test nào được chạy** — characterization tĩnh, đúng như spec yêu cầu.

---

## 1. Mạch import → trigger → artifact (10 hop)

Một schema đi qua đúng một đường. Mỗi hop đều có `file:line`.

| # | Hop | file:line | Việc xảy ra |
|---|---|---|---|
| **H1** | UI submit | `app/workflow-builder/page.tsx:191-204` | `POST /api/internal/workflow-schemas` với `{xml}` khi tên file kết thúc `.xml`, ngược lại `{schema: parsed}`; lỗi `JSON.parse` hoá thành toast |
| **H2** | Import route | `app/api/internal/workflow-schemas/route.ts:28` | `requireAdmin()` (`:29`) → `body.xml` được thử trước `body.schema` (`:36-39`) → `validateSchema` (`:44-47`) → `saveSchema` (`:49`) → `201` |
| **H3** | Lưu trữ | `lib/workflow-builder/loader.ts:12-18` | upsert **một** dòng `appSettings`, key `wb_schema:<slug>`. Đây là toàn bộ vòng đời import — không có bảng schema riêng, không versioning |
| **H4** | Trigger | `app/api/v1/docs/workflows/schema/route.ts:15` | `schemaSlug` bắt buộc (`:19-22`) → `loadSchema` (`:26-28`, 404 nếu chưa import) → **`validateSchema` chạy lại lần hai** (`:31-34`) → `normalizeFiles` (`:38`) → `JSON.parse(input)` (`:40-48`) → khối identity (`:57-79`, xem GAP-1) → `submitPipelineJob` (`:81-91`) |
| **H5** | Enqueue | `lib/pipelines/submit.ts:70` | `skipConnectorValidation: true` bỏ qua vòng kiểm processor (`:87`, `:114`) → `db.insert(operations)` (`:300-316`) → `isWorkflowJob = endpointSlug.startsWith("workflows:")` (`:338`) → `queue.add` (`:389` async / `:373` sync) |
| **H6** | Worker dispatch | `worker.ts:49-53` | `type === "workflow" || job.name.includes("workflows:")` → `runWorkflow`. Nhánh còn lại là `runPipeline` |
| **H7** | Engine route | `lib/pipelines/workflow-engine.ts:431-449` | `createWorkflowContext` (`:436`) → nhánh schema khi `ctx.pipelineVars.schemaSlug` có mặt (`:441`) → **`loadSchema` lần thứ ba** (`:444`) → `runWorkflowFromSchema` (`:445`) |
| **H8** | Interpreter | `lib/workflow-builder/run-schema.ts:17` | `validateSchema` lần **thứ tư** (`:21-24`) → dựng thứ tự flow từ `schema.nodes` (`:31-34`) → nhánh `human` → `pauseWorkflow` và **return** (`:50-56`) → gom block node không-HITL → `runSchemaDag` (`:60-72`) → ghép output (`:82-96`) → `completeWorkflow` (`:98`) |
| **H9** | Persist | `lib/pipelines/workflow-engine.ts:217-241` | `done: true`, `state: "SUCCEEDED"`, `progressPercent: 100`, `outputContent`, `extractedData`, `stepsResultJson`, token/cost → cộng dồn `apiKeys.totalUsed` (`:235-239`) → `sendWebhook(SUCCEEDED)` (`:241`) |
| **H10** | Lấy kết quả | `app/api/v1/operations/[id]/route.ts:37` và `.../download/route.ts:43-53` | envelope: `formatOperationResponse(op)`; tải file: nếu `op.outputContent` có mặt thì **trả thẳng chuỗi đó** (không qua storage backend), chọn đuôi từ `op.outputFormat` (`:41-43`) |

**Điểm đáng chú ý về hình dạng:** schema được `validateSchema` **ba lần** trên cùng một request
(H2, H4, H8) và `loadSchema` **hai lần** (H4, H7). Không có cache giữa các chặng. Đây là quan
sát về chi phí, không phải đề xuất sửa.

### 1.1 Vật chất hoá kết quả: cột, không phải artifact

Đây là khác biệt cấu trúc lớn nhất giữa legacy và rework, và nó là câu trả lời cho vế
*"result artifact"* của G-7:

| | Legacy (mạch này) | Rework (đối chiếu) |
|---|---|---|
| Kết quả nằm ở đâu | **cột trên dòng `operations`**: `outputContent`, `extractedData`, `stepsResultJson` (`workflow-engine.ts:220-227`) | **artifact có tham chiếu**: `writeEnvelopeArtifact` → `resultRef: "artifact://..."` (`du-rework/businesses/document-core/src/worker.ts:104-121`, `:1256`) |
| Kết quả trung gian | không có khái niệm artifact cho từng node của schema | từng bước có checkpoint (`step-checkpoint.ts`), từng node có typed state |
| Tải về | `download/route.ts:43-53` đọc thẳng `op.outputContent`; nhánh `outputFilePath` (`:55-101`) là cho pipeline thường, **schema path không bao giờ set `outputFilePath`** | `GET /api/v1/artifacts/{id}/download` (orchestrator `server.ts:2010`) |

Nói cách khác: ở legacy, "artifact" của một schema run là **một cột text trên dòng operation**.
Không có đối tượng artifact nào tồn tại trong vòng đời này.

---

## 2. Điểm đứt mạch (gap) — phần lõi của G-7

Spec yêu cầu: *ghi rõ chỗ nào đứt mạch (không trace được → gap, không đoán)*. Dưới đây là 6 điểm,
đều đo được từ source, không suy đoán.

### GAP-1 — Identity của run đến từ input của client (MUST-NOT-REPLICATE, chỉ ghi nhận)

Ghi như **fact vòng đời**, vì identity là thứ gắn operation vào tenant và quyết định ai đọc được
kết quả ở H10:

| Quan sát | file:line |
|---|---|
| Trigger nhận `apiKeyId` từ **form field do client gửi**; chấp nhận cả id nội bộ lẫn raw key (fallback hash SHA-256 tại `:63-65`) | `app/api/v1/docs/workflows/schema/route.ts:57-66` |
| Khi field vắng mặt, route **tự chọn** key ADMIN cũ nhất | `.../schema/route.ts:74-76` |
| Download fence trên header `x-api-key-id`, và phép so sánh **chỉ chạy khi header có mặt** | `app/api/v1/operations/[id]/download/route.ts:26-32` |

Không phân tích thêm, không dựng payload, không đánh giá tính khai thác được — nằm ngoài phạm vi
spec. Slice A §7 đã gán nhãn MUST-NOT-REPLICATE cho hai dòng đầu; dòng thứ ba là hiện tượng cùng
họ (`list-no-resolve`) và tôi ghi lại để mạch H10 không bị đọc sai là đã có tenant fence.

### GAP-2 — Vòng đời schema **không lưu kết quả từng node** khi chạy bình thường (đứt mạch thật)

Đây là phần CONSOL gọi là *run path is not traced*, và nó là một đứt mạch đo được:

1. `createWorkflowContext` khởi tạo `stepsResult = []` — `workflow-engine.ts:377`.
2. **Không có bất kỳ lệnh `push` nào vào `ctx.stepsResult` dưới `lib/workflow-builder/`.** Đo được:
   push chỉ tồn tại ở `lib/pipelines/engine.ts:235,366` (biến cục bộ khác) và ở
   `lib/pipelines/workflows/disbursement.ts:131,192,223,247`,
   `lc-checker.ts:104,157,197`, `doc-compare.ts:112,153,185,212`.
3. `runWorkflowFromSchema` giữ kết quả từng node trong **biến cục bộ** `nodeResults`
   (`run-schema.ts:35`) và chỉ chuyển nó sang `ctx._nodeResults` **trong nhánh HITL**
   (`run-schema.ts:50-56`).
4. `completeWorkflow` ghi `stepsResultJson: JSON.stringify(ctx.stepsResult)`
   (`workflow-engine.ts:226`) — tức là ghi `"[]"` — và đặt
   `currentStep: ctx.stepsResult.length - 1` (`:223`) — tức là **`-1`**.

Hệ quả đo được, không suy đoán:

| Đường chạy | Node result được lưu? |
|---|---|
| Có node `human` → `pauseWorkflow` | **Có** — `:249-252` bọc thành `{stepsResult, _nodeResults}` |
| Chạy tới cuối, không HITL | **Không** — chỉ còn `outputContent` + `extractedData` |
| Thất bại → `failWorkflow` | **Không** — `:285` ghi lại `JSON.stringify(ctx.stepsResult)` = `"[]"` |

Ngoài ra `updateProgress` được gọi **mỗi node** (`run-schema.ts:48,53`) và mỗi lần đều ghi đè
`stepsResultJson` bằng `"[]"` (`workflow-engine.ts:211`).

Nói thẳng: sau một schema run thành công, **không có chỗ nào trong hệ thống cho biết node nào
sinh ra cái gì**, và `currentStep` của operation là `-1`. Đây là hệ quả trực tiếp của việc hai
vòng đời — `stepsResult` của workflow sub-step và `nodeResults` của schema — dùng **cùng một cột**
nhưng chỉ một trong hai được ghi.

### GAP-3 — Operation `SUCCEEDED` vẫn trả 404 khi tải kết quả

`run-schema.ts:84` chọn `fromId = schema.output?.from ?? ordered[ordered.length-1]?.id`; nếu node
đó không có trong `nodeResults` thì `finalNode` là falsy và `outputContent` giữ nguyên `null`
(`:86-91`). `completeWorkflow` vẫn ghi `state: "SUCCEEDED"` và `done: true`
(`workflow-engine.ts:218-219`). Khi tải: `download/route.ts:43` rơi qua cả nhánh
`outputContent` lẫn `outputFilePath` (schema path không set cột này), tới `:110-114` và trả
**404 `no-output`**. Tức là một run thành công có thể không tải được gì — và phải tới bước 10 mới
thấy.

### GAP-4 — `Content-Type` JSON cho một body có thể là plain text

`outputFormat` mặc định là `json` (`submit.ts:80`; `lib/db/schema.ts:24`) và schema trigger **không
truyền** giá trị này, nên mọi schema run đều mang `json`. Nhưng `run-schema.ts:88-89` đặt
`outputContent` bằng **nguyên văn chuỗi** khi node cuối trả string. Kết quả:
`download/route.ts:41-43` chọn `application/json` và tên file `.json`, trong khi body là văn bản
thuần. Phân biệt này chỉ quan sát được ở H10 — không có bước nào trong H1–H9 báo nó.

### GAP-5 — Va chạm tên slug với `process` legacy

`runWorkflow` xử lý tên workflow lạ bằng cách **thử `loadSchema(workflowName)` và chạy bằng schema
interpreter** nếu tìm thấy (`workflow-engine.ts:460-464`). Vậy một job `process: <tên>` mà tên
trùng một schema đã import sẽ chạy qua schema thay vì báo unknown workflow (`:465`). Không có
namespace nào tách hai không gian tên này (schema slug không có quy tắc ký tự — slice-G §1.2).

### GAP-6 — Vòng đời này **không có** ở rework; cả lớp compat lại chưa mount

| Mặt | Trạng thái |
|---|---|
| Action/recipe tương ứng `schemaSlug` trong rework | **không có** (slice-A:67, slice-C:71) |
| Route `workflows` trong orchestrator | **không có** — 0 match chuỗi `workflows` trong `services/orchestrator/src/` |
| `resolveLegacyWorkflow` / `resolveLegacySchemaSlug` | export nhưng **không caller** (`legacy-workflow-mapping.ts:143,171`) |
| Cả thư mục `compat/` của orchestrator | **không được `server.ts` import** (0 match cho `compat/`) |

Hệ quả thẳng: schema lifecycle là **legacy-only**. Khi COMP-00 chốt surface, không có đường
đi sẵn trong rework để nhận một `schemaSlug` — và lớp compat dựng cho mục đích đó vẫn là code
chết. **Đây không phải đề xuất mount** (chạm public wire → BLOCKED-COMP-00), chỉ là trạng thái.

---

## 3. Điều tôi KHÔNG quyết

Spec nói rõ: **P9-04 owns schema-workflow product decision** — receipt này không quyết gì. Cụ
thể tôi **không** đề xuất, không phân xử, không tick:

| Câu hỏi còn mở | Thuộc ai |
|---|---|
| Rework có nên nhận `schemaSlug` không, và nhận ở shape nào | COMP-00 (public wire) |
| Có mount lớp `compat/` không | COMP-00 / orchestrator owner lane |
| Có sửa GAP-2 bằng cách ghi `nodeResults` vào `stepsResultJson` không, hay tách cột riêng | lane sở hữu legacy + architect |
| `outputFormat` cho schema run nên suy từ đâu | P9-04 |
| Có giữ HITL-only resume hay mở rộng | P9-04 |

GAP-2 là **defect quan sát được**, không phải đề xuất sửa. Tôi ghi nó đúng như spec yêu cầu và
để người khác quyết.

**Gate impact: NONE.** Không release gate nào được tick, dịch chuyển hay ngụ ý.

---

## 4. Cross-reference

| Nguồn | Đóng góp cho receipt này |
|---|---|
| `codex-comp01-slice-g-...md` §1.4 | UI caller → H1; xác nhận CRUD đã phủ, **run path** thì chưa |
| `codex-comp01-slice-a-...md` §3, :67, :69 | shape hai run route; `:69` là nguồn GAP-1 dòng 1–2 (MUST-NOT-REPLICATE) |
| `codex-comp01-slice-c-...md` §4, :63, :71 | cột lưu kết quả; `:71` xác nhận không có `schemaSlug` action/recipe → GAP-6 |
| `qwen-comp01-consolidate-2026-10-02.md` | §5 G-7 — receipt này là phần bổ sung duy nhất để đóng |
| `qwen-comp01-g1-guide-mismatch-2026-10-02.md` | cùng họ phát hiện: tài liệu mô tả bề mặt không tồn tại. Ở đó là path, ở đây là vòng đời |

### 4.1 Ngoài phạm vi, đã biết và không mở lại

`loader.ts:35-37` xoá schema không kiểm tra tồn tại (slice-G §1.2) và `POST` là upsert không
versioning (slice-G §1.2) — đã có bằng chứng, tôi không đo lại.

### 4.2 Điều tôi **không** trace, và vì sao

| Không trace | Lý do |
|---|---|
| `buildExecFunc` / `real-exec.ts` (từng primitive: connector, parallel, join, archive, file_url_download, callback) | slice-E đã phủ `callback`; các primitive còn lại là **cùng một cơ chế**, nằm ngoài câu hỏi của G-7 (mạch vòng đời, không phải mạch thực thi node) |
| Đường resume sau HITL | `pauseWorkflow` đã cho thấy nó ghi `{stepsResult, _nodeResults}` và `createWorkflowContext:376-388` đọc lại; đi tiếp là một trace riêng, không phải gap này |
| Rework `StepCheckpointManager` chi tiết | `businesses/document-core/**` thuộc lease D3 — chỉ dùng ở mức một dòng đối chiếu trong §1.1 |

---

## 5. Trạng thái cuối

- **Mạch đã trace trọn vẹn**: H1 → H10, mỗi hop có `file:line`.
- **Không chỗ nào đứt mạch theo nghĩa "không trace được"** — tôi đã lần theo tới tận response
  cuối. Cái tồn tại là **6 gap về hành vi** ở §2, trong đó GAP-2 là đứt mạch thật về dữ liệu.
- **Không sửa file hiện có.** File duy nhất được ghi là receipt này.
- **Không chạy test** — characterization tĩnh.
- **Không tick gate, không commit**, không revert thay đổi của lane khác.

*End of receipt.*