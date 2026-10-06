# Open-task register - 2026-10-03

Snapshot: 2026-10-03 Asia/Bangkok, current working tree. This is a plan inventory, not an ACCEPTED verdict. No task plan, source, test, or docs file was edited; no gate tick, commit, or nocobase-10 work.

## Method

- Scanned every top-level Markdown file in `du-rework/tasks/*.md`: 37 files, including old plans, README, and templates. Locations below are physical UTF-8 working-tree line numbers, relative to `du-rework/`.
- Included unfinished primary task rows with [ ], [~], TODO, PARTIAL, BLOCKED, plus unmarked task packets/headings. Excluded historical [x] rows, except P8-04 because newer review text explicitly keeps a security acceptance hold. Repeated explanation/acceptance rows and duplicate aliases within a file were counted once; COMP subtask IDs are separate rows.
- `unmarked` means no checkbox/status on the task line; current completion is uncertain. `stale-suspected` is an additional flag when a related recent receipt filename exists. A receipt may cover only inventory, a draft, an offline slice, or partial implementation; it does not prove full acceptance.
- Primary categories: implementation-open, verification-open, docs-open, decision-gated, infra-gated. Decision blockers and live/lab dependencies are noted in rows. Counts are per plan file, so the same parent can appear in more than one plan.
- Cross-checked recent filenames under `coordination/reports/`. Did not audit all raw evidence or rerun tests. Any conflict between old text, marker, and receipt remains uncertain pending owner/reviewer reconciliation.

## Open tasks by plan

### `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` - 11 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `ACUI-00` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:37` | decision-gated | Catalog mọi setting; phân loại managed, secret-ref, deployment; mapping legacy config → replacement, dependency register...; blocker: contract/owner decision; exact sign-off uncertain |
| `ACUI-01` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:38` | implementation-open | Shell/BFF read và mutation nền tảng, xử lý ACUI-M07 trước khi hiện dữ liệu tenant thật; nav Identity, Settings; form có CSRF... |
| `ACUI-02` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:39` | implementation-open | OIDC Providers UI: tạo/chỉnh issuer, client ID, redirect URI, discovery/JWKS policy, secret write-only, callback allowlist... |
| `ACUI-03` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:40` | implementation-open | Users, roles, tenant access: danh sách local + federated identities theo immutable issuer+sub; local... |
| `ACUI-04` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:41` | implementation-open | Profiles: list/create/draft/diff/validate/publish/activate/rollback; action enable, business/version pin, connector slots... |
| `ACUI-05` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:42` | implementation-open | API keys: issue, copy-once thật, list/search, scoped grants/profile assignment, rotate, disable/revoke và audit; sửa form... |
| `ACUI-06` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:43` | implementation-open | Connectors và accounts: catalog adapter/capability, create/config revision, endpoint/allowlist, account và credential... |
| `ACUI-07` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:44` | implementation-open | Business/workflow UI: registry version/enable/drain/retire, workflow schema catalog/import/builder/publish/rollback, mapping... |
| `ACUI-08` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:45` | implementation-open | Tenant/security/delivery policy: API limits/quotas, webhook/callback và retry policy, retention, artifact storage mode... |
| `ACUI-09` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:46` | decision-gated | Deployment settings UI: cấu hình process/infra của Orchestrator, Connector, Worker qua deployment adapter: DB/Redis...; blocker: deployment adapter and rollout owner/contract |
| `ACUI-10` | `[ ]` | `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md:47` | verification-open | Verification và tài liệu: ma trận browser/API cho mọi hàng ACUI-02..09, hai tenant, hai replica, local/OIDC/both... |

### `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md` - 7 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `LOCAL-00` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:25` | decision-gated | Ký mode env, default/migration của token login, machine bearer policy, role×action×tenant matrix, bootstrap/reset/lockout...; blocker: Product + security + architecture decision |
| `LOCAL-01` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:26` | implementation-open | Migration admin_local_users (ID bất biến, username chuẩn hóa duy nhất, hash, role, tenant scope, enabled/locked... |
| `LOCAL-02` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:27` | implementation-open | Verify password constant-time, bounded rate limit/lockout, generic 401 không lộ user enumeration; mint/rotate opaque session... |
| `LOCAL-03` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:28` | implementation-open | Parse DU_ADMIN_AUTH_MODE trong main.ts; mount shell local-only không cần ADMIN_TOKEN/OIDC; GET/POST login UI theo mode, OIDC... |
| `LOCAL-04` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:29` | implementation-open | Các Admin read/mutation dùng một trusted principal từ local/OIDC, role×action×tenant và CSRF giống nhau; không đưa static... |
| `LOCAL-05` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:30` | verification-open | Matrix local/oidc/both/invalid config: boot, login success/fail, brute-force/lockout, CSRF, logout, reset/disable, stale... |
| `LOCAL-06` | `[ ]` | `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md:31` | docs-open | .env.example, Docker/K8s env mapping, Admin user bootstrap/reset/recovery runbook, mode-switch/rollback, no-secret logs... |

### `tasks/ADMIN-OPS-UX-2026-09-24.md` - 8 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `ADM-UX-00` | `[ ]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:18` | docs-open + stale-suspected | Chốt operator journeys, thông tin ưu tiên, wireframes và baseline / Product + UX + QA; receipt: `codex-orch-par-00-admin-operator-journeys-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `ADM-UX-01` | `[~]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:19` | implementation-open | Shell gọn và responsive / Admin UI |
| `ADM-UX-02` | `[~]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:20` | implementation-open | Contract truy vấn/list API tenant-scoped / Platform API + contracts |
| `ADM-UX-03` | `[~]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:21` | implementation-open | Search/filter toolbar và deep links thống nhất / Admin UI |
| `ADM-UX-04` | `[~]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:22` | implementation-open | Overview thực sự phục vụ triage / Platform audit/metrics + Admin UI |
| `ADM-UX-05` | `[~]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:23` | implementation-open | Operations cockpit list→detail→action / Admin UI + Platform BFF |
| `ADM-UX-06` | `[~]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:24` | implementation-open | Màn cấu hình gọn và truy vết thay đổi / Admin UI + Profile/Connector owners |
| `ADM-UX-07` | `[ ]` | `tasks/ADMIN-OPS-UX-2026-09-24.md:25` | verification-open | Gate UX + security browser/live-service / QA + Security + Admin UI |

### `tasks/AGENT-TASK-TEMPLATE.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/API-COMPAT-DUGATE-2026-09-28.md` - 24 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `COMP-00` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:49` | decision-gated | Chốt URL generic mới (legacy path/default không đổi), bounds materialization, lifecycle thật, auth hardening/consumer...; blocker: Product/API architect/consumer wire decision |
| `COMP-01` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:50` | docs-open + stale-suspected | Characterization matrix từng route và 31 core variants, ba workflow + schema, status/header/body/error/binary/webhook...; receipt: `comp-01-characterization-matrix.md` (receipt scope needs reconciliation; uncertain) |
| `COMP-02` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:51` | implementation-open | Freeze legacy request/response/error/state/list schemas với legacy là default trên path cũ, URL/version generic mới và... |
| `COMP-03` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:52` | implementation-open | Thêm sáu POST /api/v1/docs/{service} multipart facade: files[], file, source_file, target_file, file_urls, webhook_url... |
| `COMP-04` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:53` | implementation-open + stale-suspected | Đối chiếu input/recipe/output/profile/connector cho 31/31 variants; extract:id-card, analyze:fact-check...; receipt: `codex-crx05-recipe-catalog-smoke-2026-10-02.md` (catalog/schema only; semantics remain open) |
| `COMP-05` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:54` | implementation-open | Projection từ output artifact/checkpoint/usage thành legacy result và metadata thực: MIME → output_format, checkpoint →... |
| `COMP-06` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:55` | implementation-open | List legacy {operations,next_page_token} và detail name/done/metadata cộng result hoặc error mặc định trên shared path cũ... |
| `COMP-07` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:56` | implementation-open | Cancel, resume, operation download và DELETE đều bắt buộc trên path cũ; response/status phải đúng fixture hoặc nêu blocker... |
| `COMP-08` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:57` | implementation-open | Projection /services, /billing/balance và /billing/usage từ dữ liệu đã xác thực theo API key; kiểm start_date/end_date... |
| `COMP-09` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:58` | implementation-open | Lập mapping process → businessId/version/action/profile cho cả ba workflow và schemaSlug → registered schema business; nối... |
| `COMP-10` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:59` | verification-open | Chạy cùng legacy request không thêm header/query trên hai hệ thống, so status/header/body (JSON key và giá trị/binary) cho... |
| `COMP-11` | `[ ]` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:60` | docs-open | Đồng bộ docs/06-public-api.md, 20-openapi-descriptions.md, 21-openapi.json, compatibility matrix, migration guide, docs/19... |
| `COMP-01a` | `READY-NOW` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:81` | docs-open + stale-suspected | Core 6 route + 31 variant matrix; receipt: `codex-comp01-slice-a-legacy-route-matrix-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `COMP-01b` | `READY-NOW` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:82` | docs-open + stale-suspected | Workflows(3)+schema+services+billing matrix; receipt: `codex-comp01-slice-g-workflow-schema-services-billing-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `COMP-01c` | `READY-NOW` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:83` | docs-open + stale-suspected | Lifecycle+list matrix (cancel/resume/download/DELETE, pagination, state map); receipt: `codex-comp01-slice-d-lifecycle-pagination-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `COMP-03a` | `BLOCKED-COMP-00` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:85` | implementation-open | /docs/{service} route + submit dispatch |
| `COMP-03b` | `BLOCKED-COMP-00` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:86` | implementation-open | Strict legacy input decoder (snake_case/discriminator/file_urls/profile-lock) |
| `COMP-04a` | `READY-MODULE; public acceptance blocked COMP-00` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:87` | implementation-open | Đối chiếu 28 variant hiện có ↔ 31 fixture (input/recipe/output/profile) |
| `COMP-04b` | `READY-MODULE; golden VFY-COMP riêng` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:88` | verification-open + stale-suspected | Implement 3 variant thiếu (extract:id-card, analyze:fact-check, analyze:summarize-eval); blocker: 31 catalog smoke exists; semantic/provider/wire fixture pending; receipt: `codex-crx05-recipe-catalog-smoke-2026-10-02.md` (catalog/schema only; uncertain) |
| `COMP-05a` | `READY-MODULE; public wire blocked COMP-00/02` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:89` | implementation-open | Projection progress/pipeline_steps (bỏ facade.ts progress=0, đọc reportProgress + step_checkpoints) |
| `COMP-05b` | `BLOCKED` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:90` | implementation-open | Projection content/extracted_data/usage/output_format/download_url (bounded inline read, artifact policy) |
| `COMP-05c` | `BLOCKED` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:91` | implementation-open | Encryption union: delivery giải mã ra TOÀN BỘ legacy result |
| `COMP-10-off` | `per-wave` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:98` | verification-open | Golden contract tests offline (mỗi route + 31 variant + workflow scope) |
| `COMP-10-live` | `per-wave, không global DB window` | `tasks/API-COMPAT-DUGATE-2026-09-28.md:99` | verification-open | Live PG/Redis/S3/Vault/Connector + external decrypt |

### `tasks/APP-ENCRYPTION-2026-09-27.md` - 12 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `ENC-00` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:22` | decision-gated | —; blocker: Product + security + architecture decision |
| `ENC-01` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:23` | implementation-open | ENC-00, RESULT-WIRE-01 |
| `ENC-02` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:24` | implementation-open | ENC-00; VAULT-02 policy nền |
| `ENC-03` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:25` | implementation-open | ENC-01, ENC-02; DATA-01 |
| `ENC-META-01` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:26` | implementation-open | ENC-01, ENC-02; P2 submit/claim contracts |
| `ENC-04` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:27` | implementation-open | ENC-03, ENC-META-01; DATA-03/04 |
| `ENC-05` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:28` | implementation-open | ENC-03; DATA-02 |
| `ENC-06` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:29` | implementation-open | ENC-00, ENC-01; OIDC-03/SEC-00 |
| `ENC-07` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:30` | implementation-open | ENC-01, ENC-03, ENC-06; RESULT-WIRE-01 |
| `ENC-08` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:31` | implementation-open | ENC-02, ENC-06, ENC-07; OIDC-04/ADM-BASE-02 |
| `ENC-09` | `[~]` | `tasks/APP-ENCRYPTION-2026-09-27.md:32` | implementation-open | ENC-03, ENC-META-01, ENC-04, ENC-05, ENC-07; DATA-05 |
| `ENC-INT-01` | `[ ]` | `tasks/APP-ENCRYPTION-2026-09-27.md:33` | infra-gated | ENC-META-01, ENC-04..09; DATA-INT-01, SEC-INT-01; blocker: live/lab namespace, service or deployment evidence |

### `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md` - 5 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `DOC-SYNC-01` | `[~]` | `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md:28` | docs-open | Architecture docs; không đụng code |
| `DOC-SYNC-02` | `[~]` | `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md:54` | docs-open | Docs lane; phải đếm mtime trước khi vá |
| `DOC-SYNC-03` | `[~]` | `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md:76` | decision-gated | Docs + chủ sản phẩm (scope decision); blocker: docs + Product scope 28/31 decision |
| `CODE-FIX-01` | `[~]` | `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md:94` | implementation-open | Orchestrator + Admin UX; P6-admin |
| `CODE-FIX-02` | `[~]` | `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md:127` | docs-open | Connector + P3 |

### `tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md` - 3 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `INGEST-WIRE-01` | `[~]` | `tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:7` | implementation-open | ingest/ocr và ingest/digitize gửi nội dung ảnh/file thật qua artifact reference được Connector cấp quyền hoặc protocol... |
| `RESULT-WIRE-01` | `[~]` | `tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:8` | decision-gated | Chốt GET /operations/:id/result trả business data inline hay {resultRef}/artifact metadata, GET /artifacts/:id/download trả...; blocker: Product/API architect/consumer wire decision |
| `ARCH-DOC-01` | `[~]` | `tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:9` | docs-open | Cập nhật architecture/02 và architecture/09 theo trạng thái hiện tại: native parse/split so với Connector OCR/vision, đường... |

### `tasks/CLAUDE-REVIEW-TEMPLATE.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` - 14 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `CONV-00` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:43` | implementation-open + stale-suspected | Baseline và guard file lớn; receipt: `codex-conv00-file-size-guard-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `CONV-01` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:49` | implementation-open | Tách query và projection khỏi server.ts |
| `CONV-02` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:55` | implementation-open | Tách route families khỏi server.ts |
| `CONV-03` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:61` | implementation-open | Composition root của Orchestrator |
| `CONV-04` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:67` | implementation-open | Shared application crypto, xử lý CONV-D01 |
| `CONV-05` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:73` | implementation-open + stale-suspected | Admin fetcher, xử lý CONV-D02; receipt: `qwen-conv05-admin-fetcher-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `CONV-06` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:79` | implementation-open + stale-suspected | Bounded fanout dùng chung, xử lý CONV-D04; receipt: `codex-conv06-impl-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `CONV-07` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:85` | implementation-open | Chia runtime.test.ts theo domain |
| `CONV-08` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:91` | implementation-open + stale-suspected | Chia admin-shell-render.test.ts theo pane; receipt: `qwen-conv08-render-split-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `CONV-09` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:97` | implementation-open | Tách harness của multi-container E2E |
| `CONV-10` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:103` | implementation-open + stale-suspected | Chia Admin operations pagination tests; receipt: `tester-conv10-operations-pagination-split-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `CONV-11` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:109` | docs-open | Non-code file disposition |
| `CONV-12` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:114` | implementation-open + stale-suspected | Admin shell router cận ngưỡng; receipt: `qwen-conv12-shell-router-split-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `CONV-13` | `unmarked / SPECIFIED` | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:120` | implementation-open | Một projection audit, xử lý CONV-D03 |

### `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md` - 5 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `CRX-01` | `IMPLEMENTATION OPEN` | `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md:9` | implementation-open | P0 — metadata writer còn plaintext |
| `CRX-02` | `unmarked` | `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md:10` | implementation-open | P0 — S3 read không bật guard |
| `CRX-03` | `unmarked` | `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md:11` | implementation-open + stale-suspected | P0 — worker process vẫn có đường ghi cleartext; receipt: `codex-crx03-worker-seam-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `CRX-04` | `partial / no checkbox` | `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md:12` | decision-gated | P1 — P9-01 gắn nhầm business boundary; blocker: P9 owner + architect/Product choose standalone boundary |
| `CRX-05` | `IMPLEMENTED candidate / no checkbox` | `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md:13` | docs-open + stale-suspected | P2 — mô tả 28 variant đã cũ; blocker: catalog smoke done; docs/fixture closeout pending; receipt: `codex-crx05-recipe-catalog-smoke-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |

### `tasks/CODE-REVIEW-FIXES-2026-10-01.md` - 8 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `RV01-01` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:11` | implementation-open | Bootstrap mã hóa production và fail-closed |
| `RV01-02` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:21` | implementation-open | Seal metadata trước submit và ingestion READY |
| `RV01-03` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:31` | implementation-open | Mã hóa mọi artifact Worker → S3/DB và round-trip manifest |
| `RV01-04` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:41` | implementation-open | Mount sáu core legacy endpoint và workflow facade |
| `RV01-05` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:51` | implementation-open | Một serializer legacy operations/result đúng semantics |
| `RV01-06` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:61` | implementation-open + stale-suspected | Hoàn thiện domain 31 variants và workflow execution; receipt: `codex-crx05-recipe-catalog-smoke-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RV01-07` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:71` | implementation-open | Admin shell production và local-user mode |
| `RV01-08` | `unmarked / SPECIFIED` | `tasks/CODE-REVIEW-FIXES-2026-10-01.md:81` | verification-open | Sửa regression test SDK metadata adapter |

### `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md` - 6 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `CR28-01` | `unmarked` | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md:9` | implementation-open | Nối manifest, pinned object version, Vault key và tenant/artifact AAD vào read path; verify tag/hash trước khi công bố... |
| `CR28-02` | `unmarked` | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md:10` | implementation-open | Dùng một transport có Bearer service token được cấp/rotate đúng scope, hoặc wire @du/connector-client sẵn có vào worker... |
| `CR28-03` | `[~]` | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md:11` | implementation-open | Connector resolve reference theo grant, tenant, kích thước, timeout và pinned version; JSON/multipart adapter đưa nội dung... |
| `CR28-04` | `unmarked` | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md:12` | implementation-open | Seal cả hai cột ở submit và ingestion READY (submission.ts:379, :385), cùng child/join/HITL paths theo inventory; giữ... |
| `CR28-05` | `unmarked` | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md:13` | implementation-open | Copy đủ workspace build inputs và kiểm tra dependency closure; docker build sạch cho cả hai image (không dùng host... |
| `CR28-06` | `unmarked` | `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md:14` | implementation-open | Parse error code có schema/allowlist; chỉ outcome thực sự ambiguous mới INVOCATION_UNKNOWN, không blind retry; mã khác được... |

### `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` - 10 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `DATA-00` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:18` | decision-gated | Chốt contract artifact + deployment options / architecture + contract owner; blocker: contract/owner decision; exact sign-off uncertain |
| `DATA-01` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:19` | infra-gated | S3 storage adapter và metadata lifecycle / Orchestrator; blocker: live/lab namespace, service or deployment evidence |
| `DATA-02` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:20` | infra-gated | Public multipart/direct upload + submit guard / Orchestrator; blocker: live/lab namespace, service or deployment evidence |
| `DATA-03` | `[~]` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:21` | implementation-open |  |
| `DATA-04` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:22` | implementation-open | Worker artifact streaming + output/checkpoint / worker-sdk + business |
| `DATA-05` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:23` | infra-gated | PG blob migration và rollback window / Orchestrator + DBA; blocker: live/lab namespace, service or deployment evidence |
| `LOG-01` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:24` | implementation-open | Log schema/redaction / observability + mỗi service |
| `LOG-02` | `[~]` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:25` | infra-gated | ; blocker: live/lab namespace, service or deployment evidence |
| `DEP-01` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:26` | infra-gated | IaC + topology smoke / infra; blocker: live/lab namespace, service or deployment evidence |
| `DATA-INT-01` | `unmarked` | `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md:27` | infra-gated | Cross-host E2E/fault gate / integration owner; blocker: live/lab namespace, service or deployment evidence |

### `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md` - 5 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `VFY-ENC` | `[ ]` | `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md:9` | verification-open | Boot image thật với S3+Vault; input/upload/URL ingestion → worker artifact → result/download, AES-GCM manifest/AAD... |
| `VFY-COMP` | `[ ]` | `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md:10` | verification-open | Cùng request cũ không thêm header chạy DUGate và rework: sáu core route, 31 variants, operations... |
| `VFY-P9` | `[ ]` | `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md:11` | verification-open | Ba workflow disbursement, lc-checker, doc-compare và schema route: submit → checkpoint/HITL → resume/retry → result/error... |
| `VFY-LOCAL` | `[ ]` | `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md:12` | verification-open | local, oidc, both, invalid config: boot, one-time bootstrap, login, lockout, CSRF, RBAC/tenant, logout... |
| `VFY-REG` | `[ ]` | `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md:13` | verification-open + stale-suspected | Full document-core và Worker SDK suites trên build hiện tại, cancellation/AbortSignal metadata adapter, các targeted...; receipt: `tester-vfy-reg-refresh-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |

### `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` - 6 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P2-03/05/06/07, P4-05/08` | `unmarked` | `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:20` | verification-open | Producer/consumer/public artifact scopes, active-lease checks, atomic finalization/publication, actual SDK wire và bounded... |
| `P2-04/08/09` | `unmarked` | `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:21` | verification-open | Concurrent idempotency/TTL, pinned profile, public result policy, safe webhook, Redis-before-claim recovery, default... |
| `P3-03/05/06/07/08, P4-07` | `unmarked` | `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:22` | verification-open | Durable replay never redispatches cancelled/in-flight work; UNKNOWN preserved; async poll/deadline/shared quota/usage... |
| `P4-06, P5-05..10, P7-05` | `unmarked` | `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:23` | verification-open | Office artifact flows and decompression limits; unreadable source/child result cannot become approved; current-image... |
| `P6-02..07, P7-04` | `unmarked` | `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:24` | verification-open | Live pane data, actual authorized mutation, copy-once lifecycle, full agreed a11y rules and isolated current-run browser... |
| `P1-05, P8-01/04/06/08` | `unmarked` | `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:25` | verification-open | Discovered test inventory, clean image boot, exact security negative cases, independent regression fixtures, all release... |

### `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md` - 5 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `RV01-01 → RV01-02` | `unmarked` | `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md:18` | implementation-open | Giữ owner đang làm boot crypto; giao metadata wiring ngay khi lease server.ts được trả, hoặc cho cùng owner làm tiếp nếu... |
| `RV01-03` | `unmarked` | `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md:19` | implementation-open | Tiếp tục worker artifact crypto và manifest contract song song với boot. |
| `RV01-06 / COMP-04` | `unmarked` | `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md:20` | implementation-open | Giao document-core ba variant còn thiếu và recipe/output thật; tách ba P9 workflow theo business directory nếu file không... |
| `RV01-07 / LOCAL-01/02` | `unmarked` | `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md:21` | implementation-open | Giao DB identity, password/session/auth primitives trong module và migration riêng; coordinator lấy security decision... |
| `RV01-04/05 / COMP-02..07` | `unmarked` | `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md:22` | implementation-open | Giao decoder/serializer/operation projection trong file riêng với fixture đã biết; integrator mount public route sau khi... |

### `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` - 6 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `PAR00-J01` | `unmarked` | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md:32` | decision-gated | GET/POST /admin/login, POST /admin/logout, local user bootstrap/reset/disable và Admin principal/session/RBAC qua...; blocker: Product/architect/consumer sign-off |
| `PAR00-J02` | `unmarked` | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md:33` | decision-gated | Admin read GET /api/v1/admin/api-keys[/<id>] đã có; candidate authenticated issue/copy-once/revoke/disable Admin API/BFF...; blocker: Product/architect/consumer sign-off |
| `PAR00-J03` | `unmarked` | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md:34` | decision-gated | Existing POST /api/v1/admin/profile-bindings và GET /api/v1/admin/profiles/... là seam khởi đầu; cần persisted policy...; blocker: Product/architect/consumer sign-off |
| `PAR00-J04` | `unmarked` | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md:35` | decision-gated | Connector service management GET/POST /connectors, revision create/activate/retire/test và Vault write-only credential...; blocker: Product/architect/consumer sign-off |
| `PAR00-J05` | `unmarked` | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md:36` | decision-gated | Versioned schema catalog/import/validate/publish/resolve schemaSlug qua Admin API hoặc migration/bootstrap có receipt...; blocker: Product/architect/consumer sign-off |
| `PAR00-J06` | `unmarked` | `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md:37` | decision-gated | Admin operations list/detail, audit, health, cancel/resume/deadline action đã có code route; verify browser/UI và một...; blocker: Product/architect/consumer sign-off |

### `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` - 16 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `RFX-01` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:13` | implementation-open | Delivery encryption AES-GCM thiếu AAD (crypto thực sự) |
| `RFX-02` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:23` | implementation-open | policy.suite bị bỏ qua lặng lẽ |
| `RFX-03` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:33` | implementation-open | Public multipart ghi PLAINTEXT thẳng S3, bypass encryption gateway (vi phạm invariant) |
| `RFX-04` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:43` | implementation-open + stale-suspected | originalToken trong gateway claim không phải token gốc; receipt: `codex-rfx-gateway-v2-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RFX-05` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:53` | implementation-open + stale-suspected | Manifest sidecar ghi/verify không pin VersionId; receipt: `codex-rfx-gateway-v2-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RFX-06` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:63` | implementation-open + stale-suspected | Claim mutex chặn retry tới 1 giờ sau crash; receipt: `codex-rfx-gateway-v2-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RFX-07` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:73` | implementation-open | grantPart cho phép overwrite declaration của part đã grant |
| `RFX-08` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:83` | implementation-open | collectStream decrypt không giới hạn kích thước (OOM) |
| `RFX-09` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:93` | implementation-open + stale-suspected | importLegacyBlob race tạo orphan S3 version; receipt: `codex-rfx-storage-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RFX-10` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:103` | implementation-open | Dev fallback tenant/api_key rows chèn vô điều kiện cả khi boot production |
| `RFX-11` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:113` | implementation-open | Grant URL build từ Host header (host-header injection) |
| `RFX-12` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:123` | implementation-open | Worker heartbeat là stub trả về số liệu cố định |
| `RFX-13` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:133` | implementation-open + stale-suspected | storage-migration giữ FOR UPDATE xuyên qua S3 network call; receipt: `codex-rfx-storage-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RFX-14` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:143` | implementation-open + stale-suspected | integrity-scanner withDeadline không cancel tác vụ nền; receipt: `codex-rfx-scanner-2026-10-02.md` (scope needs reconciliation; uncertain) |
| `RFX-15` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:153` | implementation-open | Grant token nằm trong query string của proxy blob URL |
| `RFX-16` | `unmarked / SPECIFIED` | `tasks/ORCH-REVIEW-FIXES-2026-10-02.md:163` | docs-open | Chunk-path unwrap DEK trước MAC-check (Vault-call oracle nhẹ) |

### `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` - 7 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `ORCH-PAR-11` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:29` | decision-gated | API key lifecycle field-level; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `ORCH-PAR-12` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:41` | decision-gated | ProfileEndpoint policy + merge/lock semantics; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `ORCH-PAR-13` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:61` | decision-gated | Per-key per-step prompt override key-4; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `ORCH-PAR-14` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:75` | infra-gated | Connection lifecycle + Vault write-only; blocker: live Vault/Connector deployment evidence |
| `ORCH-PAR-15` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:90` | decision-gated | Settings 17 key → replacement map + diagnostics an toàn; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `ORCH-PAR-16` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:106` | implementation-open | User ↔ key assignment + workflow schema catalog |
| `ORCH-PAR-17` | `[ ]` | `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:121` | docs-open | Ops/analytics/docs + explicit non-parity |

### `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md` - 5 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `PAR-XA-01` | `unmarked / SPECIFIED` | `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md:11` | decision-gated | OpenAPI và docs portal; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `PAR-XA-02` | `unmarked / SPECIFIED` | `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md:21` | decision-gated | Hai loại test và evidence; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `PAR-XA-03` | `unmarked / SPECIFIED` | `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md:30` | decision-gated | Profile locked-field policy một lần duy nhất; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `PAR-XA-04` | `unmarked / SPECIFIED` | `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md:44` | decision-gated | Gate dependency không đổi ngầm; blocker: contract/owner/Product decision (exact sign-off uncertain) |
| `PAR-XA-05` | `unmarked / SPECIFIED` | `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md:52` | decision-gated | Inventory một chiều, không hai route matrix; blocker: contract/owner/Product decision (exact sign-off uncertain) |

### `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` - 11 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `ORCH-PAR-00` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:42` | decision-gated + stale-suspected | Product + architect + docs: inventory Admin/operator journeys, API key/profile/connection/workflow schema đang dùng, phân...; blocker: Product/architect/consumer sign-off; receipt: `qwen-par00-evidence-map-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `ORCH-PAR-01` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:43` | implementation-open | Orchestrator auth + Admin UI: issue/rotate/disable/revoke key, copy-once, gán/thu hồi profile/grants |
| `ORCH-PAR-02` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:44` | implementation-open | Platform profile + Admin UI + document-core consumer: revisioned profile config |
| `ORCH-PAR-03` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:45` | implementation-open | Connector owner + Orchestrator Admin proxy + UI: connection/revision lifecycle |
| `ORCH-PAR-04` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:46` | implementation-open | Workflow owner + Admin API/UI: schema catalog/builder/import/publish |
| `ORCH-PAR-05` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:47` | implementation-open | Local auth owner + Admin UI: user↔API-key assignment/quyền |
| `ORCH-PAR-06` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:48` | implementation-open | Platform/config + Connector/Vault + Admin UI: settings replacement |
| `ORCH-PAR-07` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:49` | implementation-open | Usage/operations + Admin UI: dashboard/history parity |
| `ORCH-PAR-08` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:50` | implementation-open | Runtime + Admin UX: safe operations console |
| `ORCH-PAR-09` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:51` | docs-open | Docs + Admin UI: served versioned API reference |
| `ORCH-PAR-10` | `[ ]` | `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:52` | verification-open | Integration owner + Tester offline/live + Claude Code: end-to-end parity verdict |

### `tasks/P0-business-specs.md` - 2 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P0-01` | `[ ]` | `tasks/P0-business-specs.md:9` | docs-open | Requirements traceability BR-01..12 → UC → test IDs; actor/authorization matrix |
| `P0-03` | `[ ]` | `tasks/P0-business-specs.md:11` | docs-open | Characterization/compatibility matrix từ public handlers cũ |

### `tasks/P1-foundation-contracts.md` - 1 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P1-06` | `[ ]` | `tasks/P1-foundation-contracts.md:14` | implementation-open | Spike queue retry/claim/fencing/yield và Orchestrator server lifecycle |

### `tasks/P2-orchestrator.md` - 3 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P2-02` | `[ ]` | `tasks/P2-orchestrator.md:8` | implementation-open | Auth/key/profile/registry services và handlers |
| `P2-03` | `[ ]` | `tasks/P2-orchestrator.md:9` | implementation-open | Artifact metadata/upload/finalize/access APIs |
| `P2-10` | `[ ]` | `tasks/P2-orchestrator.md:16` | verification-open | Platform vertical slice với stub worker/connector rồi actual components |

### `tasks/P3-connector.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/P4-worker-sdk.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/P5-document-core.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/P6-admin.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/P7-extension-proof.md` - 3 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P7-03` | `[~]` | `tasks/P7-extension-proof.md:13` | infra-gated | Freeze platform digests, provision identity/ACL, register worker; blocker: live/lab namespace, service or deployment evidence |
| `P7-04` | `[~]` | `tasks/P7-extension-proof.md:14` | verification-open | Assign profile bằng generic Admin, submit qua generic API |
| `P7-07` | `[~]` | `tasks/P7-extension-proof.md:17` | docs-open | Extension developer guide và immutable-digest evidence |

### `tasks/P8-release-readiness.md` - 6 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P8-01` | `[ ]` | `tasks/P8-release-readiness.md:21` | verification-open | Real isolated multi-service E2E harness và traceability audit |
| `P8-04` | `[x] + current hold` | `tasks/P8-release-readiness.md:24` | verification-open | Auth/tenant/SSRF/file/schema/secret security suite; blocker: historical [x], newer security/live hold; [x] is historical and current hold remains open |
| `P8-05` | `[ ]` | `tasks/P8-release-readiness.md:25` | infra-gated | Load/burst/soak/fairness benchmark 1→2→4 replicas; blocker: live/lab namespace, service or deployment evidence |
| `P8-06` | `[ ]` | `tasks/P8-release-readiness.md:26` | infra-gated | Compose/prod packaging, health/shutdown/migrations/backup restore; blocker: live/lab namespace, service or deployment evidence |
| `P8-07` | `[ ]` | `tasks/P8-release-readiness.md:27` | verification-open | Dashboards/alerts/runbooks cho queue, outbox, UNKNOWN, storage, credentials |
| `P8-08` | `[ ]` | `tasks/P8-release-readiness.md:28` | verification-open | Release readiness report, remaining risks và consumer compatibility |

### `tasks/P9-business-backlog.md` - 5 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `P9-01` | `[ ]` | `tasks/P9-business-backlog.md:18` | implementation-open + stale-suspected | disbursement workflow; receipt: `codex-p9-01-disbursement-handler-registration-2026-10-01.md` (receipt scope needs reconciliation; uncertain) |
| `P9-02` | `[ ]` | `tasks/P9-business-backlog.md:19` | implementation-open + stale-suspected | lc-checker workflow; receipt: `qwen-p9-02-lc-checker-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `P9-03` | `[ ]` | `tasks/P9-business-backlog.md:20` | implementation-open + stale-suspected | advanced document comparison workflow; receipt: `tester-p9-03-verify-2026-10-02.md` (receipt scope needs reconciliation; uncertain) |
| `P9-04` | `[ ]` | `tasks/P9-business-backlog.md:21` | decision-gated | schema workflow builder |
| `P9-05` | `[ ]` | `tasks/P9-business-backlog.md:22` | implementation-open | legacy workflow facade and billing |

### `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md` - 13 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `MM-01` | `High / BLOCKED SDK portion` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:11` | implementation-open | Shipped worker authenticates to production Connector verifier; missing/wrong identity denied; no verifier-disabled... |
| `MM-02` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:12` | implementation-open | API-key-only upload → top-level artifact roles/output normalization → process → result/download; CR-12/13 closed |
| `MM-03` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:13` | implementation-open | Profile v1 survives v2 activation; defaults/locks/prompts/limits resolved and immutable, actual schema digest; invalid... |
| `MM-04` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:14` | implementation-open | Public-only HITL discovery/resume, durable progress, state filtering and complete stable pagination |
| `MM-05` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:15` | implementation-open | Redis loss before claim reconstructs READY job; deadline/wait expiry scheduled; persisted worker health; no duplicate effects |
| `MM-06` | `High / TODO; SDK subtask held` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:16` | implementation-open | Provider 202 → polling → final result across restart; no repeated inference; pending does not exhaust attempt budget (CR-07) |
| `MM-07` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:17` | implementation-open | Concurrent and CANCELLED same-ID replay never redispatch; durable ledger test includes quota lease expiry |
| `MM-08` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:18` | implementation-open | Shared-account cap across tenants/revisions; reservations; long-call lease renewal; remaining deadline bounds timeout |
| `MM-09` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:19` | implementation-open | Inspect actual running digests before/after extension registration; provision real identities; deny access to another... |
| `MM-10` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:20` | implementation-open | Rendered profile edit/publish user flow; production fault injection, same-epoch cancellation, Redis/storage recovery; retain... |
| `MM-11` | `Medium / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:21` | implementation-open | Producer/schema tenantId decision; real responses validate; actual spec examples validated; fresh-checkout portable command |
| `MM-12` | `High / TODO` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:22` | implementation-open | Standard start/container starts listener; clean environment deployment; health/shutdown/migrations/restore verified |
| `MM-13` | `Medium / PARTIAL (closure disputed)` | `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md:23` | implementation-open | Agent delivered automatic DB selection/guards and concurrent PASS logs. Random Redis DB collisions and unused consumer... |

### `tasks/README.md` - 0 open rows/blocks

No direct open task row identified. Historical references, template examples, and [x] rows are excluded; cross-plan acceptance holds may still apply (uncertain).

### `tasks/REVIEW-FIXES-2026-09-23.md` - 12 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `FIX-CR-13` | `IN PROGRESS (platform report; no closure receipt)` | `tasks/REVIEW-FIXES-2026-09-23.md:9` | implementation-open | Binary artifact wire contract; remove decoding shim from integration |
| `FIX-CR-01` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:10` | implementation-open | Webhook destination/redirect/IP policy |
| `FIX-CR-02` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:11` | implementation-open | Bounded webhook dispatch, durable claim and shutdown tracking |
| `FIX-CR-03` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:12` | implementation-open | Atomic first-use idempotency contention |
| `FIX-CR-04` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:13` | implementation-open | Atomic idempotency TTL replacement |
| `FIX-CR-05` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:14` | implementation-open | Resolve existing replay before mutable admission |
| `FIX-CR-06` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:15` | implementation-open | Active lease fencing across runtime mutations and claim replay |
| `FIX-CR-07` | `BLOCKED` | `tasks/REVIEW-FIXES-2026-09-23.md:16` | implementation-open | Provider PENDING continuation separate from failure attempts |
| `FIX-CR-08` | `BLOCKED` | `tasks/REVIEW-FIXES-2026-09-23.md:17` | implementation-open | Timeout/abort through complete response consumption |
| `FIX-CR-09` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:18` | implementation-open | Bounded, correctly classified Connector readiness probe |
| `FIX-CR-10` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:19` | implementation-open | Exact usage aggregation and wire-range enforcement |
| `FIX-CR-12` | `TODO` | `tasks/REVIEW-FIXES-2026-09-23.md:21` | implementation-open | Complete existing artifact grant/integrity work |

### `tasks/REVIEW-FIXES-2026-09-24.md` - 2 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `R24-01` | `High / SOURCE FIXED, offline verified; DB-backed gate pending` | `tasks/REVIEW-FIXES-2026-09-24.md:7` | verification-open | Foreign active/terminal IDs return prompt 404 without polling; authorized poll completes; exact-build DB-backed regression... |
| `R24-02` | `Medium / SOURCE FIXED, integration verification pending; FIX-CR-13` | `tasks/REVIEW-FIXES-2026-09-24.md:8` | verification-open | Full current-build suite exit 0 and native parsing/checkpoint replay without blob rewriting; P5-10 remains partial until its... |

### `tasks/SEC-OIDC-VAULT-2026-09-24.md` - 16 open rows/blocks

| ID | Source marker/status | File:line | Category | One-line description / blocker / receipt |
| --- | --- | --- | --- | --- |
| `SEC-00` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:15` | decision-gated | —; blocker: Product + security + architecture decision |
| `ADM-BASE-01` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:16` | implementation-open | — |
| `ADM-BASE-02` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:17` | implementation-open | Plumbing: ADM-BASE-01; secure enable/closeout: OIDC-03 |
| `ADM-BASE-03` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:18` | implementation-open | — |
| `OIDC-01` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:19` | implementation-open | SEC-00 |
| `OIDC-02` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:20` | implementation-open | OIDC-01 |
| `OIDC-03` | `[~]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:21` | implementation-open | OIDC-02; role×action×tenant matrix từ SEC-00 |
| `OIDC-04` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:22` | implementation-open | OIDC-03, ADM-BASE-01 |
| `VAULT-01` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:23` | implementation-open | SEC-00 |
| `VAULT-02` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:24` | infra-gated | VAULT-01; blocker: live/lab namespace, service or deployment evidence |
| `VAULT-03` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:25` | implementation-open | VAULT-01, VAULT-02, OIDC-03, ADM-BASE-03 |
| `VAULT-04` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:26` | implementation-open | VAULT-03, ADM-BASE-02 |
| `VAULT-05` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:27` | implementation-open | Implement/unit: VAULT-01/02; integration closeout: VAULT-03 |
| `VAULT-06` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:28` | implementation-open | VAULT-03, VAULT-05 |
| `SEC-INT-01` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:29` | verification-open | OIDC-04, VAULT-04, VAULT-05, VAULT-06, ADM-BASE-01..03; fixtures từ OIDC-01/VAULT-02 |
| `SEC-INT-02` | `[ ]` | `tasks/SEC-OIDC-VAULT-2026-09-24.md:30` | infra-gated | SEC-INT-01 để đóng gate; chuẩn bị deploy/runbooks từ M1; blocker: live/lab namespace, service or deployment evidence |

## Counts

| Plan scanned | Open rows/blocks |
| --- | ---: |
| `tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` | 11 |
| `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md` | 7 |
| `tasks/ADMIN-OPS-UX-2026-09-24.md` | 8 |
| `tasks/AGENT-TASK-TEMPLATE.md` | 0 |
| `tasks/API-COMPAT-DUGATE-2026-09-28.md` | 24 |
| `tasks/APP-ENCRYPTION-2026-09-27.md` | 12 |
| `tasks/ARCHITECTURE-DOC-CODE-MISMATCH-2026-10-02.md` | 5 |
| `tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md` | 3 |
| `tasks/CLAUDE-REVIEW-TEMPLATE.md` | 0 |
| `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` | 14 |
| `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md` | 5 |
| `tasks/CODE-REVIEW-FIXES-2026-10-01.md` | 8 |
| `tasks/CODE-REVIEW-FOLLOWUP-2026-09-28.md` | 6 |
| `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` | 10 |
| `tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md` | 5 |
| `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` | 6 |
| `tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md` | 5 |
| `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` | 6 |
| `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` | 16 |
| `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md` | 7 |
| `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md` | 5 |
| `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` | 11 |
| `tasks/P0-business-specs.md` | 2 |
| `tasks/P1-foundation-contracts.md` | 1 |
| `tasks/P2-orchestrator.md` | 3 |
| `tasks/P3-connector.md` | 0 |
| `tasks/P4-worker-sdk.md` | 0 |
| `tasks/P5-document-core.md` | 0 |
| `tasks/P6-admin.md` | 0 |
| `tasks/P7-extension-proof.md` | 3 |
| `tasks/P8-release-readiness.md` | 6 |
| `tasks/P9-business-backlog.md` | 5 |
| `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md` | 13 |
| `tasks/README.md` | 0 |
| `tasks/REVIEW-FIXES-2026-09-23.md` | 12 |
| `tasks/REVIEW-FIXES-2026-09-24.md` | 2 |
| `tasks/SEC-OIDC-VAULT-2026-09-24.md` | 16 |
| **Total (37 files)** | **237** |

| Primary category | Rows/blocks |
| --- | ---: |
| `implementation-open` | 149 |
| `verification-open` | 29 |
| `docs-open` | 19 |
| `decision-gated` | 27 |
| `infra-gated` | 13 |
| **Primary total** | **237** |
| `stale-suspected` (overlapping flag, excluded from primary total) | 27 |

Closure requires the current diff, raw test evidence, and independent reviewer approval under `AGENTS.md`.
