# P5 — Implement business document-core

Owner: document-core business agent. Depends: P2 G2 + P3/P4 G3; P0 six action BRDs. Write: `businesses/document-core/`. Read: docs 05, 09–10, 13–14. Không sửa services hoặc dùng DB trực tiếp.

## Common foundation

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P5-01 | [ ] Manifest 28 variants, exact schema/version, profile recipes/slots | G3 + P0 | Schema validates, slots match provider capabilities |
| P5-02 | [ ] ActionHandler/Recipe/DocumentResult interfaces, normalize/validate/format functions | P5-01 | Six BRD types align outputSchema, stable step keys |
| P5-03 | [ ] Fixture-driven tests và pipeline common runtime | P5-02 | Common helpers covered, SDK-only side effects |

## Action packets có thể giao riêng sau P5-03

| ID | Action/module | Required work | Cases / acceptance |
|---|---|---|---|
| P5-04 | [ ] ingest | Native parse, OCR/vision fallback theo variant, split refs/provenance | DOC-01, 4 variants; parser không tự gọi LLM |
| P5-05 | [ ] extract | Invoice/contract/receipt/table/custom schemas, prompt recipe, result validation | DOC-02, 5 variants; custom schema reject trước inference |
| P5-06 | [ ] analyze | Classify/sentiment/compliance/quality/risk recipes, evidence/warnings | DOC-03, 5 variants; expected schemas rõ |
| P5-07 | [ ] transform | Convert/translate/rewrite/redact/template, supported format policy | DOC-04, 5 variants; unsupported explicit error |
| P5-08 | [ ] generate | Summary/outline/report/email/minutes/qa, text-only path | DOC-05, 6 variants; questions/input validation |
| P5-09 | [ ] compare | Diff/semantic/version, source-target binding and evidence mapping | DOC-06, 3 variants; sides validated |
| P5-10 | [ ] Whole business E2E, facade parity matrix, checkpoint/version tests | P5-04..09 | G4 business; 28 cases matrix và six-action E2E |

Mỗi action packet phải hoàn thiện action BRD → file structure → six function signatures từ doc 10 → table-driven tests → implementation → E2E. Không chỉ thêm prompt và gọi generic endpoint để đánh dấu complete; output semantics phải được validate.

## File ownership khi nhiều agent

Agent từng action sở hữu `src/actions/{action}/`, `tests/{action}/`, action doc. Manifest/schema/common pipelines do một business integration owner sửa. Không agent nào tự đổi shared DTO để phù hợp riêng action.

## Reliability cases

Checkpoint full output; retry ở step N không chạy lại success N-1; native parsing chỉ preparation khi action cần inference; profile snapshot ổn định; cancelled task không finalize success; malformed provider output thất bại có taxonomy; usage aggregated chính xác.

## Done evidence

Published manifest fixture, one worker image có sáu actions, API examples/expected response, 28 variants traceability, actual mock provider call counts, lint/typecheck/unit/E2E output. Không nhận output từ real LLM như deterministic CI golden.
