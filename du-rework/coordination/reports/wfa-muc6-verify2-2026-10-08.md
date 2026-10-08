# WFA mục 6 — independent verify lần 2 (2026-10-08)

- **Task:** verify độc lập 4 fix WFA mục 6 (6a file-backend output, 6b services empty list, 6c `WAITING_USER_INPUT` poll, 6d join `merge`), độc lập với các lane đã sửa `term_f1c5a1d1` + `term_8a432ae3`.
- **Verifier:** OC lane. **Chỉ đọc + chạy test; TUYỆT ĐỐI không sửa product source; KHÔNG commit, KHÔNG push.**
- **Environment:** Node **v22.16.0**; jest **30.2.0** (cả `orchestrator` và `document-core`); Windows.
- **Revision được verify:** các file liên quan mtime `03:36–03:49` ngày 08/10 (trước phiên verify); re-check lúc `04:08` không đổi — verified state ổn định trong suốt các lần chạy.
- **Kết luận nhanh: 4/4 PASS, 0 test đỏ.** Không phát hiện lỗi chặn. 2 ghi chú informational (OBS-1, OBS-2) — không thuộc phạm vi 4 fix, ghi để owner biết.

## 1. Lệnh, cwd, exit code, kết quả

| # | Command | cwd | Exit | Kết quả |
|---|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/wfa-api-lifecycle.test.ts` | `du-rework/orchestrator/services/orchestrator` | **0** | `Test Suites: 1 passed`; **`Tests: 14 passed, 14 total`** (2.77 s) — đúng kỳ vọng 14. Raw: `raw/wfa-muc6-verify2-2026-10-08/01-lifecycle-full.txt` |
| 2 | … same + `-t "file-backend"` | same | **0** | **`Tests: 12 skipped, 2 passed, 14 total`** (3.7 s) — đúng kỳ vọng 2/12. Raw: `02-lifecycle-file-backend.txt` |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/legacy-http-mount.test.ts -t "empty service list"` | same | **0** | **`Tests: 31 skipped, 1 passed, 32 total`** — đúng kỳ vọng 1 pass (6b). Raw: `03-services-empty-list.txt` |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --silent tests/wfa-runtime-join-merge.test.ts` | `du-rework/businesses/document-core` | **0** | **`Tests: 4 passed, 4 total`** (2.5 s) — đúng kỳ vọng 4 (6d). Raw: `04-join-merge.txt` |

Không có test nào failed/error. Các skip ở #2/#3 là do filter `-t` (đúng thiết kế), không phải skip ẩn; full run #1 = 14 passed / 0 skipped.

## 2. Kiểm tra semantics bằng đọc code (không chỉ test xanh)

### 2.1 6d — `combineJoinOutputs` — `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:479-485` — **ĐÚNG**
```ts
if (combine === 'first') return outputs[0];
if (combine === 'merge' && outputs.length > 0 && outputs.every((output) => isRecord(output))) {
  return Object.assign({}, ...outputs);
}
return outputs;
```
- `merge` → `Object.assign({}, ...outputs)` = shallow-merge **object**, later-wins conflict (khớp object spread) — chỉ khi **mọi** output là record; fallback giữ **array** khi có output không phải record (`:481` — "nếu là object" của legacy guide). ✓
- `concat`/absent (và mọi giá trị lạ) → trả **array** `outputs` (`:484`). ✓
- `first` → `outputs[0]`. ✓
- Call site `:284` truyền `node.combine` nguyên từ schema; contract giới hạn `combine: z.enum(['concat','first','merge']).optional()` (`packages/contracts/src/legacy-workflow.ts:48`). ✓
- Test `wfa-runtime-join-merge.test.ts` phủ đúng 4 semantics: merge object (`:94`), merge fallback non-object → array (`:103`), concat array (`:108`), first (`:116`). ✓

### 2.2 6c — `WAITING_INPUT → WAITING_USER_INPUT` — `legacy-host-adapter.ts:45-47` — **ĐÚNG, map unconditional; KHÔNG leak trên các đường đang mount**
- `legacyWorkflowState(state) = state === 'WAITING_INPUT' ? 'WAITING_USER_INPUT' : state` — map **không điều kiện** (bỏ nhánh phụ thuộc workflow marker cũ).
- `toLegacyRow:455-458` — `const state = legacyWorkflowState(rawState)` unconditional; `done = isTerminalState(rawState)` giữ raw (đúng: WAITING_INPUT không terminal). `toLegacyRow` là nguồn DUY NHẤT của `LegacyOperationRow`.
- **Leak audit trên các đường wire đang mount** (grep toàn bộ + đọc từng consumer):
  - Poll/by-id: `legacy-http-mount.ts:693` → `toLegacyEnvelope(row)`; envelope ghi `metadata.state = row.state` (đã map) và **không** có `canonical_state` (`legacy-envelope.ts:104,175-176`).
  - List: `legacy-http-mount.ts:722` → `toLegacyListPage` → `toLegacyListItem` (state đã map qua `toLegacyRow` trước đó — `legacy-host-adapter.ts:411-427`).
  - Cancel: `legacy-host-adapter.ts:306-313` trả `{ok, row: toLegacyRow(...)}`; mount `:748` serialize `toLegacyEnvelope(outcome.row)` (đã map). ✓
  - Resume: mọi nhánh lỗi trả state qua `legacyWorkflowState` (`:333,336,348,384,391`); nhánh `:325/:381` trả `state: ''` (không lộ token). Thành công trả `{ok:true}` rồi mount project lại row bằng `toLegacyEnvelope`. ✓
  - `projectWorkflowResult:514-561` không đụng `state` (spread `...row`, chỉ thay output fields). ✓
  - **Không** còn chỗ nào trong `legacy-host-adapter.ts` trả raw state ra wire; các hit `WAITING_INPUT` còn lại là comment (`:41,266`) và so sánh logic nội bộ (`:332,383`).
- Test khóa hành vi: `wfa-api-lifecycle.test.ts:51` (có workflow marker) và `:64` (không marker — đúng điểm fail-first của 6c). ✓

### 2.3 6b — `GET /api/v1/services` — `legacy-http-mount.ts:889-905` — **ĐÚNG**
- `:895`: `const catalogue = host.serviceCatalogue?.(principal.apiKeyId) ?? [];` → khi catalogue chưa wire, trả **200** với `{status:200, message:'Lấy danh sách…', services: []}` (`:896-904`), không còn `internalError` 500.
- `serviceCatalogue` hiện vẫn chưa được wire trong `legacy-host-adapter.ts` (grep toàn `src`: chỉ còn interface `:118` + call `:895`) — tức đây đúng là nhánh "unwired" được fix; catalogue thật vẫn là việc của owner sau này (không thuộc 4 fix).
- Test khóa: `legacy-http-mount.test.ts:444-449` (200 + `services: []` + đúng message tiếng Việt). ✓

### 2.4 6a — `loadLegacyOutput` file-backend — `legacy-host-adapter.ts:606-645` — **ĐÚNG, nhánh inline không bị phá**
- `:626`: `row.outputContent != null` → trả inline bytes ngay (`Buffer.from(..., 'utf8')`) — **ưu tiên inline**, không đụng storage.
- `:627-628`: `outputFilePath` rỗng/null → `null` (mount giữ 404 `No Output`).
- `:629-635`: file-backend đọc qua **`ctx.artifacts.getBlob(filePath)`** (server-side blob reader — cùng store với canonical download), `collectOutputBytes` gom stream thành Buffer (`:639-645`); lỗi/không resolve → `catch → null` (404 legacy, không rò problem+json canonical). ✓
- `loadLegacyRow` (với tenant/apiKey fence + `deleted_at IS NULL`) chạy trước khi đọc blob (`:624`). ✓
- Test khóa: `:267` (getBlob('art-output-1') → bytes), `:283` (inline thắng, `getBlob` không được gọi), `:298` (không backend nào → null), `:311` (getBlob throw → null). ✓

## 3. Findings

- **Không có test đỏ, không có fail nào bị bỏ qua.** Cả 4 receipt-claims của các lane sửa (14 / 2+12skip / 1+31skip / 4) đều tái hiện chính xác.
- **OBS-1 (informational, không chặn):** hai module **chưa mount** `legacy-operations.ts:162` và `legacy-operation-serializers.ts:168` có field `metadata.canonical_state = state` (sẽ chứa token thô `WAITING_INPUT` nếu được mount). Grep import: cả hai chỉ được import bởi test của chính chúng (`tests/legacy-operations.test.ts`, `tests/compat-decoders.test.ts`); `legacy-envelope.ts` ghi rõ 2 module này khác contract (mục 2 của bảng so sánh). Không phải leak trên runtime hiện tại; nếu sau này mount, phải rà lại quy tắc 6c.
- **OBS-2 (informational, tồn tại từ trước, không thuộc mục 6):** `legacy-http-mount.test.ts:453` — tên test ghi "answers 401…" nhưng assert `500` (vùng RV01-F4 đã biết: unauthenticated legacy read trả 500). Không phải regression của 4 fix.
- Không sửa file nào trong phiên verify này.

## 4. Raw logs

`du-rework/coordination/reports/raw/wfa-muc6-verify2-2026-10-08/`: `01-lifecycle-full.txt` (14/14) · `02-lifecycle-file-backend.txt` (2 pass/12 skip) · `03-services-empty-list.txt` (1 pass/31 skip) · `04-join-merge.txt` (4/4). Ghi chú: output qua shell nên mỗi file có kèm khối `NativeCommandError` của PowerShell wrapper; dòng `Test Suites/Tests` bên trong là của jest.

## 5. Files touched

- `du-rework/coordination/reports/wfa-muc6-verify2-2026-10-08.md` (receipt này)
- `du-rework/coordination/reports/raw/wfa-muc6-verify2-2026-10-08/` (4 log)

Không commit, không push. Không đụng product source.
