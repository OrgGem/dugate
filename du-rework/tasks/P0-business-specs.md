# P0 — Business documents và baseline scope

Owner: product/architecture agent. Prerequisite: bộ plan này. Write: `docs/`, `businesses/document-core/docs/`, task status. Không tạo runtime source ở phase này.

Read: docs 01, 10, 14, 15 và registry/runner cũ qua reference links.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P0-01 | [ ] Requirements traceability BR-01..12 → UC → test IDs; actor/authorization matrix | None | Mỗi BR có owner, scenario và test |
| P0-02 | [x] Viết sáu action BRD ingest/extract/analyze/transform/generate/compare | P0-01 | 28 variants, pre/postconditions, fields, examples, errors |
| P0-03 | [ ] Characterization/compatibility matrix từ public handlers cũ | P0-02 | Field aliases, status/result differences, giữ/sửa/defer rõ | <!-- W40-CX: stays [ ]; gaps in reports/codex.md -->
| P0-04 | [x] Provider capability và document format matrix | P0-02 | Variant nào native/provider, supported outputs, unsupported behavior |
| P0-05 | [x] Test fixture specification và expected result corpus không nhạy cảm | P0-02/04 | Test cases trước code, native parser expectations khác mock LLM |
| P0-06 | [x] Workload/SLO/retention/auth assumptions, decision updates | P0-01 | Giá trị benchmark ghi là assumption; production SLA chưa biết không bịa | <!-- W42: USER delegated acceptance to the orchestrator, BY ASSUMPTION not benchmark. Basis: docs/22 + workload-assumptions.md — every value labelled IMPLEMENTED (file+constant) / TARGET-UNENFORCED / NO-TARGET-STATED, nothing invented. P8-05 still needs real measurement. Codex-2 reverted this to [ ] ~21:20 on my stale W42-CX5 line; superseded -->

Status audit 2026-09-21: P0-02/P0-04 được kiểm tra bởi `@du/document-core` `tests/manifest.test.ts` và `tests/traceability.test.ts` trong lần chạy `pnpm test` (188 tests của package), cùng BRD/matrix dưới `businesses/document-core/docs/`. Các row còn lại giữ unchecked vì acceptance metadata/corpus/workload chưa được chứng minh đầy đủ; xem [evidence matrix](../coordination/IMPLEMENTATION-STATUS.md).

Status audit 2026-09-23 (W39-CX): P0-01 stays [ ] - BR-05 TTL/quotas, UC-07 drain breadth, operator endpoints lack tests; see coordination/reports/codex.md.
Status audit 2026-09-23 (W39-A6-6): P0-05 marked [x] - Test fixture specification documented at `businesses/document-core/docs/test-fixture-specification.md`; expected result corpus created at `businesses/document-core/tests/fixtures/expected-result-corpus.ts` with 100% of the 28 variants derived directly from running `documentCoreHandlers` offline. tsc passes, 29/29 all-variants-e2e pass.

## Function/interface preparation

Mỗi action BRD liệt kê validateInput/selectRecipe/prepareSources/executeRecipe/validateResult/formatResult và payload examples. Implementation tương ứng hiện nằm trong `businesses/document-core`; thay đổi tiếp theo vẫn phải giữ capability slots thống nhất và server-side acceptance case cho field client không được override.

## Test design

Mỗi variant: success, missing/invalid discriminator/input, unsupported format, profile locked override, provider invalid response, oversized input khi phù hợp. Cases dùng DOC-01..06 kèm suffix variant; không chỉ ảnh chụp UI.

## Gate G0

BRD complete, variants count đúng, known unknowns có owner/default. Inventory không sửa source cũ. Handoff: six BRDs, request/result examples, compatibility matrix và decision log.
