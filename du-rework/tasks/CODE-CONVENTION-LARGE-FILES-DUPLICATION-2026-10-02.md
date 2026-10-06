# Review convention, file lớn và logic lặp — 2026-10-02

**Trạng thái:** `SPECIFIED`, chưa dispatch/chưa sửa production source. Khảo sát working tree tại `adec19e`; `server.ts`, `shell-router.ts` và `tasks/README.md` đang có thay đổi chưa commit từ trước. Đếm lại trước khi claim lease vì file đang được sửa song song. Không đánh dấu `IMPLEMENTED`/`VERIFIED`/`ACCEPTED` từ khảo sát tĩnh. **S6/S7 2026-10-03:** số dòng trong bảng `:18` (vd `server.ts` 4.299) và guard `PLAN_BASELINE_COUNTS` (`tools/file-size-guard.cjs`) là snapshot `adec19e`, đã stale giữa CONV wave (`server.ts` đang split dở, `runtime.test.ts` đã split xong 1785 + 8 file mới) — KHÔNG đổi số baseline hay guard khi wave chưa chốt; đo lại và re-baseline một lần sau khi CONV wave đóng.

## Quy ước phải giữ khi refactor

- `du-rework/AGENTS.md`: task ID, owner và write lease không giao nhau; đồng bộ spec → code → consumer → receipt; review độc lập trước khi accept. Mỗi task dưới đây là packet đề xuất, không tự dispatch hoặc đổi release gate.
- `docs/03-project-structure.md`: TypeScript strict, `noUncheckedIndexedAccess`; Orchestrator không import Business source, Worker SDK không import Orchestrator, shared code đi qua package có public export. Rework hiện dùng `node:http` và raw `pg`; không áp nguyên convention Next.js/Drizzle của repo DUGate cũ lên mã rework.
- Refactor giữ nguyên HTTP wire/status/header, SQL predicate/cursor, RBAC/CSRF/tenant fence, transaction/audit/idempotency, ciphertext/AAD và thứ tự side effect. Đổi hành vi phải đi task chức năng riêng, không lẫn vào packet tách file.
- Ngưỡng 2.000 dòng là **tín hiệu review**, không phải lý do tự động chia theo số dòng. Mục tiêu là ranh giới trách nhiệm, harness độc lập và một nguồn logic; không tạo facade chỉ chuyển tiếp làm phình import graph.

## Cách đo và hiện trạng

Đếm dòng vật lý UTF-8 trên working tree; đối chiếu riêng `git ls-files du-rework` cho tracked files. Bỏ `node_modules`, `dist`, `build`, `coverage`, `.cache`, `__pycache__`; source/test tính `.ts/.tsx/.js/.jsx/.py/.sql/.ps1/.sh/.cjs/.mjs/.mts/.cts/.go/.rs`. Có **827 file mã** trong working tree (gồm untracked đang hiện diện), **5 file mã >2.000 dòng**. Trên **1.002 tracked text/config files** (`.md/.json/.yaml` cộng mã) có **20 file >2.000**. Số dòng gồm comment/blank và không phải chỉ số complexity. Quét TypeScript AST trong 283 `src` files: 3.557 function-like nodes; nhóm `EXACT` là thân hàm bỏ comment/whitespace trùng byte, tên giống nhau đơn thuần không đủ kết luận duplication.

| Loại | File hiện tại | Dòng | Điểm cần tách |
|---|---|---:|---|
| Production | `services/orchestrator/src/server.ts` | 4.299 | `createApp`, `route(ctx)`, auth, pagination/SQL, projection cùng file; shared writer cao |
| Integration test | `services/orchestrator/tests/runtime.test.ts` | 3.869 | global PG/Redis bootstrap + 8 suite runtime/registry/auth/recovery/webhook/facade/health |
| UI unit test | `services/orchestrator/tests/admin-shell-render.test.ts` | 2.815 | một `describe` chứa shell + P6-02..07 renderer/fetcher |
| Live E2E | `businesses/document-core/tests/multi-container-e2e.integration.test.ts` | 2.261 | một shared process harness và 13 scenario; các scenario chia sẻ trạng thái |
| Admin test | `services/orchestrator/tests/admin-operations-list-pagination.test.ts` | 2.031 | parser, catalog/UI, SQL/keyset, sort, negative bounds cùng file |
| Cận ngưỡng | `services/orchestrator/src/app/admin/shell-router.ts` | 1.916 | auth/session/OIDC, section fetch, mutations, crypto config cùng router; theo dõi trước khi vượt 2.000 |

**Các file >2.000 không phải hand-authored code:** `coordination/reports/tester.md` 12.419; `antigravity-6.md` 10.382; `qwen-admin.md` 6.614; `coordinator-antigravity.md` 5.872; `qwen-platform.md` 5.773; `qwen-docs.md` 4.733; `openclaude.md` 3.049; `qwen3.md` 2.902; `command-code.md` 2.207; `coordination/WAVE-39-ORCHESTRATOR-REALLOCATION.md` 3.785; `coordination/agent-watch-state.json` 5.834; `pnpm-lock.yaml` 4.054; `tests/login/package-lock.json` 3.849; `docs/21-openapi.json` 2.159; `docs/28-test-inventory.md` 2.093. Lock/OpenAPI là generated; không cắt thủ công. Reports là receipt/history; không viết lại hoặc làm mất anchor để đạt ngưỡng. State JSON và docs inventory cần owner riêng nếu compact/index.

## Bằng chứng logic lặp đáng xử lý

| ID | Vị trí và bằng chứng | Quyết định ban đầu |
|---|---|---|
| `CONV-D01` | `packages/worker-sdk/src/crypto-storage.ts` ↔ `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`: ít nhất 20 thân hàm trùng sau bỏ comment/whitespace, gồm `validateManifest`, `encrypt/decrypt`, stream/chunk/AAD. Worker SDK ghi rõ đây là faithful port và không được import Orchestrator. | Kiểm tra API/key-provider boundary và golden ciphertext trước khi chọn package crypto thuần dùng chung; không import chéo hoặc sửa wire khi dedupe. |
| `CONV-D02` | `src/app/admin/{api-key,business,connector,profile,operation,overview}-section-data.ts`: `readErrorBody`/`sanitiseErrorBody` cùng thân ở ít nhất 5 fetcher; `parseFetchPayload`/`buildOkFromCatalog` cùng pattern nhưng **chưa chứng minh** semantics giống nhau. | Trích helper sanitize nhỏ, giữ discriminated result và timeout/status mapping từng fetcher; chỉ tổng quát hóa payload parser nếu matrix thật sự giống. |
| `CONV-D03` | `modules/audit/audit.ts:toWire` ↔ `server.ts:toAuditWire`: thân projection giống hệt; `server.ts` ghi chú “Mirrors audit.ts”. | Một mapper/DTO owner, dùng từ service/API không kéo `server.ts` vào service. |
| `CONV-D04` | `businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts` ↔ `businesses/lc-checker/src/fanout.ts`: `resolveConcurrency`, `toFailure`, worker loop giống hệt; business package không được import chéo. | Đánh giá đưa thuật toán bounded fanout thuần vào Worker SDK nếu contract `ChildTaskSpec/Outcome` phù hợp; giữ business-specific ceiling/diagnostics. |
| `CONV-D05` | `packages/worker-sdk/src/{artifact-streams,source-acquisition,source-ingestion}.ts` và `modules/webhooks/webhooks.ts`: `errorClassName` giống thân; `operation-section-data.ts` ↔ `operation-view-models.ts` có `formatSize`/replay label giống. | Chỉ trích helper theo package/UX ownership, không tạo global utils cho hàm 2–3 dòng khi phụ thuộc hoặc taxonomy khác. |

`isRecord`, `run`, `get`, `validateInput` lặp tên ở nhiều module **không** tự động là bug. `document-core/src/actions/*` có 6 method cùng tên vì thực hiện action interface; agent phải chứng minh thân/hành vi lặp trước khi đề xuất hợp nhất.

## Task packets có thể giao trực tiếp

Mọi packet: đọc `AGENTS.md`, `docs/03-project-structure.md`, `tasks/AGENT-TASK-TEMPLATE.md` và spec/contract được nêu; ghi trước/ sau bằng số dòng, exported symbols, import graph, consumer list; không tự thêm feature. Khi implement, owner chạy typecheck/lint và focused tests tương ứng, ghi cwd/lệnh/exit/receipt; Tester độc lập làm `VFY-*` nếu task ảnh hưởng live/wire. Người lập plan chưa chạy tests.

### `CONV-00` — Baseline và guard file lớn

- **Owner/lease:** integration/tooling owner; ghi vào `tools/` và CI config sau khi thống nhất với integration owner. Read-only mọi production source/test.
- **Làm:** script deterministic đếm tracked hand-authored code, báo `>2.000` và cảnh báo `>=1.500`; bỏ generated/history theo allowlist có giải thích. Baseline 5 file trên; report path+dòng+nhóm, exit nonzero chỉ khi file mới vượt 2.000 hoặc file đã refactor tăng lại qua ngưỡng. Không chặn toàn repo từ nợ cũ khi chưa tách.
- **Acceptance:** chạy cùng tree cho kết quả 5 file khớp bảng; không đếm lock/OpenAPI/reports; Windows/Linux line endings không đổi kết quả; CI không tự viết mã/format files. Review lại danh sách sau các packet bên dưới.

### `CONV-01` — Tách query và projection khỏi `server.ts`

- **Owner/lease:** Platform owner, **độc quyền `src/server.ts`**; tuần tự trước `CONV-02/03`. Allowed: `services/orchestrator/src/server.ts`, module mới trong `src/modules/operations/`, `src/modules/admin-read/` hoặc `src/http/`; tests liên quan chỉ theo lease riêng. Read-only `modules/audit/audit.ts`, Admin renderer, contracts.
- **Entry → state → output:** `GET /api/v1/operations`, Admin businesses/audit/api-keys pages → auth/tenant fence → bound SQL/keyset → wire DTO. Chuyển nhóm `parseOperationsListQuery`/sort/cursor/`listOperationsPage`; nhóm `parseAdminAuditListQuery`/`parseApiKeyListQuery`/`sortableAdminKeysetPage`/mappers sang module theo owner, giữ public re-export từ `server.ts` nơi consumer đang import.
- **Acceptance:** các query SQL, bind order, cursor forward/backward, NULL ordering, count và status/header byte-compatible; một nguồn mapper audit (`CONV-D03`) nếu audit owner lease đã cấp, không tách cùng lúc khi chưa có lease; không có circular import; `server.ts` giảm ít nhất ~1.000 dòng và package typecheck pass. Focused test: operations pagination/sort/audit/key list hiện có; live EXPLAIN gate riêng không được suy ra từ unit pass.

### `CONV-02` — Tách route families khỏi `server.ts`

- **Prereq:** `CONV-01`; không chạy song song trên `server.ts`. **Owner:** Platform HTTP owner. Allowed: `src/server.ts`, `src/http/routes/{runtime,public,admin}*.ts` và `src/http/route-context.ts`; read-only service modules/contracts trừ khi issue riêng được mở.
- **Làm:** giữ `route(ctx)` làm dispatcher mỏng; tách block theo audience bắt đầu từ runtime task/artifact, tiếp public operation/artifact, sau đó Admin actions/read/crypto. Context chung có interface typed; tránh chuyển business logic vào HTTP handler. Freeze regex method/path precedence và error translation trước mỗi move.
- **Acceptance:** toàn bộ route inventory trước/sau đối chiếu method/path/auth/status/body/header, unknown path và 405; không nới `assertTaskRuntimeAuth`, RBAC/CSRF hoặc tenant fence; `server.ts` dưới 2.000 dòng sau `CONV-01..02`; route matrix + focused HTTP tests pass. Mỗi family là commit/receipt riêng để bisect, cùng một writer tuần tự.

### `CONV-03` — Composition root của Orchestrator

- **Prereq:** `CONV-02`; không có writer khác ở `server.ts`. **Owner/lease:** Platform boot owner; allowed `server.ts`, `src/app/bootstrap/*` và focused boot/mount tests; read-only Admin shell router, service modules và contracts.
- **Làm:** chuyển `createApp` assembly/lifecycle ra composition helpers mà vẫn giữ một startup/shutdown owner. Giữ các dependency seam injectable, không chuyển tenant/auth decision sang bootstrap.
- **Acceptance:** startup failure cleanup, Admin shell remount, background dispatcher timers, shutdown order, crypto wiring và injection giữ nguyên; `server.ts` vẫn dưới 2.000 dòng sau extraction; không có import cycle. Focused mount/boot tests + typecheck; browser/live acceptance riêng.

### `CONV-04` — Shared application crypto, xử lý `CONV-D01`

- **Owner/lease:** Crypto/Contracts integration owner chốt public API; Worker SDK owner và Orchestrator Encryption owner sửa **tuần tự hoặc disjoint paths**. Allowed sau quyết định: package thuần mới dưới `packages/`, hai facade crypto và package manifests; read-only Vault implementation/storage adapters cho tới khi interface freeze.
- **Quyết định bắt buộc:** so sánh exported types, error taxonomy, wrapped-DEK provider shapes và wire fixtures; chọn (A) shared package crypto không phụ thuộc Orchestrator/Worker, adapters giữ key provider tại từng owner, hoặc (B) giữ port có chủ ý và thêm automated equality/golden guard nếu packaging tạo dependency/rollout risk. Không mặc định A chỉ vì AST giống.
- **Acceptance:** cùng nonce/AAD/HKDF/MAC/manifest/errors, single-shot và stream ciphertext cross-read hai chiều, tamper/size/abort cases; byte fixtures trước/sau không đổi; không import ngược; typecheck cả packages và focused crypto suites. `VFY-CRYPTO-CONV` độc lập trước khi gọi verified.

### `CONV-05` — Admin fetcher, xử lý `CONV-D02`

- **Owner/lease:** Admin data owner; allowed `app/admin/*-section-data.ts` và helper mới trong `app/admin/`; read-only audit module, `server.ts`, renderers/contracts.
- **Làm:** trích sanitization của upstream error body thành helper có giới hạn 256 ký tự; kiểm tra từng fetcher 401/403/404/timeout/invalid JSON trước khi trích parser.
- **Acceptance:** giữ nguyên discriminated result và text an toàn, không echo upstream secret; bỏ exact-body duplicate đã xác nhận; focused Admin fetcher tests + typecheck.

### `CONV-06` — Bounded fanout dùng chung, xử lý `CONV-D04`

- **Owner/lease:** Worker SDK owner thiết kế primitive; Document-core và LC-checker business owners sửa adapter theo disjoint paths sau API freeze. Không import Business↔Business.
- **Làm:** xác nhận hai `ChildTaskSpec/Outcome` và max ceiling; đưa thuật toán queue-index worker, ordered outcomes và failure mapping vào shared primitive nếu hợp đồng chung; business file chỉ giữ policy và nhãn lỗi khác biệt.
- **Acceptance:** concurrency không vượt cap, output giữ thứ tự, một child fail không hủy siblings, empty input/fraction/NaN giữ semantics; existing P9-01/P9-02 fanout tests của cả hai business pass; nếu shape khác, ghi exception có bằng chứng thay vì ép generic.

### `CONV-07` — Chia `runtime.test.ts` theo domain

- **Owner/lease:** Orchestrator QA owner; allowed `tests/runtime.test.ts`, `tests/runtime-*.test.ts`, `tests/helpers/runtime-harness.ts`; read-only production. **Prereq:** `CONV-01/02` ổn định route imports để tránh hai writer test/source chồng lấn.
- **Làm:** invent shared state/ordering của 8 `describe` trước khi move; biến top-level `beforeAll/afterAll` và `app/baseUrl/queueName` thành fixture explicit có namespace PG/Redis riêng per suite hoặc giữ những case phụ thuộc cùng fixture trong một file. Tách tối thiểu registry/auth, recovery, webhook, facade/HITL, health; không copy `scopedCleanup` hay dùng shared mutable singleton giữa test files.
- **Acceptance:** mỗi file hand-authored <2.000 dòng; test IDs/assertion count và skip guard `DU_LIVE_INFRA` không đổi; cleanup chỉ xóa namespace của suite; không tăng port/DB collision khi test song song; focused live suite receipt ghi namespace và teardown. Không chạy live trên shared DB thiếu lease.

### `CONV-08` — Chia `admin-shell-render.test.ts` theo pane

- **Owner/lease:** Admin UI QA owner; allowed file test hiện tại, `tests/admin-{shell,business,profile,connector,api-key,operation,overview}-render.test.ts`, helper fixture trong `tests/helpers/`; read-only renderers.
- **Làm:** chuyển các nested `describe` P6-01..07 vào file tương ứng; chỉ trích fixture builders có thực sự dùng chung, không biến snapshot thành một helper tự assert. Giữ escaping/role/unauthorized/fetch failure assertions ở từng pane.
- **Acceptance:** không file >2.000; số case và assertion chủ đạo trước/sau không giảm; mỗi file chạy độc lập, không phụ thuộc thứ tự Jest; focused renderer suites + typecheck pass.

### `CONV-09` — Tách harness của multi-container E2E

- **Owner/lease:** Document-core E2E owner; allowed `multi-container-e2e.integration.test.ts`, `tests/helpers/multi-container-harness.ts` và fixture types; read-only production/Connector schema. **Không** chia 13 scenario thành các process độc lập ngay vì cùng `primaryOperationId`, provider counters, barrier và scoped teardown.
- **Làm:** chuyển startup/teardown, tracked resources, credential/grant factories và barrier controls vào một harness object explicit; suite giữ sequence và gọi object, không global singleton. Khi harness sạch mới cân nhắc nhóm scenario độc lập với namespace riêng.
- **Acceptance:** file test chính <2.000, helper có một owner lifecycle; `afterEach/afterAll` vẫn dọn child processes/servers/workers kể cả startup fail; 13 scenario, pinning/429/SIGKILL assertions và zero-duplicate-provider-call không đổi; live test chạy trong namespace/lease riêng, ghi receipt.

### `CONV-10` — Chia Admin operations pagination tests

- **Owner/lease:** Admin/Platform QA owner; allowed `admin-operations-list-pagination.test.ts`, `tests/admin-operations-{query,view,sql,sort}.test.ts`, `tests/helpers/operations-page-fixture.ts`; read-only production.
- **Làm:** tách parser/catalog/toolbar, SQL tenant fence/cursor, sort matrix và negative bounds theo top-level `describe`; helper fake DB/fetch giữ query/params observable, không thay SQL assertions bằng mock output.
- **Acceptance:** mỗi file <2.000; full/partial page, prev/next, NULL deadline, tie-break, injection/foreign tenant và bad cursor coverage không giảm; mỗi file độc lập và focused suites/typecheck pass.

### `CONV-11` — Non-code file disposition

- **Owner/lease:** docs/coordination owner, không giao cho code refactor owner. Reports và `WAVE-39` là lịch sử append-only: tạo index/summary theo task ID + link, không cắt receipt hoặc đổi anchor. `agent-watch-state.json` chỉ compact sau khi coordinator xác nhận schema/consumer và active attempts; `docs/28-test-inventory.md` có thể chia theo phase với stable redirects/links; lock và generated OpenAPI giữ nguyên generator.
- **Acceptance:** toàn bộ receipt/task ID, link tham chiếu và machine consumer còn truy xuất được; generated files tái tạo được byte-stable hoặc giải thích diff; không đánh đồng ngưỡng tài liệu với code convention.

### `CONV-12` — Admin shell router cận ngưỡng

- **Owner/lease:** Admin UI owner; allowed `src/app/admin/shell-router.ts`, các module mới `src/app/admin/{section,auth,mutation}-dispatch.ts` và focused Admin shell tests; read-only `server.ts`/`shell-server.ts` trừ khi interface change có lease riêng. Có thể chạy song song `CONV-01..03` nếu không có ACUI/P6 writer cùng file.
- **Làm:** tách session/OIDC gate, section fetch orchestration, mutation/CSRF và crypto-config theo trách nhiệm. Giữ public `dispatchShellRequest`/`dispatchShellRequestAsync` signatures và URL matcher precedence cho `shell-server` consumer.
- **Acceptance:** `shell-router.ts` dưới 1.500 dòng sau tách; cookie/CSRF/session revocation, role gate, GET/POST routing, `deferredSectionExtras`, redirect và `no-store` giữ nguyên; không import cycle. Focused session/router/mutation tests + typecheck; browser acceptance riêng.

### `CONV-13` — Một projection audit, xử lý `CONV-D03`

- **Prereq:** `CONV-01` hoặc cùng Platform owner giữ `server.ts` lease tuần tự. **Owner/lease:** Platform audit owner; allowed `modules/audit/audit.ts`, module audit projection mới và `server.ts` mapper; read-only Admin renderer/contracts.
- **Làm:** chuyển thân `toWire`/`toAuditWire` giống hệt thành một hàm export thuộc audit/read module và dùng lại tại service + pagination. Giữ row/DTO types explicit, tránh module audit import HTTP.
- **Acceptance:** audit wire rows trước/sau deep-equal cho Date/string/null, pagination và SQL tenant filtering không đổi; `server.ts` không còn mapper copy; focused audit/read tests + typecheck.

## Thứ tự và handoff

1. `CONV-00` làm baseline. `CONV-04/05/06` có thể chuẩn bị quyết định/interface ở file-disjoint paths; chỉ merge sau consumer matrix và owner freeze.
2. `CONV-01 → CONV-02 → CONV-03` tuần tự trên `server.ts`; `CONV-13` cần chờ lease `server.ts`. `CONV-12` có thể giao Admin UI owner riêng khi không có task ACUI/P6 đang sửa `shell-router.ts`.
3. `CONV-08/10` test-only có thể giao song song khi fixture paths khác nhau. `CONV-07/09` cần inventory isolation/state trước khi tách. `CONV-11` là docs/coordination lane riêng.
4. Mỗi owner handoff: changed paths, symbol/route matrix, trước/sau line count, consumer imports, command+c.w.d.+exit+pass/fail/skip và raw receipt, unresolved behavior difference. Tester/reviewer đối chiếu theo `AGENTS.md`; task ở `[ ]` cho tới khi thật sự implement, không tự tick từ plan.
