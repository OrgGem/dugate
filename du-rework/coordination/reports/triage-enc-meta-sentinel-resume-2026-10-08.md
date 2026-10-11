# TRIAGE enc-meta-sentinel G2 (resumeOperation seals response_ref) — 2026-10-08

> [!IMPORTANT]
> RESUME POINT — **RESOLVED (test-only fix, product untouched)**: RED gốc là **double-model drift trong fake `pg` của chính test**, không phải lỗi bảo mật. Đã sửa **chỉ** `tests/enc-meta-sentinel-runtime-refs.test.ts` (fake trả op-row + task-row theo SQL hiện tại của product). **GREEN 10/10 exit 0**, `tsc --noEmit` exit 0. Sentinel/assertion **không hề bị nới/bỏ/đổi kỳ vọng**.
> SOM đầu phiên ghi "IN PROGRESS / đang chạy lại suite" — các mục dưới đây là kết quả cuối.

- Scope: du-rework ONLY, offline (không claim DB window). Không commit / git add / push; không tick ACCEPTED/VERIFIED; không sửa `docs/21-openapi.json`; không sửa `src/`.
- RED báo cáo (full offline suite `Tests: 8 failed / 5126 passed`): `ENC-META-SENTINEL G2 … › GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only`.
- Raw: `coordination/reports/raw/triage-enc-meta-sentinel-resume-2026-10-08/01..04`.

## 1. RED literal + stack (không sửa gì trước khi chạy)

```
cd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/enc-meta-sentinel-runtime-refs.test.ts
```
Exit Code: 1 · `Test Suites: 1 failed` · `Tests: 1 failed, 9 passed, 10 total`

Đối chiếu RED gốc từ full-suite (dòng stack): `at Object.tx (src/db/db.ts:28:24) ← tests/enc-meta-sentinel-runtime-refs.test.ts:369:17`.

Literal đầy đủ (raw `01-red-literal-first-run.log`; stdout còn 5 dòng warn `[REDACTED]` trước block, không liên quan):

```
  ● ENC-META-SENTINEL G2: result_ref / human_waits / resume through the real createApp ›
    GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only

    HttpError: operation not found

        52 |   new HttpError(401, 'UNAUTHENTICATED', msg);
        53 | export const forbidden = (msg = 'action not permitted') => new HttpError(403, 'PERMISSION_DENIED', msg);
    > 54 | export const notFound = (msg: string) => new HttpError(404, 'NOT_FOUND', msg);
         |                                          ^
        55 | export const conflict = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
        56 |   new HttpError(409, code, msg, extra);
        57 | export const gone = (msg: string) => new HttpError(410, 'TASK_TERMINAL', msg);

        at notFound (src/http/errors.ts:54:42)
        at run (src/modules/runtime/runtime.ts:1462:44)
        at Object.tx (src/db/db.ts:28:24)
        at Object.<anonymous> (tests/enc-meta-sentinel-runtime-refs.test.ts:369:17)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 9 passed, 10 total
Exit Code: 1
```

**Sau khi nới matcher operations (chưa sửa src), RED tiếp theo — mép lệch #2** (raw `02-red-second-model-gap.log`):
```
  HttpError: task task-1 not found
      at notFound (src/http/errors.ts:54:42)
      at run (src/modules/runtime/runtime.ts:1527:46)
      at Object.tx (src/db/db.ts:28:24)
      at Object.<anonymous> (tests/enc-meta-sentinel-runtime-refs.test.ts:375:17)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 9 passed, 10 total
Exit Code: 1
```

## 2. Root cause (có bằng chứng, cả 3 câu hỏi trong packet)

- **(a) SQL reject từ fake hay pg thật?** → **Không phải SQL reject, không phải pg thật.** Lỗi là `HttpError 404 'operation not found'` ném bởi **product code** tại `runtime.ts:1462` (`if (!opRes.rowCount) throw notFound(...)`) **bên trong `db.tx`** (`src/db/db.ts:28`) — tức fake trả **0 hàng**, product tự 404. (Suite này mock `pg` bằng `ScriptedPool`; test tên "through the real createApp" = app thật, DB giả.)
- **(b) Câu query mới trong product chưa được double-model?** → **ĐÚNG, đây chính là root cause (drift, không phải lỗi bảo mật):**
  - Product hiện tại `runtime.ts:1459` (resumeOperation): `SELECT id, tenant_id, state, state_version, endpoint_slug FROM operations WHERE id=$1 FOR UPDATE` — **có `endpoint_slug`**. Fake matcher cũ (test `:128`) là **exact-list** `SELECT id, tenant_id, state, state_version FROM operations WHERE id=$1 FOR UPDATE` ⇒ không khớp ⇒ rơi vào catch-all `if (/FROM operations WHERE id=\$1/i) return { rows: [], rowCount: 0 }` (test `:131`, fallback cuối `:167` cũng `rowCount:0`) ⇒ 404.
  - Mép #2: fake **không có** handler cho query resume-task của product (`runtime.ts:1524-1526`: `SELECT t.id, t.state, t.payload_ref, o.business_id, o.business_version, o.action, o.correlation_id FROM tasks t JOIN operations o … FOR UPDATE OF t`) — chỉ có branch claim `SELECT lease_epoch, state, operation_id FROM tasks …` (test `:87`) ⇒ rowCount 0 ⇒ `notFound task task-1` (`:1527`).
  - Bằng chứng timeline: `endpoint_slug` được product thêm vào SELECT sau khi test được viết (chính xác loại drift mà receipt này ghi).
- **(c) Assertion drift?** → **Không.** Test chết bằng `throw`, không phải assertion: không có `expect` nào fail; 9 test còn lại xanh.

## 3. Phân tích bảo mật — sentinel CÓ thật sự bắt được gì? (không sửa, không bỏ)

- **Sentinel KHÔNG bắt được gì ở lần RED** — và **đúng vậy**: G2 chết ở statement ĐẦU TIÊN (`SELECT operations`) trước khi ghi bất kỳ hàng nào; nó **chưa tới** chỗ seal `human_waits.response_ref` / `tasks.payload_ref` (runtime.ts:1512-1520) mà test muốn chứng minh. Không có đường nào để plaintext lọt — vì không có gì được ghi.
- **Sau fix, sentinel chạy thật và XANH**: `leaksSentinel(answerWrite.params[1]) === false`, `leaksSentinel(payloadWrite.params[1]) === false`, `leaksSentinel(outbox[0]) === false`, và decrypt mở lại đúng AAD: `(TENANT,'human_waits.response_ref','wait-1')` → `{input:{answer:SENTINEL}}`; `(TENANT,'tasks.payload_ref','task-1')` → `{resumeInput:{answer:SENTINEL}, waitId:'wait-1'}`. ⇒ product seal đúng như thiết kế.
- **Các pin còn nguyên không đổi**: `FIX pin` (completeTask seal result_ref 2 slot), `RED GAP DETECTOR` (result_ref không plaintext), `DOCUMENTED ACCEPTANCE` (ui_schema/context_ref plaintext BY EXEMPTION — có assert sentinel **có** mặt để chặt lại quyết định), 5 guard wire-boundary, 1 guard slot-map. Không có kết luận bảo mật nào bị lật hay nới.
- **Kết luận bảo mật:** KHÔNG phát hiện lỗi bảo mật (product không seal/không plaintext); **không cần sửa `src/`**, **không BLOCKER** — vấn đề nằm 100% ở fake của test chưa theo kịp SQL của product.

## 4. Thay đổi (CHỈ file test trong lease; 2 hunk trong hàm `answer()` của fake `pg`)

1. `:124-134` matcher operations: exact-list → tolerant `SELECT id, tenant_id, state, state_version[\w, ]* FROM operations WHERE id=$1 FOR UPDATE` và row thêm `endpoint_slug: null` (op **không phải** legacy-workflow — đúng như kỳ vọng `openedResume` của test, để resume đi nhánh plain-payload).
2. `:137-155` **thêm** matcher resume-task: khớp theo phần JOIN+WHERE ổn định, row = `{ id:'task-1', state:'WAITING_INPUT', payload_ref:null, business_id:BUSINESS, business_version:'1.0.0', action:'extract', correlation_id:'sentinel-resume' }` (action `'extract'` để KHÔNG rơi vào nhánh pinned-workflow ở `runtime.ts:1543`).

**Không sửa:** `src/` (0 dòng), file test khác, sentinel string, `expect` nào, kỳ vọng giá trị nào (kể cả `leaksSentinel(...)` và hai phép decrypt).

## 5. GREEN literal + exit code

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/enc-meta-sentinel-runtime-refs.test.ts
  ⇒ PASS · Test Suites: 1 passed, 1 total · Tests: 10 passed, 10 total · Exit Code: 0
    (G2: √ GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only (29 ms))

node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
  ⇒ Output (empty) · Exit Code: 0
```

## 6. Giới hạn / chưa làm

1. Chỉ chạy suite này + tsc; **không chạy full unit suite** (7 test đỏ còn lại trong `Tests: 8 failed / 5126 passed` không thuộc scope packet này).
2. Offline; không claim DB window; fix là test-double nên **không** thay thế bằng chứng product chạy trên pg thật (suite này vốn là scripted `pg`).
3. Nới regex matcher theo phần ổn định (không liệt kê cột) để lần drift tương lai không lặp lại thành 404 giả; nhưng nếu product đổi **cấu trúc** JOIN/WHERE thì vẫn phải cập nhật fake (ghi rõ để lane sau không tưởng đã phủ).
4. Không tick ACCEPTED/VERIFIED; không commit/push.