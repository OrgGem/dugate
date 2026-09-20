# P0 — Business documents và baseline scope

Owner: product/architecture agent. Prerequisite: bộ plan này. Write: `docs/`, `businesses/document-core/docs/`, task status. Không tạo runtime source ở phase này.

Read: docs 01, 10, 14, 15 và registry/runner cũ qua reference links.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P0-01 | [ ] Requirements traceability BR-01..12 → UC → test IDs; actor/authorization matrix | None | Mỗi BR có owner, scenario và test |
| P0-02 | [ ] Viết sáu action BRD ingest/extract/analyze/transform/generate/compare | P0-01 | 28 variants, pre/postconditions, fields, examples, errors |
| P0-03 | [ ] Characterization/compatibility matrix từ public handlers cũ | P0-02 | Field aliases, status/result differences, giữ/sửa/defer rõ |
| P0-04 | [ ] Provider capability và document format matrix | P0-02 | Variant nào native/provider, supported outputs, unsupported behavior |
| P0-05 | [ ] Test fixture specification và expected result corpus không nhạy cảm | P0-02/04 | Test cases trước code, native parser expectations khác mock LLM |
| P0-06 | [ ] Workload/SLO/retention/auth assumptions, decision updates | P0-01 | Giá trị benchmark ghi là assumption; production SLA chưa biết không bịa |

## Function/interface preparation

Mỗi action BRD liệt kê validateInput/selectRecipe/prepareSources/executeRecipe/validateResult/formatResult và payload examples; chưa viết code. Các capability slots có tên thống nhất. Những field client không được override có server-side acceptance case.

## Test design

Mỗi variant: success, missing/invalid discriminator/input, unsupported format, profile locked override, provider invalid response, oversized input khi phù hợp. Cases dùng DOC-01..06 kèm suffix variant; không chỉ ảnh chụp UI.

## Gate G0

BRD complete, variants count đúng, known unknowns có owner/default. Inventory không sửa source cũ. Handoff: six BRDs, request/result examples, compatibility matrix và decision log.
