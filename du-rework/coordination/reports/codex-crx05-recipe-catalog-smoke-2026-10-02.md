# CRX-05 — Recipe catalog smoke

- **Task:** CRX-05 trong `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md`.
- **Thời điểm:** 2026-10-02T23:59:34+07:00.
- **Baseline:** HEAD `b088eec` + working tree hiện tại. Các file catalog/manifest/test được đối chiếu không có thay đổi trong working tree; `businesses/document-core/tests/parser-budgets.test.ts` đang có thay đổi không thuộc packet này.
- **Phạm vi:** read-only với source, tests, docs và gate; chỉ tạo receipt này. Không commit, không tick gate, không nhắm `nocobase-10`.

## Kết quả catalog/schema

`RecipeRegistry.getAllRecipes()` có **31 recipe document variant**, với 31 khóa khác nhau. `tests/manifest.test.ts` assert tổng 31 và phân bổ `ingest=4`, `extract=6`, `analyze=7`, `transform=5`, `generate=6`, `compare=3`. `tests/missing-variants.test.ts` đối chiếu thêm manifest actions, traceability matrix, ba recipe mới và discriminator của chúng.

| Nhóm | Số lượng | Recipe keys |
| --- | ---: | --- |
| ingest | 4 | `ingest:parse`, `ingest:ocr`, `ingest:digitize`, `ingest:split` |
| extract | 6 | `extract:invoice`, `extract:contract`, `extract:id-card`, `extract:receipt`, `extract:table`, `extract:custom` |
| analyze | 7 | `analyze:classify`, `analyze:sentiment`, `analyze:compliance`, `analyze:quality`, `analyze:risk`, `analyze:fact-check`, `analyze:summarize-eval` |
| transform | 5 | `transform:convert`, `transform:translate`, `transform:rewrite`, `transform:redact`, `transform:template` |
| generate | 6 | `generate:summary`, `generate:outline`, `generate:report`, `generate:email`, `generate:minutes`, `generate:qa` |
| compare | 3 | `compare:diff`, `compare:semantic`, `compare:version` |

Ba recipe cần xác nhận đều có descriptor trong `src/recipes/recipe-definitions.ts`:

| Recipe | Discriminator trong manifest `src/manifest/document-core.manifest.ts` | Focused smoke |
| --- | --- | --- |
| `extract:id-card` | action `extract`: `inputSchema.properties.type.enum` chứa `id-card` | Registry, schema và mock reasoning connector/validation trong `missing-variants.test.ts`. |
| `analyze:fact-check` | action `analyze`: `inputSchema.properties.task.enum` chứa `fact-check` | Registry, schema và hai lượt mock reasoning connector có checkpoint trong `missing-variants.test.ts`. |
| `analyze:summarize-eval` | action `analyze`: `inputSchema.properties.task.enum` chứa `summarize-eval` | Registry, schema và mock output kết hợp summary/evaluation trong `missing-variants.test.ts`. |

Lưu ý: số dòng nêu trong CRX-05 là từ snapshot cũ; ở source hiện tại ba khóa recipe nằm khoảng dòng 109, 228, 243 và discriminator nằm khoảng dòng 171, 204.

## Lệnh và kết quả literal

| CWD | Lệnh | Exit code | Kết quả |
| --- | --- | ---: | --- |
| `D:\Git\dugate` | `git rev-parse --short HEAD` | 0 | `b088eec` |
| `D:\Git\dugate` | `rg -n "^    '(ingest|extract|analyze|transform|generate|compare):" du-rework/businesses/document-core/src/recipes/recipe-definitions.ts` | 0 | 31 khóa, 31 giá trị khác nhau; danh sách ở bảng trên. |
| `D:\Git\dugate\du-rework\businesses\document-core` | `pnpm exec jest --runInBand tests/manifest.test.ts tests/missing-variants.test.ts` | 0 | 2 suites passed, 19/19 tests passed. |

Raw output của focused Jest run:

```text
Test Suites: 2 passed, 2 total
Tests:       19 passed, 19 total
Snapshots:   0 total
Time:        3.16 s
Ran all test suites matching tests/manifest.test.ts|tests/missing-variants.test.ts.
```

## Trạng thái và giới hạn

**Catalog/schema = IMPLEMENTED candidate**, có focused smoke trên diff hiện tại. Đây là kiểm chứng offline với mock connector; recipe count và schema/discriminator **không chứng minh** ngữ nghĩa output, byte gửi tới provider hoặc external wire 31/31. Các phần đó cần fixture/verification riêng theo `COMP-10`/`VFY-COMP`. Không tick `RV01-06`, `COMP-04` hoặc `VFY-COMP`; không đưa ra verdict ACCEPTED.

Metadata `businesses/document-core/package.json` hiện còn mô tả “28 variants”; không sửa vì lease read-only. Docs owner có thể cập nhật sau receipt này.
