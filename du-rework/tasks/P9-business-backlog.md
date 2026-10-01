# P9 — Workflow businesses bắt buộc cho external compatibility

Status 2026-09-30: TODO / **thuộc scope trước cutover DUGate cũ** theo yêu cầu giữ nguyên workflow API. Phụ thuộc contract P1–P7 và `COMP-00/01/02`, **không phụ thuộc G6** vì P9-01..05 là một đầu vào của `G-COMP`/G6. Ba process `disbursement`, `lc-checker`, `doc-compare` cùng schema workflow đều bắt buộc; mỗi business có subproject/image/queue/manifest riêng. Không tự copy toàn bộ source workflow cũ. Xem [plan API compatibility](API-COMPAT-DUGATE-2026-09-28.md).

> **Scope decision 2026-09-23 03:33 — REVERSED cùng ngày 08:06 (user, qua orchestrator):** P9 được
> **mở lại và giao cho Command Code**, bắt đầu bằng `W39-CC3 = P9-01 disbursement`. Lý do đảo
> ngược: quyết định gác ban đầu dựa trên một đọc nhầm của orchestrator — các path `lib/…` nằm trong
> cột **`Reference`** (chỉ đọc để lấy nghiệp vụ cũ), không phải nơi phải sửa. Toàn bộ deliverable
> của P9 làm trong `du-rework/businesses/<name>/`, theo template đã chứng minh là
> `businesses/example-review`. Ràng buộc: **không sửa gì ngoài `du-rework/`**, đặc biệt
> `lib/workflow-builder/run-schema.ts` đang dirty từ work cũ trên branch → cấm đụng; zero DB/Redis
> cho tới khi `DB RELEASED` xuất hiện ở lane giữ window; không gọi AI thật, dùng mock provider
> `tests/stubs/provider/mock-provider.ts` và synthetic fixtures. Row chỉ tick khi có bằng chứng
> registration + cross-service run, nếu không thì giữ `[ ]` và nêu rõ mục chưa prove được.

| ID | Business packet | Reference | Deliverables/acceptance |
|---|---|---|---|
| P9-01 | [ ] disbursement | lib/pipelines/workflows/disbursement.ts | BRD chứng từ/dữ liệu đối chiếu, schema, bounded fanout, evidence, human approval nếu cần |
| P9-02 | [ ] lc-checker | lib/pipelines/workflows/lc-checker.ts | BRD tiêu chí/rule versions được domain owner xác nhận; evidence và review, không dùng prompt như legal guarantee |
| P9-03 | [ ] doc-compare advanced | lib/pipelines/workflows/doc-compare.ts | BRD khác compare core, structure/semantic references, large-doc checkpoints |
| P9-04 | [ ] schema-workflow | lib/workflow-builder/* | DSL version/security/node capabilities, persisted DAG, no interpreter trong Orchestrator |
| P9-05 | [ ] legacy workflow facade; billing theo consumer inventory | Existing public routes | Giữ `POST /api/v1/docs/workflows` (`process`) và `/docs/workflows/schema` (`schemaSlug`), poll/result/HITL/lifecycle theo golden fixtures; billing/services nếu external consumer đang dùng phải có parity trước cutover, không chỉ ghi unsupported. |

## Quy trình chung từng business packet

1. Business document: actor, input corpus, rules, output/evidence, domain validation, exception/human cases.
2. Structure/interface: manifest/actions/profile/connector slots, versioned input/output/resume schemas, handler kinds.
3. Functions: normalize/prepare/execute/validate/finalize, stable step/task IDs và dependency plan.
4. Test cases: golden synthetic corpus, invalid inputs, provider errors, duplicates, human/restart/version tests.
5. Implementation: SDK+document-kit+connector client; không sửa platform cho registration thông thường.
6. Verification: standalone image, registration/profile/E2E, capacity budget, evidence và release notes.

Đặc biệt schema-workflow: hỗ trợ node list phải whitelist, validation không eval arbitrary code, URL/callback policy và archive safeguards. Visual workflow designer là UX task riêng cần scope, không suy ra tự động từ dynamic profile editor.

## Migration boundary

Nếu cần chuyển config/data từ DUGate cũ, tạo packet migration riêng với export schema, secret handling, dry-run, reconciliation, rollback và traffic switching. Không P9 task nào có quyền tự truy cập production data hay đổi traffic.
