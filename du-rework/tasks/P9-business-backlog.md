# P9 — Backlog business production sau platform

Status: TODO / **không thuộc release đầu**. Depends: P8 G6 và lựa chọn business ưu tiên. Mỗi business có subproject/image/queue/manifest riêng khi được yêu cầu implement. Không tự copy toàn bộ source workflow cũ.

| ID | Business packet | Reference | Deliverables/acceptance |
|---|---|---|---|
| P9-01 | [ ] disbursement | lib/pipelines/workflows/disbursement.ts | BRD chứng từ/dữ liệu đối chiếu, schema, bounded fanout, evidence, human approval nếu cần |
| P9-02 | [ ] lc-checker | lib/pipelines/workflows/lc-checker.ts | BRD tiêu chí/rule versions được domain owner xác nhận; evidence và review, không dùng prompt như legal guarantee |
| P9-03 | [ ] doc-compare advanced | lib/pipelines/workflows/doc-compare.ts | BRD khác compare core, structure/semantic references, large-doc checkpoints |
| P9-04 | [ ] schema-workflow | lib/workflow-builder/* | DSL version/security/node capabilities, persisted DAG, no interpreter trong Orchestrator |
| P9-05 | [ ] legacy workflow/billing facade | Existing public routes | Request/response fixtures, mappings config, documented unsupported behavior |

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
