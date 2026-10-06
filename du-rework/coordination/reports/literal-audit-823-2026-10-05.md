# LITERAL-AUDIT-823 — 2026-10-05

## Phạm vi và kết luận

Audit độc lập bằng working tree, `git diff HEAD`, `git show HEAD`, `git ls-tree HEAD` và grep trên `du-rework` TypeScript. Không sửa source/test, không chạy test, không commit/tick; chỉ tạo receipt này.

Kết luận phân biệt hai cách đếm:

- **6/6 vị trí chức năng supervisor liệt kê** có reader điều khiển bởi `MetadataReadPolicy` trong working tree hiện tại.
- Tuy nhiên, **HEAD chỉ chứng minh 1 literal `true` executable** trong sáu mục đó: `runtime.ts:221`, generic `openMetadata`. Hai vị trí `getChildren` và join trong HEAD còn trả/copy `result_ref` thô; `public.ts` và `mappers.ts` hiện là file untracked, không có snapshot tương ứng trong HEAD. Do vậy, claim “sáu literal đã bị thay” không được `git show HEAD` xác nhận đủ 6/6.

## Đối chiếu sáu vị trí cũ

| Mục supervisor | Working tree hiện tại | Bằng chứng từ HEAD/diff |
|---|---|---|
| `runtime.ts:481,483` | `runtime.ts:485,487`: nhánh text gọi `reader.readStoredText`, nhánh jsonb gọi `reader.readStored`. | `git show HEAD:.../runtime.ts` có một `crypto.readStored(value, context, true)` ở HEAD line 221. Working diff thay helper đó bằng reader shape dispatch. Hai số line cũ mô tả hai nhánh hiện tại, không phải hai literal riêng trong HEAD. |
| `runtime.ts:1232` | Child `tasks.result_ref` qua `reader.readStoredText` ở line 1241, binding theo tenant/row. | HEAD line 894 gán `resultRef: r.result_ref` trực tiếp; diff thêm policy reader. Đây là chuyển từ raw pass-through, không phải thay literal `true`. |
| `runtime.ts:1844` | Sibling `tasks.result_ref` qua `reader.readStoredText` ở line 1854. | HEAD line 1470 gán trực tiếp `s.result_ref` vào `joinSummary`; diff thêm policy reader. Đây cũng không phải thay literal `true`. |
| `public.ts:538` | `/operations/:id/result` đọc `operations.result_ref` qua `ctx.metadataReader` ở line 538. | `public.ts` không có trong `git ls-tree HEAD`; hiện untracked. Không có committed before/after để gán chính xác wave bằng Git. |
| `mappers.ts:103` | Admin operation `operations.result_ref` đọc qua `ctx.metadataReader` ở line 144. | `mappers.ts` không có trong `git ls-tree HEAD`; hiện untracked. Không có committed before/after để gán chính xác wave bằng Git. |

Các số line cũ đã dịch chuyển. Runtime helper replacement có comment `CONTROL-PLANE-IMPL-818` trong diff. Runtime child/join edits mang nhãn `ENCMETA-RESULTREF R2/R3` và đồng thời dùng reader. `ingestion-consumer.ts` policy read cũng có nhãn `CONTROL-PLANE-IMPL-818` trong working diff. Với `public.ts`/`mappers.ts`, file untracked khiến Git không xác nhận wave; chỉ có thể kết luận theo code hiện tại, không theo committed history.

## Call-site inventory hiện tại

“Consumer read site” dưới đây là nơi lấy giá trị metadata; `openMetadata` là helper chung. Trong `runtime.ts`, helper có hai nhánh policy delegation và sáu caller của helper, cộng hai direct child-result reads.

| File:line | Slot / mục đích |
|---|---|
| `modules/runtime/runtime.ts:485` | `openMetadata` string → `reader.readStoredText`. |
| `modules/runtime/runtime.ts:487` | `openMetadata` object/jsonb → `reader.readStored`. |
| `modules/runtime/runtime.ts:1064` | Replay/idempotent claim `tasks.payload_ref`, qua helper. |
| `modules/runtime/runtime.ts:1241` | `getChildren` child `tasks.result_ref`. |
| `modules/runtime/runtime.ts:1854` | Parent-join sibling `tasks.result_ref`. |
| `modules/runtime/runtime.ts:1866` | Parent join `tasks.payload_ref`, qua helper. |
| `modules/runtime/runtime.ts:1934` | Checkpoint `session_ref`, qua helper. |
| `modules/runtime/runtime.ts:1945` | Checkpoint `output_ref`, qua helper. |
| `modules/runtime/runtime.ts:1975` | Claim `operations.input_ref`, qua helper. |
| `modules/runtime/runtime.ts:2015` | Claim `tasks.payload_ref`, qua helper. |
| `http/routes/public.ts:538` | Public result `operations.result_ref`. |
| `modules/operations/mappers.ts:71` | Admin/request mapper `operations.input_ref`. |
| `modules/operations/mappers.ts:144` | Admin operation mapper `operations.result_ref`. |
| `modules/operations/ingestion-consumer.ts:711` | Ingestion READY gate `tasks.payload_ref`. |

Theo cách đếm biểu thức gọi reader: runtime 10 (gồm hai nhánh helper), public 1, mappers 2, ingestion consumer 1 — **14 biểu thức**. Theo cách đếm giá trị metadata do consumer đọc, bỏ hai nhánh dispatch nội bộ của helper: runtime 8, public 1, mappers 2, ingestion 1 — **12 read sites**. Vì các cách grep khác nhau có thể đếm import, type, khởi tạo reader và truyền reader vào helper, tổng “13/4/4” không đồng nhất với read-site count này.

## Hai read site ngoài danh sách sáu

1. `operations/mappers.ts:71` đọc `operations.input_ref` để dựng/redact request input trong admin mapper. Danh sách cũ chỉ ghi `operations.result_ref` ở mapper; input là slot riêng nhưng dùng chung reader.
2. `operations/ingestion-consumer.ts:711` đọc root `tasks.payload_ref` ở READY gate. Đây là read cần mở submit-side envelope trước ingestion processing; nguồn `sourceUrl` vẫn là strict path riêng ở line 344.

Các `openMetadata(reader, ...)` khác trong runtime ở lines 1064, 1866, 1934, 1945, 1975, 2015 không phải các literal mới: chúng đi qua hai nhánh reader chung ở lines 485/487.

## Strict-false paths

Bốn consumer/gate paths hiện vẫn fail-closed:

1. `runtime.ts:363-366`: `operations.prompt_overrides_ref` gọi `crypto.readStored(..., false)`; không dùng policy/window.
2. `metadata-auth-counter.ts:287-291`: text branch xác thực envelope bằng `readStoredText(..., false)`.
3. `metadata-auth-counter.ts:293-297`: jsonb branch xác thực envelope bằng `readStored(..., false)`.
4. `ingestion-consumer.ts:344-348`: sealed dispatch `sourceUrl` gọi `crypto.readStored(..., false)`; comment xác định sourceUrl không dùng plaintext window.

Ngoài bốn consumer path, `runtime/metadata-crypto.ts:427` luôn gọi `crypto.readStored(parsed, context, false)` khi mở envelope đã nhận diện trong helper text; đây là strict decode nội bộ, không phải policy-controlled consumer mới.

Các literal false trên đều hiện diện. Git baseline không chứng minh cả bốn “không từng thay đổi”: `runtime.ts` và `ingestion-consumer.ts` có diff, `metadata-auth-counter.ts` untracked. Kết luận ở đây là trạng thái code hiện tại vẫn strict-false, không phải claim về lịch sử bất biến.

## Grep literal true trên toàn source

Lệnh tìm trên `du-rework` TypeScript, loại test files:

`rg -n -U 'allowPlaintext\s*[:=]\s*true|readStored(Text)?\([\s\S]{0,300}?,\s*true\s*\)' du-rework --glob '*.ts' --glob '!**/tests/**'`

Hai match đều là comment, không phải code executable:

- `services/orchestrator/src/main.ts:150` — mô tả literal lịch sử.
- `services/orchestrator/src/modules/encryption/metadata-read-policy.ts:200` — mô tả không để call site tự viết literal.

Không tìm thấy executable `allowPlaintext: true` hoặc reader call truyền third argument `true` trong source đã quét, kể cả ngoài bốn file được liệt kê.

## Số reader được inject

`create-app.ts:347` tạo **một** `MetadataReader` từ `metadataCrypto` và `metadataReadPolicy`. Cùng object được truyền vào ba composition targets: runtime (`create-app.ts:348-352`), ingestion consumer khi metadata crypto được cấu hình (`:535`), và route context (`:742`; field khai báo tại `http/route-context.ts:91`). Public route và mappers đọc field đó từ route context. Vì vậy: **1 shared reader instance, 3 injection edges**, không phải một reader độc lập cho từng file/call site.

## Unit evidence hiện có

`tests/metadata-read-policy.test.ts:75-96` đã kiểm tra window trước/sau thời điểm hết hạn và `forbid` luôn false; các assertion tương ứng nằm ở lines 77-80, 85-89, 91-96. Packet này không chạy test vì là audit read-only.

## Git state

Runtime và ingestion consumer là modified; public route, mappers, create-app, route-context, `metadata-read-policy.ts`, `metadata-auth-counter.ts` và policy test là untracked trong working tree. Vì thế diff/HEAD có thể xác định replacement của runtime helper và raw child refs, nhưng không thể dùng để chứng minh lịch sử của hai split files hoặc các file untracked. Không có source/test nào bị thay đổi bởi audit này.
