# COMP01-G7b — HITL resume path trace (read-only characterization)

- **Receipt**: `qwen-comp01-g7b-hitl-resume-2026-10-02.md`
- **Dispatch**: 2026-10-02T10:24:23+07:00 (RE-DISPATCH của `task_3976e85b794c`, lane cũ bị steer sang docs, không có receipt)
- **Lane**: `qwen_2` / `term_27eb3380`
- **Scope**: characterization-only. **Sửa 0 file hiện có** — chỉ tạo receipt này. Không tick gate, không commit, không nhắn `nocobase-10`.
- **Input**: GAP của G7 receipt `qwen-comp01-g7-schema-lifecycle-2026-10-02.md` §4.2 — đường resume sau HITL chưa trace.

## §0 Phương pháp và ranh giới

Đọc trực tiếp source, không chạy suite, không đụng infra. Mọi phát biểu dưới đây gắn `file:line`; tôi đã mở đọc từng đoạn được trích, không dựa vào trích dẫn của receipt khác. Ba nguồn đã có sẵn được tôi **kiểm chứng lại** chứ không mượn:

| Nguồn | Kết quả kiểm chứng |
|---|---|
| `codex-legacy-workflow-hitl-run-wire-2026-10-01.md` (pause side) | Khớp. `workflow-engine.ts:247-272` đúng nội dung đã mô tả |
| `codex-comp01-slice-d-lifecycle-pagination-2026-10-02.md` (resume route) | Khớp. Số dòng `:56-63`, `:85-90`, `:95` đúng |
| `qwen-comp01-g7-schema-lifecycle-2026-10-02.md` GAP-2 | Khớp, và trace này cho thấy nó **không dừng ở biên resume** — xem §10 |

Ranh giới: không đánh giá khai thác được, không dựng payload, không đề xuất sửa. Các phát hiện về auth fence / tenant không nhắc lại vì đã có nhãn MUST-NOT-REPLICATE ở slice khác.

## §1 Bản đồ mạch — 9 hop từ pause tới download

| Hop | Việc | File:line |
|---|---|---|
| H1 | Schema runner gặp node `human` → gán `ctx._nodeResults` → pause | `lib/workflow-builder/run-schema.ts:48,52,53,54` |
| H1' | Code-driven (disbursement) pause | `lib/pipelines/workflows/disbursement.ts:154,207` |
| H2 | `pauseWorkflow` bọc wrapper + ghi DB | `lib/pipelines/workflow-engine.ts:247-272` |
| H3 | `POST /api/v1/operations/{id}/resume` vào, gate state, unwrap, merge edit, re-encode, ghi DB | `app/api/v1/operations/[id]/resume/route.ts:19,24-32,38-63,76-89` |
| H4 | Re-enqueue BullMQ | `resume/route.ts:92-95` |
| H5 | Worker định tuyến → `runWorkflow` | `worker.ts:50,52` |
| H6 | `createWorkflowContext` dựng lại ctx từ row | `workflow-engine.ts:376-388,400,408` |
| H7 | Thực thi tiếp từ checkpoint | `run-schema.ts:37-45` hoặc `disbursement.ts:61,74-91` |
| H8 | Persist kết thúc | `workflow-engine.ts:217-233` hoặc `:275-292` |
| H9 | Download | `app/api/v1/operations/[id]/download/route.ts:14-114` |

## §2 H2 — `pauseWorkflow` ghi gì (workflow-engine.ts:247-272)

```
247  export async function pauseWorkflow(ctx, message, currentStep) {
249    let stepsResultJson = JSON.stringify(ctx.stepsResult);
250    const schemaNodeResults = ctx._nodeResults;
251    if (schemaNodeResults && typeof schemaNodeResults === 'object' && Object.keys(...).length > 0) {
252      stepsResultJson = JSON.stringify({ stepsResult: ctx.stepsResult, _nodeResults: schemaNodeResults });
253    }
254    await db.update(operations).set({
255      done: false, state: 'WAITING_USER_INPUT',
257      progressMessage: message,
259      currentStep,          // checkpoint index để resume từ đó
260      stepsResultJson,
261      totalInputTokens, totalOutputTokens, totalCostUsd,   // usage tích lũy tới thời điểm pause
266    })
267    // Note: We don't set progressPercent to 100 here since it's waiting
270    await sendWebhook(ctx, 'PAUSED' as any, message);
272  }
```

- Cột duy nhất mang checkpoint là `currentStep` (`:259`) và `stepsResultJson` (`:260`). `progressPercent` **không** được ghi (`:267` — chú thích trong source, không phải suy luận của tôi).
- Wrapper chỉ được bọc khi `_nodeResults` khác rỗng (`:251`). Nếu rỗng thì ghi mảng thuần.
- Hai call site dùng **hai ngữ nghĩa `currentStep` khác nhau**, cả hai đều đúng với chính chúng:
  - Schema: `pauseWorkflow(ctx, node.message, i + 1)` — `i` là chỉ số 0-based của node human, `+1` là chỉ số node kế tiếp (`run-schema.ts:54`).
  - Disbursement: `pauseWorkflow(ctx, '...', 2)` — chỉ số step kế tiếp sau step 1 (`disbursement.ts:207`).

## §3 H3 — resume route, từng nhánh (resume/route.ts)

| Dòng | Việc | Ghi chú characterization |
|---|---|---|
| `:19` | `POST` | Không đọc `params` kiểu `Promise` như `download/route.ts:19`; ở đây `params` là object thuần |
| `:24-28` | `404 {error}` | Envelope phẳng, khác `problem+json` của các route khác |
| `:30-32` | `400 {error}` | Gate chính xác `state !== 'WAITING_USER_INPUT'`. **Không CAS, không idempotency** — read-then-update (đã ghi ở slice D, tôi xác nhận lại: không có `expectedStateVersion`, không có `waitId`) |
| `:38-54` | Unwrap | Nhận diện wrapper bằng `!Array.isArray && parsed._nodeResults` (`:48`); nhánh mảng thuần ở `:52-53`; `JSON.parse` lỗi bị nuốt im lặng (`:45`) |
| `:56-63` | Merge human edit | Chỉ chạy khi có **cả** `step` **và** `extracted_data`; tìm bằng `findIndex(s => s.step === body.step)`; `is_human_edited = true` |
| `:65-75` | Bull priority | Lookup `profileEndpoints` theo cặp `(apiKeyId, endpointSlug)`, map `HIGH→1 LOW→20` còn lại `10` (`:11-17`) |
| `:76-81` | Re-encode | Giữ wrapper **chỉ khi** `_nodeResults` khác rỗng (`:77`), giống hệt điều kiện ở `workflow-engine.ts:251` |
| `:84-89` | Ghi DB | `state:'RUNNING'`, `progressMessage`, `stepsResultJson`. **Không ghi `currentStep`** — giữ nguyên checkpoint đã lưu |
| `:92-95` | Enqueue | `jobName = pipeline:${operation.endpointSlug ?? 'unknown'}`; `correlationId` **mới** từ `crypto.randomUUID()` (`:93`) |
| `:98` | `200 {success, message}` | |
| `:100-102` | `500 {error: err.message}` | |

## §4 H4/H5 — re-enqueue có quay lại đúng executor không

Đây là mắt xích dễ đứt nhất nên tôi kiểm riêng thay vì giả định.

**Đường submit (H5 gốc)** đặt discriminator rõ ràng trong payload:

- `submit.ts:337` — `jobName = pipeline:${endpointSlug} [${profileName}]`
- `submit.ts:338` — `isWorkflowJob = endpointSlug?.startsWith('workflows:')`
- `submit.ts:344` — `type: isWorkflowJob ? 'workflow' : 'pipeline'`

**Worker định tuyến** (`worker.ts:50`):

```
const isWorkflow = type === 'workflow' || job.name.includes('workflows:');
```

**Resume thì gửi gì** (`resume/route.ts:92-95`):

```
92  const jobName = `pipeline:${operation.endpointSlug ?? 'unknown'}`;
93  const correlationId = crypto.randomUUID();
95  await queue.add(jobName, { operationId, correlationId }, { priority: bullPriority });
```

Kết luận có điều kiện, đo được:

- Payload resume **không có `type`** và **không có `profileName`**. Nhánh `type === 'workflow'` của `worker.ts:50` không kích hoạt được.
- Định tuyến **vẫn sống** qua nhánh dựa trên tên, vì endpoint slug của workflow luôn có tiền tố `workflows:` — với schema là `workflows:schema:${schemaSlug}` (`app/api/v1/docs/workflows/schema/route.ts:56`, chú thích ngay tại `:55` nói rõ mục đích), với code-driven là `workflows:disbursement` v.v.
- Chuỗi correlation **không được nối tiếp**: `:93` sinh `correlationId` mới, nên log của lần resume không nối được với lần chạy gốc.
- `operations.endpointSlug` là **nullable** (`lib/db/schema.ts:19` — `text('endpointSlug')` không có `.notNull()`, khác `profileEndpoints` ở `:107` và `:125` là `.notNull()`). Với một row có slug null, `:92` rơi vào `'unknown'` → job name `pipeline:unknown` → `includes('workflows:')` false → job đi vào executor pipeline legacy, **không** phải `runWorkflow`.

Ghi nhận đúng mức: đây là **phụ thuộc ẩn đo được trong chuỗi resume**, không phải khai thác được (không có payload nào để tôi dựng, và tôi không dựng). Tôi **không** đề xuất sửa — thuộc lane sở hữu legacy + architect.

## §5 H6 — context rebuild (workflow-engine.ts:376-388)

```
377  let stepsResult: WorkflowStepResult[] = [];
378  let schemaNodeResults: Record<string, unknown> | null = null;
379  if (operation.stepsResultJson) {
381    const parsed = JSON.parse(operation.stepsResultJson);
382    if (parsed && typeof parsed === 'object' && parsed._nodeResults) {
383      stepsResult = Array.isArray(parsed.stepsResult) ? parsed.stepsResult : [];
384      schemaNodeResults = parsed._nodeResults;
385    } else if (Array.isArray(parsed)) { stepsResult = parsed; }
387    catch { stepsResult = []; }
389  }
... 400    _nodeResults: schemaNodeResults,
... 408    currentStep: operation.currentStep,
```

- Logic nhận diện wrapper **giống hệt** resume route (`workflow-engine.ts:382` vs `resume/route.ts:48`), cả hai cùng yêu cầu `_nodeResults` truthy và cùng xử lý mảng thuần. Không có lệch điều kiện.
- `stepsResult` cho schema vẫn là `[]` vì nửa `stepsResult` của wrapper vốn đã là `[]` khi pause (GAP-2 điểm 2: dưới `lib/workflow-builder/` không có lệnh `push` nào).

## §6 H7 — thực thi tiếp

### Schema (`run-schema.ts:37-45`)

```
37  const nodeResults: Record<string, NodeResult> = {};
38  const savedNodeResults = ctx._nodeResults;
39  if (savedNodeResults && typeof savedNodeResults === 'object') {
40    Object.assign(nodeResults, savedNodeResults);
41  }
42  const startIndex = ctx.currentStep ?? 0;
45  let i = startIndex;
```

- `nodeResults` cục bộ được phục hồi **đầy đủ** từ `_nodeResults` (`:40`) — dùng chính object đó làm `existingResults` cho block kế tiếp (`:73`), nên binding xuyên block sau restart vẫn ra.
- **Off-by-one: không có.** Pause lưu `i+1` (`run-schema.ts:54`), resume bắt đầu `i = currentStep` (`:45`) → chạy đúng node kế tiếp, không lặp lại node human. Tôi kiểm cả chiều ngược lại và không thấy chỗ nào re-run node đã xong.
- Ghi chú nhỏ: `ctx.currentStep ?? 0` (`:42`) — cột `currentStep` là `.notNull().default(0)` (`schema.ts:21`), nên nhánh `?? 0` không bao giờ kích hoạt trên row thật. Vô hại, chỉ là defensive thừa.

### Code-driven (`disbursement.ts:61,74-91`)

| Dòng | Việc |
|---|---|
| `:61` | `const resumeFromStep = ctx.currentStep` |
| `:74` | Guard phục hồi: `resumeFromStep > 0 && ctx.stepsResult.length > 0` |
| `:77-80` | Nạp lại step 0 → `mergedClassifyData`, `allLogicalDocs` |
| `:84-86` | Nạp lại step 1 → `extractionResults`, comment ghi rõ đây là nơi bản sửa của người dùng đi vào |
| `:89-91` | `catch` → `warn` và chạy tiếp với dữ liệu rỗng, không fail |
| `:94,158,211,238` | Bốn guard `resumeFromStep <= N` |

Check chéo: pause với `currentStep = 2` (`:207`) → resume `resumeFromStep = 2` → guard step 2 là `resumeFromStep <= 1` (`:158`) **false** → bỏ qua; guard step 3 là `<= 2` (`:211`) **true** → chạy. Không chạy lại step đã hoàn thành. Sạch.

## §7 H8 — persist kết thúc

| Hàm | Dòng | `currentStep` | `stepsResultJson` |
|---|---|---|---|
| `completeWorkflow` | `:217-233` | `ctx.stepsResult.length - 1` (`:223`) → schema là `-1` | `JSON.stringify(ctx.stepsResult)` (`:226`) → schema là `"[]"` |
| `failWorkflow` | `:275-292` | không ghi `currentStep` (giữ checkpoint cũ) | `:285` → schema là `"[]"` |

`completeWorkflow` còn ghi `progressPercent: 100`, `outputContent`, `extractedData`, `modelUsed: null` (`:219-227`), cộng usage và `apiKeys.totalUsed` (`:229-233`), rồi `sendWebhook(ctx,'SUCCEEDED')` (`:235`).

## §8 H9 — download (`download/route.ts`)

| Dòng | Việc |
|---|---|
| `:19-21` | `await params` — khác style `resume/route.ts:19`, hai route cùng họ lệch kiểu |
| `:23-28` | 404 nếu không có row hoặc `deletedAt` |
| `:30-36` | Fence theo header `x-api-key-id`, **chỉ khi header có mặt** |
| `:37-42` | 409 `not-ready` nếu `!op.done \|\| op.state !== 'SUCCEEDED'` — tức là thời điểm đang chờ người dùng là 409 |
| `:44-57` | Nếu có `outputContent` → trả thẳng, chọn `Content-Type` theo `outputFormat` |
| `:60-106` | Nếu có `outputFilePath` → stream qua `LocalStorageBackend` (có chặn path traversal) hoặc S3 |
| `:109-114` | 404 `no-output` |

GAP-3 của G7 vẫn đúng sau resume: đường schema không set `outputFilePath`, nên khi `outputContent` là `null` thì rơi xuống `:109-114`. Trace này **không** phủ định GAP-3, chỉ xác nhận nó nằm ở đúng chỗ.

## §9 Verdict — hai câu hỏi của spec

### Q1: resume có đọc lại `_nodeResults` đầy đủ không?

**Có — vòng khép kín, không hop nào rơi.** Bốn chặng đọc/ghi cùng một định dạng:

| Chặng | Viết | Đọc |
|---|---|---|
| pause | `workflow-engine.ts:252` bọc `{stepsResult, _nodeResults}` | — |
| resume route | `resume/route.ts:48-51` unwrap → `:77-78` bọc lại | |
| context rebuild | — | `workflow-engine.ts:384,400` |
| schema runner | — | `run-schema.ts:38-40` → `Object.assign` vào map cục bộ |

Điều kiện nhận diện wrapper giống nhau ở cả ba chỗ đọc (truthy `_nodeResults`), và cả hai chỗ ghi đều yêu cầu `Object.keys().length > 0`. Không có đường đi nào của `_nodeResults` bị bỏ.

### Q2: `stepsResultJson` sau resume còn `"[]"` không — nối với GAP-2?

**Có. GAP-2 không dừng ở biên resume — nó đi qua trọn lần chạy sau resume.** Đây là đóng góp mới của trace này so với G7 §4.2:

1. Resume route cẩn thận giữ wrapper và ghi lại nó (`:76-81`, `:87`).
2. Việc đầu tiên worker làm sau khi nhận job là `updateProgress` tại `run-schema.ts:48`.
3. `updateProgress` ghi `stepsResultJson: JSON.stringify(ctx.stepsResult)` (`workflow-engine.ts:211`) — **không** qua nhánh wrapper.
4. Với workflow schema, `ctx.stepsResult` là `[]` (GAP-2 điểm 2).

Kết quả: **cột mà resume route vừa bảo toàn bị ghi đè bằng `"[]"` ngay tick đầu tiên sau resume.** Trong suốt phần còn lại của lần chạy, cột checkpoint rỗng; nó chỉ được viết lại thành wrapper khi gặp node `human` kế tiếp (`run-schema.ts:52` + `:54`).

Phân biệt quan trọng, không nên đọc lẫn:

| | Trạng thái | Hậu quả |
|---|---|---|
| `nodeResults` **trong RAM** | Phục hồi đủ (`run-schema.ts:40`) | Binding xuyên block sau restart vẫn đúng — không có lỗi tính toán trong lần chạy đó |
| `nodeResults` **trong DB** | `"[]"` suốt lần chạy sau resume | Mất checkpoint bền vững. Schema nhiều node `human`: nếu tiến trình chết trong khoảng post-resume, bản DB mất wrapper — nhưng tiến trình chết thì RAM cũng mất, nên đây là mất checkpoint so với việc lẽ ra có thể phục hồi |

Nối GAP-2: nguyên nhân gốc là hai vòng đời (`stepsResult` của sub-step và `nodeResults` của schema) dùng chung một cột nhưng chỉ một vòng đời được ghi ở đường bình thường. Trace này cho thấy hệ quả đó **không dừng ở kết thúc của lần chạy trước** mà tiếp tục xuyên suốt lần chạy sau HITL.

## §10 Bốn phát hiện mới, không có trong G7 §4.2 hay các slice trước

### NB-1 — Human edit của schema HITL bị **bỏ âm thầm**, vẫn trả 200

Nhánh merge ở `resume/route.ts:56-63` tìm đích bằng `stepsResult.findIndex((s) => s.step === body.step)`. Với workflow schema, `stepsResult` **luôn là `[]`** (GAP-2 điểm 2: không có `push` nào dưới `lib/workflow-builder/`), nên `findIndex` trả `-1`, thân `if (stepIndex >= 0)` không chạy, và `extracted_data` của người dùng bị vứt. Route vẫn trả `200 {success:true}` (`:98`).

Phần `stepsResult` của wrapper **không** được định tuyếu sang `_nodeResults`. Hệ quả đo được: với schema HITL, thao tác của người duyệt là **chỉ-ack** — duyệt được, sửa không được. Cùng nguyên nhân gốc va chạm cột như GAP-2, quan sát ở seam thứ hai.

Đối chiếu: code-driven thì được việc này, vì `disbursement.ts:84-86` đọc lại `step1.extracted_data` và comment ghi rõ "includes any edits made by the Human user".

### NB-2 — Wrapper lọt ra public wire dưới dạng `metadata.pipeline_steps` **không phải mảng**

Cả ba chỗ đều không tách wrapper:

- `format.ts:31` — `pipeline_steps: safeParseJson(op.stepsResultJson, [])` trong `metadata`
- `format.ts:40` — cùng biểu thức trong `result` khi SUCCEEDED
- `format.ts:61` — cùng biểu thức trong `result` khi FAILED

`safeParseJson` (`format.ts:9-15`) chỉ `JSON.parse` rồi trả về, không kiểm tra hình dạng. Nên trong **cửa sổ `WAITING_USER_INPUT`** (từ `pauseWorkflow` tới lần `updateProgress` kế tiếp), `stepsResultJson` là object `{stepsResult, _nodeResults}` → `metadata.pipeline_steps` là **object** trên wire; cùng operation đó ở mọi thời điểm khác là **array**.

Hệ quả đo được: một client làm `pipeline_steps.length` hoặc `.map()` chạy được ở RUNNING và ném lỗi ở WAITING_USER_INPUT. Đây là **thay đổi kiểu trên wire theo trạng thái**, không phải chỉ giá trị rỗng.

Vì sao các bước trước không thấy: chỉ quan sát được ở H9/H10 khi một lần poll rơi **đúng** vào cửa sổ pause. `hitl-persistence.test.ts:108-112` có ghi chú đúng về việc round-trip test chỉ phát hiện **write gần nhất**, nhưng không test qua `format.ts`.

### NB-3 — Resume vứt mất discriminator `type: 'workflow'`

Chi tiết ở §4. Tóm tắt: định tuyến worker dựa trên hai điều kiện OR (`worker.ts:50`), đường resume chỉ giữ được **một** trong hai (`job.name.includes('workflows:')`), vì payload `:95` không mang `type`. Hiện tại còn đúng vì slug workflow luôn có tiền tố `workflows:`, nhưng `operations.endpointSlug` nullable (`schema.ts:19`) nên nhánh `'unknown'` (`:92`) là một đường đứt có điều kiện. Kèm theo: `correlationId` sinh mới (`:93`) nên không nối được chuỗi log.

### NB-4 — Không test nào chạm resume route

`tests/workflow-builder/hitl-persistence.test.ts` chứng minh pause → `createWorkflowContext` và restart binding xuyên block (`:167`, `:211`, `:233`), nhưng **không** import route resume. Grep `operations/[id]/resume`, `resume/route`, `resume-operation` trong `tests/` → **0 match**.

Nghĩa là: NB-1 và NB-3 nằm ở mắt xích **duy nhất** của chuỗi này không có round-trip regression — và mắt xích đó cũng chính là nơi **ghi lại** cột đã serialize. Đây là lý do cấu trúc cho phép NB-1 tồn tại mà không test nào bắt.

## §11 Chỗ đứt và phần ngoài phạm vi

| Mắt xích | Trạng thái |
|---|---|
| `_nodeResults` qua pause → resume → rebuild → runner | **Không đứt** — 4 chặng khớp định dạng |
| `currentStep` index sense (schema lẫn disbursement) | **Không lệch** — kiểm cả hai chiều |
| Wrapper sau lần `updateProgress` đầu tiên post-resume | **Đứt** — xem Q2 §9 |
| Human edit trên schema HITL | **Đứt âm thầm**, trả 200 — NB-1 |
| `metadata.pipeline_steps` shape theo state | **Đứt kiểu** — NB-2 |
| Re-enqueue giữ `type`/correlation | **Mất một nhánh định tuyến** — NB-3 |
| Test coverage của resume route | **Không có** — NB-4 |

Không đề xuất sửa, không chạm public wire, không gate. Bốn phát hiện NB-1..NB-4 là **evidence đầu vào quyết định**; việc quyết định thuộc coordinator và lane sở hữu legacy + architect.

## §12 Verification — tôi đã làm gì và không làm gì

Đã làm: đọc trực tiếp `workflow-engine.ts` (toàn bộ 196-305 và 321-474), `resume/route.ts` (toàn bộ), `download/route.ts` (toàn bộ), `run-schema.ts` (toàn bộ), `disbursement.ts:56-110,150-220`, `format.ts:1-70`, `schema/route.ts` (grep), `submit.ts:330-360`, `worker.ts:50-52`, `format.ts`, `lib/db/schema.ts`, `tests/workflow-builder/hitl-persistence.test.ts` (grep), `hitl-persistence` grep trong `tests/`.

Không làm: **không sửa file nào**; **không chạy** `jest`/`tsc`/`lint`; **không** chạm DB, Redis, BullMQ hay bất kỳ infra nào; **không** claim DB window; **không** `npm install`; **không** tick gate; **không** commit; **không** nhắn `nocobase-10`; **không** dựng payload kiểm chứng khả năng khai thác.

Mọi phát biểu trong receipt là **characterization tĩnh đọc từ source**. Vì không chạy code, các kết luận về hành vi runtime (đặc biệt NB-1 và NB-3) là **suy ra trực tiếp từ điều kiện kiểm trong mã**, và tôi ghi rõ điều kiện đó ở từng mục để người đọc tự kiểm lại. Kết luận nào cần xác nhận bằng chạy thì chưa có bằng chứng chạy — nói thẳng là chưa.
