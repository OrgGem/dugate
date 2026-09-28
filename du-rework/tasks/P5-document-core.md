# P5 — Implement business document-core

> **Acceptance hold 2026-09-27:** [INGEST-WIRE-01](ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md) yêu cầu OCR/digitize truyền bytes/artifact thật tới Connector trong multi-container E2E. Tick P5-04/P5-10 lịch sử và parse-only live receipt không chứng minh hai variant này. Không đổi tick trước khi Tester độc lập và Claude Code review packet bổ sung.

Owner: document-core business agent. Depends: P2 G2 + P3/P4 G3; P0 six action BRDs. Write: `businesses/document-core/`. Read: docs 05, 09–10, 13–14. Không sửa services hoặc dùng DB trực tiếp.

## Common foundation

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P5-01 | [x] Manifest 28 variants, exact schema/version, profile recipes/slots | G3 + P0 | Schema validates, slots match provider capabilities |
| P5-02 | [x] ActionHandler/Recipe/DocumentResult interfaces, normalize/validate/format functions | P5-01 | Six BRD types align outputSchema, stable step keys |
| P5-03 | [x] Fixture-driven tests và pipeline common runtime | P5-02 | Common helpers covered, SDK-only side effects |

## Action packets và trạng thái đã kiểm chứng

| ID | Action/module | Required work | Cases / acceptance |
|---|---|---|---|
| P5-04 | [x] ingest | Native parse, OCR/vision fallback theo variant, split refs/provenance | DOC-01, 4 variants; parser không tự gọi LLM |
| P5-05 | [x] extract | Invoice/contract/receipt/table/custom schemas, prompt recipe, result validation | DOC-02, 5 variants; custom schema reject trước inference |
| P5-06 | [x] analyze | Classify/sentiment/compliance/quality/risk recipes, evidence/warnings | DOC-03, 5 variants; expected schemas rõ |
| P5-07 | [x] transform | Convert/translate/rewrite/redact/template, supported format policy | DOC-04, 5 variants; unsupported explicit error |
| P5-08 | [x] generate | Summary/outline/report/email/minutes/qa, text-only path | DOC-05, 6 variants; questions/input validation |
| P5-09 | [x] compare | Diff/semantic/version, source-target binding and evidence mapping | DOC-06, 3 variants; sides validated |
| P5-10 | [x] Whole business E2E, facade parity matrix, checkpoint/version tests | P5-04..09 | G4 business; 28 cases matrix và six-action E2E |

Review sau Wave 24-25 ngày 2026-09-22:
P5-10 đã được nghiệm thu đầy đủ ở phạm vi business E2E và G4 business gate:
1. 28-variant matrix: Được kiểm chứng độc lập trong `businesses/document-core/tests/all-variants-e2e.test.ts` (28/28 variants pass qua `documentCoreHandlers` với synthetic fixtures).
2. Six-action live E2E: Được kiểm chứng trong `businesses/document-core/tests/multi-container-e2e.integration.test.ts` (13/13 tests pass) với live Orchestrator, real Connector composition, HTTP mock provider, PostgreSQL invocation ledger, outbox, và HTTP usage sink:
   - Sáu actions đều được test live: extract (invoice), analyze (classify), generate (summary), ingest (parse), transform (redact), compare (diff).
   - Kiểm chứng facade parity và durable step checkpoints trên PostgreSQL và Redis.
   - Replay/retry: test cooperative 429 rate-limit barrier và SIGKILL process crash lease recovery.
   - Version pinning (v1.0.0 vs v1.1.0), profile action authorization (PRF-01), và connector revision pinning qua profile update (PRF-02) giải quyết qua resultRef artifact envelope.
3. Bãi bỏ các nhận định cũ từ FIX-07: không còn stub `runtime.invoke`, fixed invoice stub, hay extract-only bypass; toàn bộ pipeline sử dụng real Connector composition và HTTP mock provider.
4. Image production (đóng gói Docker, freeze image digest, deployment orchestration) thuộc phạm vi P8, tách biệt với business E2E logic.
Tổng số test document-core: 28 suites / 361 tests pass (13 E2E + 1 BullMQ smoke + 347 unit tests across 26 suites), typecheck `tsc --noEmit -p tsconfig.test.json` 0 errors.

Mỗi action packet phải hoàn thiện action BRD → file structure → six function signatures từ doc 10 → table-driven tests → implementation → E2E. Không chỉ thêm prompt và gọi generic endpoint để đánh dấu complete; output semantics phải được validate.

## File ownership khi nhiều agent

Agent từng action sở hữu `src/actions/{action}/`, `tests/{action}/`, action doc. Manifest/schema/common pipelines do một business integration owner sửa. Không agent nào tự đổi shared DTO để phù hợp riêng action.

## Reliability cases

Checkpoint full output; retry ở step N không chạy lại success N-1; native parsing chỉ preparation khi action cần inference; profile snapshot ổn định; cancelled task không finalize success; malformed provider output thất bại có taxonomy; usage aggregated chính xác.

## Done evidence

Published manifest fixture, one worker image có sáu actions, API examples/expected response, 28 variants traceability, actual mock provider call counts, lint/typecheck/unit/E2E output. Không nhận output từ real LLM như deterministic CI golden.
