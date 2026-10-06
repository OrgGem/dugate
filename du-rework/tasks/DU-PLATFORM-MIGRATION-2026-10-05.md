# DU Platform repo migration — PLAT-MIG-00..08

## Objective / authorization

Người dùng đồng ý kiến trúc DU Platform và yêu cầu migration qua plan/agent (2026-10-05), sau đó chốt tối đa ba loại repo: Orchestrator, Worker và Connector tùy chọn. Đích mặc định: **hai loại repo**, Connector nằm trong repo Orchestrator nhưng chạy bằng service/image riêng. Các business workers là instances của cùng loại repo/template Worker, build/deploy/scale độc lập.

Spec: [docs/40-du-platform-architecture.md](../docs/40-du-platform-architecture.md). Portal chỉ UI/BFF; backend giữ Platform API + Orchestration Runtime cùng process. Tên repo/folder Orchestrator không buộc rename thành App Portal/platform-api. Không tách Runtime service, không gom Connector vào process API.

**Quyết định tên được người dùng xác nhận ngày 2026-10-06:** giao diện quản trị mang tên **Orchestrator Portal**, tương ứng với **Orchestrator Backend**. Nhóm tổng thể vẫn là **DU Platform**; các thành phần khác là **Connector Service** và **Business Workers**. Đưa rename vào packet `PLAT-MIG-08` của plan chung bên dưới, không triển khai qua một plan/editor song song.

Status sau roster/r3 intake 2026-10-06: **PARTIAL progress / acceptance OPEN**. Latest packaged candidate là `candidate-portal-swagger-20261006-r3`, clean no-cache Bake 5/5 exit 0, có Portal branding/OpenAPI viewer offline, a11y fix và compiled `api-docs` route allowlist. Allowlist code/packaging blocker đã xử lý; runtime gated-route verification còn mở. UI harness receipt giữ 31 passed / 1 intentional skipped / 0 failed, 30/30 desktop/mobile records OK; chưa exact r3 image acceptance. Ingest/Extract PASS thuộc snapshot trước. MIG-00 docs sync và MIG-05 scaffold/provenance đã có receipts; standalone fresh install/lockfile/Node24 parity/live pilot, MIG-08C rename, independent review và security acceptance còn mở. Theo user/Coordinator notice, bốn OpenCode oc_1..4 thay các lane Codex cũ và đang nhận CR06-01/03/04/05 như intake dưới đây. Không tick parent từ scoped pass, không takeover coordinator hoặc cấp blanket lease.

## Read first / dependencies hiện có

**Latest CR06 intake — 2026-10-06:** 3/4 packets của đợt OpenCode (CR06-01/03/05) có owner implementation/offline-test receipts; CR06-04 đang hoàn tất test theo Coordinator notice. Đây là tiến độ receipt của đợt bốn packets, không phải 3/4 ACCEPTED hoặc 3/10 findings đã đóng. Independent VFY/review và full acceptance giữ OPEN; chi tiết và remaining red ở section cuối.

- **Claude review intake 2026-10-06:** [CR06-01..10](CODE-REVIEW-FOLLOWUP-2026-10-06.md) là acceptance holds của plan chung, không phải backlog tùy chọn hoặc 10 fixes đã hoàn tất. Giữ nguyên IDs, severity và parents ở follow-up; coordinator reuse owners/leases, không mở duplicate editor. CR06-01/03/07 ảnh hưởng worker migration MIG-05 và canonical/local helper provenance; CR06-02/05 ảnh hưởng Connector production wiring/security MIG-01/02/04; CR06-04 ảnh hưởng Connector↔worker contract MIG-03/05; CR06-06/08/09/10 ảnh hưởng contracts/admission/upload của MIG-03/04 và consumers MIG-05. VFY-06 phải kiểm các affected paths và negative cases trên combined candidate; REVIEW-07 không đóng khi holds liên quan chưa được xử lý và reviewed.
- **UI review evidence còn thiếu:** `ADMINWEB-FILEREF-01` trong CR06 follow-up phải lấy file:line, expected/actual, scope, reproduction/test và reviewer verdict cho settings read-wire/BFF/curl-import. Không tính các claims này là code fixes đã xác minh hoặc cộng vào 10 CR06 findings; UI acceptance còn mở tới khi có bằng chứng và disposition.
- **Latest live E2E evidence:** [LIVE-STACK-DEPLOY-E2E addendum](../coordination/reports/live-stack-deploy-e2e-2026-10-06.md#follow-up-live-extract-window---arch-phase-b-20261006) và consolidated intake bên dưới ghi Ingest/Extract PASS trên `arch-phase-b-20261006`. HANDLER_ERROR/BINDING_DENIED trước đó là kết quả lịch sử, được thay bằng rerun PASS cho hai ca này. PM-M02 full verifier vẫn chưa PASS do host8080 bị unrelated nginx-ui chiếm ở project cũ; không suy Connector publish host port hoặc đóng ingress/firewall gate từ successful E2E.
- AGENTS.md, tasks/README.md, PLAN-COMPLETION-2026-10-04.md, implementation-first overlay, current Task/Dispatch/leases/terminal thật.
- SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md: reuse RPK-00..21; giữ source-redistribution/extraction sau RPK-00 theo sequencing đã chốt. Không tự bỏ gate hoặc coi RPK đã bắt đầu từ plan này.
- DEPLOYMENT-ADAPTER-DESIGN-803 (`task_b8e6af746947`) và receipt ACUI-M06: reuse boot URL-source design, chuyển sang implementation sau contract/lease freeze; không mở design/editor trùng.
- COMP-02/11 giữ external schema/OpenAPI; COMP-10 giữ golden verdict. AWEB/ACUI giữ Portal/BFF; SCALE giữ HA. Một owner cho shared docs/lockfile/Docker/Compose tại một thời điểm.

## Current mismatch / đường đi

| ID | Expected / current review | Owner và test |
|---|---|---|
| PM-M01 | main→config→composition cấp Connector URL/auth; main.ts chưa truyền connectorBaseUrls/connectorManagementHeaders, composition fallback empty | Boot integrator; standalone boot→real management capabilities/list qua mock Connector |
| PM-M02 | Internal APIs chỉ internal ingress; public/admin/runtime cùng listener và Compose publish Connector host port mặc định | Deployment/security; effective config và allowed/denied HTTP matrix |
| PM-M03 | Readiness scoped theo tenant/binding; public handler hiện API-key auth rồi probe ID trong global map | API/profile integrator; foreign/unbound caller bị từ chối trước network |
| PM-M04 | Docs prefix khớp wire; docs/08 ghi /internal/v1 nhưng Connector server dùng root paths | Connector/docs owner; actual router-client contract suite |
| PM-M05 | Worker repo tự đủ; current workspace imports/COPY/shared packages có thể cần siblings | RPK/build owners; inventory/hash và isolated build context |
| PM-M06 | UI được chốt tên Orchestrator Portal; source/docs/build hiện còn tên Admin Portal/Admin Web và `apps/admin-web` | Portal + docs + build owners; rename inventory, build/browser và packaging parity |
| PM-M07 | Swagger UI và tài liệu chính phải phản ánh router/contract cùng deployment snapshot; đã có generator + docs/21 nhưng cần audit coverage, server origins, compatibility và browser viewer | MIG-00 docs + MIG-03 contract + Portal/build owners; Swagger load, route/spec parity và independent validation |

Owner xác minh lại source file:line/hash trước sửa. Reuse fix/receipt đã có; working tree gồm product untracked, HEAD không phải toàn bộ candidate.

## Task packets / dependencies / observable acceptance

| Task | Owner lane do coordinator bind | Change, write scope và acceptance |
|---|---|---|
| [ ] PLAT-MIG-00 | Architecture/docs integrator | Freeze two-repo topology, exact repo/service/template map, export inventory và contract consumers. docs/40 + docs/02/03/09/12b dưới docs lease. Inventory production/tests/scripts/CI/Docker/imports/env/queue names; không rename hàng loạt history. SPECIFIED topology không phải deployed topology |
| [ ] PLAT-MIG-01 | Existing ACUI-M06 boot integrator | main/config/Connector URL-source + signed management identity composition, env example placeholders và boot tests. Reuse design803; partial config fail closed, valid standalone boot có real management list/caps; unknown ID denied; identity expiry/refresh có owner; không log secret hoặc chuyển invocation sang API |
| [ ] PLAT-MIG-02 | Deployment/security + API/profile owner, chia lease riêng | Fence public/admin/runtime/Connector ingress, explicit local/debug publish; tenant/binding fence trước public readiness probe; phân biệt readiness/provider test. Compose/docs và API route/profile changes serialize theo owner. Unauthorized own/foreign/unbound matrix, zero outbound probe khi denied; workers/admin/public vẫn dùng đúng surfaces |
| [ ] PLAT-MIG-03 | Connector/docs integrator + COMP owner | Align Connector root-path contract, auth/audience and Portal→API→Connector management. Giữ public wire/legacy precedence; workflow 503/capability unavailable ghi trung thực. COMP owner regenerate OpenAPI bằng generator, không hand-edit docs/21; contract invoke/get/cancel/manage tests |
| [ ] PLAT-MIG-04 | Repo/build integrator + RPK service owners | Sau RPK-00 và frozen inventory: tạo Orchestrator repo candidate tự đủ, gồm Portal, API/Runtime và Connector, contracts authority/dev bundles/deployment. Build hai service images riêng và UI từ context repo này; migrations/scripts/health/log tooling tự đủ; Connector có config/migration ownership riêng. Không tạo remote/push/cutover từ packet này |
| [ ] PLAT-MIG-05 | RPK worker/tooling owners | Reuse RPK pilot Document Core rồi Example Review/LC Checker và Worker template; local runtime/contracts/document/clients theo pinned provenance. Manifest/lockfile/Docker/tests riêng, không sibling import/COPY/source symlink hoặc fetch latest; scratch template + isolated repo build; preserve custom business logic, six actions, exactVersion/replicas/lease/checkpoint/artifact/security semantics. RPK sequencing giữ nguyên |
| [ ] VFY-PLAT-MIG-06 | Independent Codex Tester(s) | Exact candidate/hash/build; standalone boot→mock Connector management; client→submit→outbox/BullMQ→worker→grant/invoke→checkpoint/complete→result/usage; scopes/tenant/idempotency/hash mismatch/UNKNOWN and affected compatibility goldens; isolated repo builds with siblings absent. Disposable PG/Redis/S3/Vault namespaces nếu dùng, không product-source edit. Failed/skipped/live absent phải ghi rõ |
| [ ] REVIEW-PLAT-MIG-07 | Claude backend reviewer, Antigravity nếu đổi UI | Independent source/contract/build-context/ingress/rollback review sau VFY. APPROVED + applicable evidence trước parent [x]; UI review exact new build nếu cần. update docs/19/28/35 dưới shared-doc lease; rollout/commit cần authorization riêng |
| [ ] PLAT-MIG-08 | Existing Portal/AWEB owner + architecture/docs + build integrator, coordinator chia lease | Đổi tên sản phẩm thành Orchestrator Portal; target folder `apps/orchestrator-portal`; cập nhật UI/docs/package/build/Docker/tooling consumers theo inventory. Không đổi wire `/admin/*`, `/api/v1/admin/*`, auth/session/CSRF hoặc service topology. Acceptance và sequencing trong section dưới; VFY-06/REVIEW-07 kiểm cả rename slice, không mở một UI app mới |

Phase A: MIG-00/01/02/03 theo active leases của plan hiện tại, không chờ RPK release closure để sửa boot/security gap độc lập. Phase B: MIG-04/05 reuse RPK-00..21; theo USER-AUTHORIZED-LIBS-MIGRATION-2026-10-05, được triển khai local isolated candidate khi inventory/consumer/lease của slice đã freeze, không chờ blanket baseline closure. RPK tracking và acceptance gates vẫn giữ; không có concurrent writers hoặc unclassified blanket copy. MIG-06 verify từng slice và final candidate; MIG-07 review acceptance. Repo extraction candidate không phải production deployment.

### PLAT-MIG-08 — Orchestrator Portal naming migration

Nguồn: người dùng xác nhận ngày 2026-10-06 việc dùng tên **Orchestrator Portal** thay **Admin Portal/Admin Web**, yêu cầu triển khai qua plan chung. Status **SPECIFIED**; row giữ `[ ]` cho tới acceptance, không suy code đã đổi từ cập nhật plan.

**Boundary:** Portal là frontend tại `apps/`; Orchestrator Backend sở hữu Platform API + Runtime cùng process và admin shell/BFF. Rename không tạo service Portal mới hoặc tách BFF sang process khác. Các tên `admin` mô tả role, permission và API vẫn hợp lệ; không blanket-replace mọi chuỗi `admin`.

1. **MIG-08A — inventory / freeze (Portal owner, read-only ngoài lease):** lập old→new→consumer→owner matrix cho tên hiển thị, docs, folder `apps/admin-web`, package identity nếu có, workspace filters, imports/aliases, scripts, CI, Docker COPY/build/output paths, generated compatibility Dockerfiles, tests và candidate repo. Chốt package identity/output mapping thực tế trước sửa; không đoán tên package từ tên folder. Không rewrite receipt/history hoặc identifier contract đã pin chỉ để đồng nhất thuật ngữ.
2. **MIG-08B — UI / docs:** tên sản phẩm, navigation/title/accessibility labels và tài liệu hiện hành dùng Orchestrator Portal; backend được gọi Orchestrator Backend khi cần phân biệt với repo. Portal owner giữ UI source; docs owner giữ tài liệu kiến trúc/deployment/UI contract. Cập nhật exact file list theo inventory và lease hiện hành, không concurrent writer với AWEB hay MIG-00.
3. **MIG-08C — folder / packaging:** chuyển source frontend sang `apps/orchestrator-portal`, cập nhật references trong manifest/workspace/build/scripts/CI/Docker/tests đồng bộ qua integration checkpoint. Một build integrator sở hữu root manifest/lockfile/Docker/generator; folder rename phải serialize với Portal source writer. Compatibility Dockerfiles được regenerate bằng script hiện có, không sửa generated copies bằng tay. Package identity rename chỉ theo frozen inventory; không yêu cầu đổi env/flag chỉ vì đổi tên sản phẩm.
4. **Producer/consumer invariants:** browser→Portal/BFF→internal Admin/Public read API→Connector management vẫn hoạt động. Giữ `/admin/*`, `/admin/web`, `/api/v1/admin/*`, `DU_ADMIN_WEB*`, session/OIDC/CSRF/RBAC, public/runtime/Connector contracts và port topology PM-M02. Nếu cần thay identifier contract ngoài naming scope, coordinator mở quyết định/packet riêng trước sửa.
5. **Acceptance / VFY-PLAT-MIG-06:** frontend typecheck/build và relevant existing tests pass; Orchestrator image/candidate build được Portal bundle từ folder mới, generated Dockerfile parity pass; scratch candidate không phụ thuộc folder cũ. Kiểm current production/tooling references tới `apps/admin-web` bằng inventory: không còn dependency active ngoài compatibility alias có lý do/owner. Browser evidence trên exact build xác nhận tên Orchestrator Portal và login/navigation/BFF reads/mutation CSRF hoạt động; regression checks đúng scope, không dùng naming test thay auth verification.
6. **Review / REVIEW-PLAT-MIG-07:** independent tester receipt và UI reviewer verdict trên exact build; backend/build reviewer kiểm packaging và contract invariants. Chỉ ACCEPTED khi đủ gate; mỗi receipt ghi file list/hash, command/cwd, pass/fail/skipped, exit code, raw evidence và limitations.

**Sequencing:** MIG-08A/B có thể triển khai theo lease riêng khi không trùng AWEB. MIG-08C phải freeze/transfer build và folder leases với MIG-04/RPK migration owner; canonical tree và candidate dùng cùng mapping. Nếu MIG-04 đang build candidate, tích hợp rename trước final VFY/REVIEW hoặc refresh candidate có digest mới; không công bố candidate đã rename khi chỉ canonical docs đổi. Antigravity là coordinator hiện hành theo chỉ thị người dùng trong phiên, intake packet vào ledger/Run hiện có và bind named owners; cập nhật plan không tự dispatch hoặc tạo coordinator thứ hai.

## Contracts / invariants

### Node 24 LTS và dependency security baseline

**Scan intake SEC-UI-20261006:** receipt `coordination/reports/orchestrator-ui-security-scan-2026-10-06.md` giữ security gate **OPEN**: High `braces` trong Portal CLI và backend test tooling; hai High advisory `xlsx` ở shared document-kit; existing Orchestrator image có 11 High package/advisory findings trong bundled npm, 0 Critical. Không cộng các counts thành unique CVE hoặc coi đây là final Node24 candidate. Build/dependency owner xử lý cả tooling và runtime image; shared-lib owner xử lý xlsx; auth owner xử lý legacy open redirect; observability owner xử lý failing security-event test. Reuse existing packets/leases, scan lại final lockfiles + exact image digest và rerun affected auth/security tests; không ACCEPTED hoặc tuyên bố High-free từ build pass. Chi tiết paths, reproduction, commands/exit/pass/fail/skipped và phạm vi chưa kiểm chứng nằm trong receipt.

Quyết định người dùng ngày 2026-10-06: chuẩn hóa Node 24 LTS cho Orchestrator Backend/Portal build, Connector Service và tất cả Business Workers/template/candidate. Trạng thái **SPECIFIED**, chưa phải implementation hoặc security acceptance.

- **MIG-04/build integrator:** inventory actual Node versions của local/CI/build/runtime; chọn Node 24 patch được hỗ trợ mới nhất tại thời điểm triển khai và ghi exact version, image variant, digest, ngày kiểm tra. Đồng bộ canonical Docker generator, regenerated Dockerfiles, manifests/engines, Node version files, CI, tooling/package manager và compatible `@types/node`. Không giữ range `>=20` làm baseline; chọn supported-major range phù hợp. Pin image digest nhưng có quy trình refresh patch/digest, không coi pin là thay thế security updates.
- **MIG-05/worker owner:** cập nhật worker template, các worker hiện có và standalone candidates theo cùng baseline; kiểm tra native modules, ABI/musl compatibility nếu dùng Alpine, package-manager support và duplicated local helpers. Source/folder leases riêng; root manifests/lockfile/generated Docker assets do một build integrator sở hữu, serialize với MIG-08 và RPK.
- **Dependency remediation:** inventory direct/transitive dependencies; scan cả production graph, development/build tooling và final container OS/runtime packages. Update tới patched compatible versions, regenerate lockfile bằng package manager đã pin; không dùng force-upgrade hoặc overrides thiếu consumer/conformance verification. Phân loại từng advisory theo package/version/CVE hoặc GHSA, severity, affected scope, fix availability và khả năng reachable; không so sánh chỉ tổng CVE giữa image variants. Không đổi Alpine sang Debian chỉ để giảm số cảnh báo nếu chưa đánh giá tương thích và exposure.
- **VFY-PLAT-MIG-06:** build/typecheck/relevant tests trên Node 24, isolated candidate/worker build, Portal/auth/BFF và Public/Admin/Runtime/Connector contract checks; smoke queue/lease/checkpoint/complete, uploads/artifacts và provider adapter bằng mock để tránh billed calls. Scan final image đúng digest và dependency lockfiles cuối bằng audit + image scanner phù hợp; lưu scanner/version, database timestamp, commands/cwd/exit, raw reports, SBOM và image/lockfile hashes. Phân biệt zero findings với scanner thất bại, database cũ hoặc scope không được scan.
- **Security gate / REVIEW-PLAT-MIG-07:** mục tiêu không còn known unresolved vulnerabilities trong phạm vi dependency/image scans tại thời điểm nghiệm thu. Mọi severity có bản sửa phải được remediate và verify; findings chưa có bản sửa cần thay dependency/image hoặc mitigation có bằng chứng. Nếu vẫn còn finding, ghi OPEN và không tuyên bố vulnerability-free/ACCEPTED theo gate này; bất kỳ ngoại lệ nào phải có user decision riêng, lý do, owner và expiry, không tự ignore/suppress. Scan không bảo đảm không có unknown vulnerabilities.
- **Docs/MIG-00:** đồng bộ prerequisite, deployment/build instructions và patch maintenance policy; receipt ghi phiên bản/digest trước-sau, advisories đã xử lý, findings còn lại và tests. Coordinator intake vào Run chung, bind existing owners theo leases, không tạo writer/coordinator trùng; refresh candidate và rerun affected verification nếu lockfile/image thay đổi sau kiểm chứng. Không production cutover từ cập nhật plan này.

### Bổ sung bắt buộc: Swagger và tài liệu kiến trúc/API/deployment đồng nhất

Nguồn: yêu cầu người dùng ngày 2026-10-06. Trạng thái **SPECIFIED**; đây là mở rộng packets trong plan chung, không tuyên bố Swagger đã được tạo hoặc đổi source từ việc cập nhật plan. Coordinator đưa acceptance dưới đây vào dispatch specs hiện có; không mở generator/editor trùng `PLAT-MIG-03` hoặc UI writer trùng AWEB/MIG-08.

| Packet hiện có | Deliverables bổ sung / write lease |
|---|---|
| PLAT-MIG-00 | Docs owner đồng bộ `docs/02-architecture.md`, `docs/09-system-architecture.md`, `docs/40-du-platform-architecture.md`, `docs/12b-deployment-guide.md`: component/repo/process/image map, deployment diagram, listener/port/network/host publication matrix, env và luồng producer→consumer. Inventory các docs liên quan trước edit, claim exact files |
| PLAT-MIG-03 | Contract/COMP owner đồng bộ `docs/06-public-api.md`, `docs/06b-api-spec-overview.md`, `docs/07-internal-api.md`, `docs/08-connector-api.md`, `docs/20-openapi-descriptions.md`, generator/validator trong `tools/openapi/` và regenerate `docs/21-openapi.json`. Inventory toàn bộ router hiện hành, không chỉ Connector; generated spec không hand-edit |
| PLAT-MIG-03 — Swagger UI slice | Existing Portal/UI owner tạo trang Swagger UI trong Orchestrator Portal, dùng chính generated OpenAPI artifact của MIG-03, có filter/tag theo Public / Admin / Runtime / Connector / Compatibility. Target route `/admin/web/api-docs`, đi qua shell/session và route allowlist hiện có; freeze route flag/packaging với Portal owner trước triển khai. Không mở unauthenticated documentation/proxy endpoint mới |
| PLAT-MIG-04 / PLAT-MIG-08 | Build owner đóng gói Swagger assets + generated spec trong image/candidate cùng Portal; cập nhật folder mapping theo MIG-08, pin dependency nếu thêm Swagger UI package. Root manifest/lockfile/Docker qua một integrator; không phụ thuộc CDN/live download lúc boot |
| VFY-PLAT-MIG-06 / REVIEW-PLAT-MIG-07 | Independent route/spec/deployment parity, OpenAPI validation, browser Swagger evidence và UI/backend review trên cùng candidate digest |

**Mô hình và tài liệu chính:** tên thống nhất DU Platform / Orchestrator Portal / Orchestrator Backend / Connector Service / Business Workers. Diagram thể hiện API + Runtime cùng process, Connector service/image riêng, Public 3000, Internal 3002, Portal 3001, Connector 8080; ingress/default publication theo PM-M02. Mô tả các sequence client submit→DB/outbox/queue→worker→grant/Connector→checkpoint/complete→result/usage và Portal→BFF→admin/backend→Connector management. Có mapping API family→listener→caller→auth→module owner. Không coi queue là REST API hoặc coi cùng repo là cùng process.

**OpenAPI contract bắt buộc:** method/path, unique operationId, tags, request headers/query/body/content types, response schemas/status/error examples, authentication/scope, tenant/business fence, idempotency, async polling/cancel/resume, upload/download và encryption envelopes đúng wire. Chỉ rõ precedence legacy/canonical và auth-dependent envelopes trên paths trùng; không quảng cáo canonical response duy nhất khi API-key caller thực tế nhận legacy envelope. Ghi các handler 409/503/disabled/unavailable trung thực, phân biệt route hiện có với planned/unimplemented. Không generate endpoint giả từ prose.

**Server origins:** sửa tại generator để public/admin/runtime/Connector operations dùng đúng origin/listener của snapshot triển khai; không mặc định toàn spec tới legacy port 2023 hoặc tới Public 3000 cho internal operations. Cho phép deployment cấu hình origins đúng front-door topology. Container DNS URL phục vụ worker/server không đồng nghĩa URL browser truy cập được; default Swagger **Try it out tắt**, không yêu cầu publish 3002/8080 hay tạo generic BFF proxy/CORS wildcard chỉ để thử API. Tài liệu kèm curl mẫu chạy từ caller/network thích hợp với credential placeholders, không chứa token/key thật. Bật Try it out sau này cần packet riêng cho access/CORS/side-effect policy.

**Một nguồn spec:** Swagger UI đọc artifact do `tools/openapi/gen_openapi.py` generate; không duy trì bản JSON/schema thủ công thứ hai. Nếu tách public/internal/Connector views, derive deterministic từ cùng inventory/artifact và kiểm không mất operation. Swagger assets và spec được phục vụ trong Portal theo auth/session policy; spec không chứa secrets. API docs links/navigation dùng tên Orchestrator Portal và tương thích MIG-08.

**Current vs target:** mỗi tài liệu ghi implemented snapshot/build evidence riêng với target SPECIFIED. Chênh lệch source/spec/deployment gắn PM-Mxx/task ID, owner, expected/actual và acceptance còn thiếu; không sửa mô tả để hợp thức hóa bug. Docs đích không chứng minh live deployment. Không ghi count endpoint hay trạng thái acceptance từ receipt cũ mà chưa đối chiếu router hiện tại.

**Acceptance bổ sung:**

1. Route inventory→OpenAPI coverage matrix cho tất cả HTTP surfaces; operation active không thiếu, spec không thêm route không tồn tại, unavailable routes được mô tả đúng. Source file:line và snapshot digest cho mỗi nhóm; kiểm đặc biệt legacy precedence, Runtime grants và Connector scope/grant.
2. Chạy generator + `tools/openapi/validate_openapi.py` bằng runner phù hợp, kiểm OpenAPI bằng structural validator tương thích phiên bản spec; các `$ref`, examples/security schemes/server origins hợp lệ. Regenerate lần hai không thay artifact; CI/build check phát hiện drift, không chỉ kiểm JSON parse được.
3. Browser trên exact Portal build: Swagger render generated spec không lỗi, tags/search/schema/auth descriptions đúng, assets/spec load offline từ image, unauthenticated access obeys Portal policy; Try it out tắt và không gửi credential tới sai origin. Route allowlist behavior, navigation và MIG-08 rename được kiểm cùng build.
4. Effective Compose và listener matrix đối chiếu tài liệu trên combined PM-M02 snapshot; public không expose internal operations, worker/BFF URLs đúng. Representative existing contract tests kiểm Public/Admin/Runtime/Connector/Compatibility request/response/auth; required live cases chưa chạy phải ghi open, không thay bằng docs checks.
5. Handoff receipt ghi changed paths + artifact/build hashes, command/cwd, pass/fail/skipped/exit, raw-output/browser evidence và remaining gaps. UI review độc lập và backend/contract review đạt gate hiện hành trước ACCEPTED; không tick MIG-00/03/parent chỉ vì có Swagger page.

Sequencing: inventory/docs/contract reconciliation theo leases có thể chạy song song; Swagger UI chờ freeze artifact/route consumer contract, final packaging dùng naming mapping MIG-08 và deployment PM-M02. Nếu candidate thay đổi sau verify, cập nhật artifact/docs và verify affected slice trên digest mới. Antigravity intake và chia lease trong Run/ledger chung; yêu cầu này không tạo coordinator hay authorization cho production cutover.

### Bổ sung bắt buộc: shared libs/SDK → một repo, worker ưu tiên API

Nguồn: chỉ thị người dùng tiếp theo ngày 2026-10-05. Không tạo Shared/SDK repo thứ tư. Orchestrator repo sở hữu canonical contracts, server modules và versioned client/runtime/document/egress/observability references, guides/skills. Worker nhận subset source local qua template/skill và pin provenance; skill không thay runtime executable code.

Inventory manifest sơ bộ trong phiên này: Document Core, Example Review và LC Checker đều khai báo contracts + document-kit + worker-sdk; worker-sdk kéo contracts + egress + observability; connector-client kéo contracts; egress kéo contracts; Orchestrator còn import worker-sdk; Connector dùng contracts + egress + observability. Đây là declared dependency inventory, chưa chứng minh toàn bộ imports/call sites hoặc libs không dùng. Agent mở rộng production/test/tooling/Docker/CI và direct/transitive graph trước bỏ package.

- **MIG-00 / RPK-01:** tạo export→caller→responsibility→destination→test matrix cho cả sáu packages và lib/SDK khác nếu phát hiện. Phân loại API client mỏng, worker-local runtime, server-domain logic, document utility, security/observability; kiểm duplicate connector invokers và server→worker-sdk dependency. Mỗi export có một canonical owner trong Orchestrator repo; missing/unused chỉ xóa sau consumer proof.
- **MIG-04 / RPK-03/04/08/15:** colocate canonical source/reference/schema/vectors/guide/skills trong Orchestrator repo; internal server libraries được phép build trong repo này. Worker không cần repo/module sibling để build/runtime. Không bắt runtime server import worker loop chỉ vì dùng chung package hiện tại.
- **MIG-05 / RPK-05/07/14/16/17:** ưu tiên Runtime/Connector HTTP API; worker local thin clients và state/lease/checkpoint/crypto helpers materialized bằng template/skill có version. Document parse giữ local. Skill scaffold/integration/upgrade pin contractBundleDigest/referenceRevision/source hashes và preserve custom patches; dùng skill-creator khi thật sự tạo skill sau RPK-00.
- **MIG-06 / VFY-RPK-01/02/03/05:** scratch worker build/test không SDK/lib sibling source, không build/publish/install/link internal SDK package riêng; type/semantic conformance, grant/hash/replay/poll/deadline/UNKNOWN, duplicate/stale lease, crash/lost ACK, heartbeat/checkpoint, egress/crypto/redaction giữ đúng. Security patch/upgrade rehearsal bắt buộc cho duplicated modules. Third-party dependencies vẫn pin theo worker manifest.

Đây là bổ sung scope/acceptance cho tasks hiện có, không duplicate packet/editor hay bypass RPK-00. Coordinator cập nhật dispatch specs trước source extraction; có thể giao read-only dependency inventory ngay theo lease.

1. Client→Platform API→PG/outbox→queue→worker: giữ paths/methods/envelopes, stable operation/delivery IDs, queue names, business exactVersion/profile pins và idempotency.
2. Worker→Runtime: lease/fencing, durable reports/checkpoints, heartbeat/child/wait/result ownership không đổi.
3. Worker→Connector: service identity invoke scope + grant tenant/task/step/hash/artifact/revision; secrets chỉ ở Connector/Vault. Management qua Portal/BFF→API với admin/tenant/CSRF authorization.
4. Connector→provider→usage outbox→platform: giữ dedup/UNKNOWN/replay/poll/cancel/quota; readiness/migration không phát inference mới.
5. Cross-repo integration qua API/queue/versioned contract bundle. Không Worker đọc platform DB hoặc build bằng source bên ngoài repo. Duplication theo RPK cần patch tracking/security advisory/conformance; không fork contract authority.

## Dispatch / handoff instruction

### Direct user feature — IAM S3 sources (2026-10-06)

- Request: support non-presigned `s3://bucket/key` sources using the Orchestrator workload role, including cross-account bucket-policy grants, without request access keys.
- Owner: codex_arch; API/ingestion implementation and offline verification. Contract retains `sourceUrl`; explicit deployment `DU_S3_SOURCE_RULES` scopes tenant/bucket/prefix/region/owner. HTTP source auth is bypassed for IAM S3 reads. Source version/ETag pinning, byte/time budgets and the existing private artifact/READY gate remain enforced.
- Docs/config/spec: [deployment and API guide](../docs/s3-role-source-ingestion.md), generated OpenAPI via the canonical generator; same Node 24 baseline. Candidate export includes generated spec needed by the current Dockerfile.
- Receipt: [IAM S3 source implementation](../coordination/reports/s3-role-source-implementation-2026-10-06.md). Independent review and live AWS workload-role/cross-account/SSE-KMS validation remain OPEN; no task tick, AWS infrastructure policy change or deployment implied.

### Phase B owner receipt — 2026-10-06 (historical; latest verdict ở intake bên dưới)

Receipt: [Codex Arch Phase B remediation](../coordination/reports/codex-arch-phase-b-remediation-2026-10-06.md). Owner implementation/verification, independent acceptance OPEN; no checklist row closed.

- MIG-04 build milestone: candidate includes current Portal folder, canonical packages and separate Backend/Connector images; isolated Node 24.21.0 builds pass. Full reference/docs/skills/Swagger distribution, MIG-08 rename and independent verification still require reconciliation before accepting the complete row.
- Live HANDLER_ERROR remediation: trusted internal artifact-grant origin wired through `ORCHESTRATOR_INTERNAL_BASE_URL` (Compose default `http://orchestrator:3002`); production PostgreSQL boot requires it. Adapter consumes `promptStepId` and separates `sessionRef` from strict provider options. Focused owner tests: 73 passed. Final live ingest succeeds with checkpoint/result/download/replay. Extract advances to one checkpoint then BINDING_DENIED on the unconfigured Connector setup; successful extract acceptance remains OPEN.
- MIG-05 expansion gate: pilot compiles in an isolated Node 24 container but fails startup with MODULE_NOT_FOUND for @du/worker-sdk. Repair runtime aliases/entrypoints, Node 24/dependency/lockfile/security parity and pinned provenance first. Then independent pilot verification, Example Review, finally LC Checker; do not duplicate the current non-starting template.
- Antigravity retains dispatch/lease ownership: bind independent verification and the existing pilot/worker lanes using the source/hash receipts. No new coordinator, remote, push, cutover or task tick is authorized by this receipt.

### Consolidated live/deploy intake và quyết định MIG-05 — 2026-10-06

Nguồn: [Coordinator handoff 11:00 +07](../coordination/reports/handoff-codex-arch-live-test-deploy-2026-10-06.md), raw summaries và owner receipt dưới đây. Section này supersede functional verdict Ingest/Extract và module-resolution NO-GO trong owner receipt lịch sử; các acceptance holds khác vẫn giữ.

| Slice | Đã code / build | Đã verify | Đã accept / còn thiếu |
|---|---|---|---|
| MIG-04 candidate | Candidate tự đủ với Portal hiện hành, canonical packages, Backend/Connector images riêng; isolated Node 24.21.0 build 9 workspace projects exit 0 theo Phase B/handoff | Build milestone và scoped live flows; chưa full independent candidate verification | OPEN: reference/docs/skills/Swagger distribution, MIG-08 mapping, final VFY/review |
| Ingest live-local | Artifact-grant origin và adapter remediation; focused owner tests 73 pass / 6 suites theo Phase B | [Raw summary](../coordination/reports/phase-b-live-summary-2026-10-06.json): operation `64edc168-c736-4e9f-aebb-71b5aed722cd`, SUCCEEDED, 1 task/2 checkpoints; result/download 200, fixture trong download; replay 200 cùng operation ID | Scoped PASS; không đóng toàn bộ VFY-06 |
| Extract live-local | Disposable `json-http` Connector revision, profile binding slot `reasoning`, mock provider | [Raw summary](../coordination/reports/raw/phase-b-extract-resume-prep-2026-10-06/run-summary.json): operation `3191692e-ff4b-479d-9b7b-686e530ba45b`, submit 202, SUCCEEDED, 1 task/3 checkpoints, errorCode null, 1 provider call; result/download 200, opaque artifact matched, invoice `INV-ARCH-PHASE-B-MOCK-001`, total `4250`; tester addendum exit 0 | VERIFIED cho ca mock-provider này; real-provider/negative/compatibility cases và full acceptance OPEN |
| MIG-05 module resolution | qwen_2 thêm 5 `@du/*` shim manifests trỏ compiled `dist/vendor/*` | [Owner receipt](../coordination/reports/template-runtime-module-resolution-fix-2026-10-06.md): parseWorkerConfig thành công, log Starting Document Core Worker service, không còn MODULE_NOT_FOUND; boot có env vẫn exit 1 tại Worker failed to start do thiếu runtime live; chưa behavior tests | Module-resolution blocker RESOLVED theo owner evidence; fresh-install packaging và independent pilot verification OPEN |
| Image scan | Orchestrator/Connector/Document Core images mới | [Image summary](../coordination/reports/phase-b-image-summary-2026-10-06.json): cả 3 scannedImageId khớp imageId, High/Critical = 0, exit 0 | Scoped scan PASS; không chứng minh zero mọi severity hoặc đóng lockfile/dev-tooling/xlsx/auth/security-event findings |

Live namespace `arch-phase-b-20261006`: Extract cleanup xác nhận key tạm revoked, revision disabled, mock sidecar stopped, Connector egress policy restored. Tester addendum ghi Orchestrator/Connector/PostgreSQL/Valkey healthy; workers running (không có Docker healthcheck), migration exited 0. Stack/volumes được giữ lại; không phải production cutover.

**MIG-05: gỡ NO-GO riêng do `MODULE_NOT_FOUND: @du/worker-sdk`; GO cho hoàn thiện packaging và kiểm chứng pilot hiện có.** Handoff gọi boot OK nhưng receipt gốc chỉ chứng minh import/config/start path, chưa chứng minh worker healthy hoặc xử lý task. Live Document Core Compose không tự chứng minh standalone template là cùng artifact đã verify.

1. **MIG-05/RPK worker owner:** materialize fix qua source-controlled scaffold/build/install mechanism. Shim hiện nằm trong `template/node_modules`; chứng minh tồn tại sau scratch checkout/install, không dựa node_modules có sẵn hoặc SDK sibling/build/publish/link riêng. Ghi source hashes, pinned provenance, Node24/manifest/lockfile/security parity.
2. **VFY-06 / existing pilot tester:** fresh scratch context không siblings → install/build/boot Node24 → Runtime/Redis live-local mock flow, lease/heartbeat/checkpoint/complete/result và affected negative/conformance cases. Receipt ghi command/cwd/hash/namespace/exit/raw output; owner log và exit 1 không đóng independent pilot gate.
3. **Expansion:** independent pilot verification đạt mới nhân sang Example Review rồi LC Checker. RPK sequencing và CR06 holds giữ nguyên; MIG-05 chưa ACCEPTED, cần REVIEW-07 APPROVED theo gate hiện hành.
4. **Build/security owner:** đối chiếu exact image IDs trong summary, scan final lockfiles/tooling và mọi severity thuộc acceptance; rerun affected verification khi candidate/image đổi. 0 High/Critical không đóng toàn bộ SEC-UI/CR06 hoặc chứng minh vulnerability-free. Node24 là partial implementation ở MIG-04, chưa đủ parity toàn bộ workers/template.
5. **Next implementation (superseded bởi intake tiếp theo):** MIG-08B UI rename và MIG-03 viewer đã có owner receipt; ưu tiên backend allowlist, MIG-08C packaging và independent verification trên candidate mới như dưới đây.

Board giữ 9/9 rows `[ ]`, 0/9 ACCEPTED; số checkbox không phải tỷ lệ implementation/release readiness. Full VFY-06/REVIEW-07, PM-M02 host-port/separate-client probes, MinIO/Vault, relevant CR06 dispositions và security scope còn OPEN. Coordinator hiện hành giữ dispatch/lease ownership; intake không tạo coordinator, remote, push hoặc cutover.

### Follow-up intake — MIG-00 / MIG-08B + MIG-03 viewer / MIG-05 scaffold — 2026-10-06

Tiếp nhận ba receipt do người dùng chuyển tiếp. Đây là owner implementation evidence; không thay independent VFY-06/REVIEW-07 hoặc UI_APPROVED.

| Slice / receipt | Đã code / deliver | Đã verify | Đã accept / còn thiếu |
|---|---|---|---|
| MIG-00 — [oc_2 docs sync](../coordination/reports/plat-mig-00-architecture-docs-sync-2026-10-06.md) | Đồng bộ docs/40, 02, 09, 12b về naming, hai loại repo mặc định, PM-M02 ports/listeners và scoped Ingest/Extract PASS | Owner kiểm fences, stale labels, anchors và đối chiếu Compose working tree; receipt có hashes bốn file | OPEN: full export/consumer inventory, docs/source/deployment parity độc lập và review; docs không đóng PM-M02 hoặc live management/MinIO/Vault |
| MIG-08B UI + MIG-03 viewer — [oc_1 receipt](../coordination/reports/mig08b-portal-swagger-2026-10-06.md) | Tên hiển thị Orchestrator Portal/Backend; `/admin/web/api-docs` đọc generated docs/21-openapi.json dưới dạng build-time asset, không CDN/spec thứ hai, Try it out absent | Owner typecheck/build exit 0; Vite asset `index-BFkVsTJy.js`; [browser raw](../coordination/reports/raw/mig08b-portal-swagger/portal-browser-probe.json) 13/13 PASS, screenshots trong receipt, externalRequests rỗng; 57 operations, 14 schemas ở artifact đã probe | OPEN: backend allowlist, exact image/session/auth browser checks, route/spec full parity, Compatibility coverage, independent UI_APPROVED/backend APPROVED; MIG-08C chưa rename folder/package |
| MIG-05 — [qwen_2 scaffold/provenance](../coordination/reports/plat-mig-05-scaffold-and-lock-2026-10-06.md) | `scripts/scaffold-shims.mjs` tạo 5 shim idempotent + `--check`, wired qua postinstall; gen/verify VENDOR-LOCK.json | Owner 59/59 vendor hashes + 5/5 shims, exit 0; Codex Arch rerun hai read-only verify commands tại template cwd cũng exit 0 | OPEN: chưa fresh npm install trong isolated container, chưa dependency lockfile, chưa live pilot behavior; VENDOR-LOCK là provenance lock, không phải npm dependency lock |

**Deployment blocker cho viewer:** receipt oc_1 ghi `services/orchestrator/src/app/admin/shell-server.ts:335-346` hardcoded `ADMIN_WEB_ROUTE_NAMES` chưa chứa `api-docs`; khi cấu hình `DU_ADMIN_WEB_ROUTES`, route có thể trả 404 trước app boot. Backend owner cập nhật allowlist + relevant tests theo lease, giữ session/auth policy. Vite probe stub `/admin/api/session` bằng 401 và không chạy Backend/image; không tính 13/13 là authentication/session/CSRF verification.

**Viewer scope:** đây là dependency-free React API Reference viewer, không phải upstream `swagger-ui` package. Owner receipt chứng minh Public/Admin/Runtime/Connector filters; Compatibility coverage và full OpenAPI validation vẫn cần MIG-03/VFY-06 disposition. Không suy full Swagger acceptance từ render PASS. Folder `apps/admin-web` và package `@du/admin-web` giữ nguyên chờ MIG-08C; env/wire identifiers không đổi.

**MIG-05 remaining parity:** manifest đọc tại intake vẫn `engines.node >=20.0.0`, `@types/node ^20.19.0` và third-party version ranges; chưa đạt Node24/pinned dependency baseline toàn scope. Lock hashes chứng minh current vendored bytes khớp lock, không tự chứng minh canonical source provenance đầy đủ: còn contractBundleDigest/referenceRevision, canonical working-tree source hashes và upgrade/security rehearsal theo RPK. Boot không env dừng tại config, chưa worker behavior. Giữ GO cho hoàn thiện pilot, chưa mở rộng sang Example Review/LC Checker trước independent pilot verification.

**Next owners:** backend/Portal integrator sửa allowlist; MIG-04/08C build owner freeze folder/package mapping rồi refresh image/candidate; VFY-06 kiểm browser/session/BFF và spec coverage trên exact digest; Antigravity UI reviewer + Claude backend reviewer cho verdict theo gate. MIG-05 owner hoàn thiện dependency lockfile/Node24 và fresh-install receipt, existing pilot tester kiểm live-local Runtime/Redis/mock flow. MIG-00 docs owner reconcile inventory/consumer matrix và snapshot sau packaging. Reuse existing leases, không tạo writer/dispatcher mới.

**Acceptance không đổi:** 9 task rows giữ `[ ]`, 0/9 ACCEPTED. Ingest/Extract PASS và image High/Critical scan giữ đúng scope ở intake trước; PM-M02, relevant CR06, full security, MinIO/Vault và final combined-candidate gates vẫn OPEN. Không commit/push/cutover từ intake này.

### Candidate packaging intake — cw1 / r2 — 2026-10-06

Receipt: [Portal/Swagger candidate build](../coordination/reports/portal-swagger-candidate-build-2026-10-06.md). **IMPLEMENTED packaging milestone / owner build verification PASS: 5/5 images**, không deployment hoặc acceptance. Bake tag chung `candidate-portal-swagger-20261006-r2`; `pull=true`, `no-cache=true`, pinned `node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`. Receipt ghi fetch 654 locked packages rồi service builds network-disabled; host Portal build dùng Node 22.16.0 có engine warning, không dùng host run để chứng minh Node24 parity.

| Candidate image | Local image ID theo receipt |
|---|---|
| du-orchestrator | `sha256:08250516cfdfb860c47b70d36b396919a12bdc5252154f25706ea307880b7e4e` |
| du-connector | `sha256:4f48f7b8a30d9f8b31094d2539d3b767d593f2672464d2159c388f4c768166b4` |
| du-document-core | `sha256:e29997b5e8048b74dc3646003ecd90348834370988aa64bea6a7bdd03027dd85` |
| du-lc-checker | `sha256:4195801832445fc19f6f05bf5e50583dbc48e0d83ec93457d61f89f0265bea24` |
| du-example-review | `sha256:d964b9a8d9c4dc637f1b83ecf7932db8248368f7764d9984ed8c9093dabd0002` |

Đây là local image IDs, không coi là registry manifest digests. Tất cả mang tag r2 ở trên; receipt ghi runtime user `node`.

- **MIG-04 / MIG-03 asset packaging:** `.dockerignore` re-include duy nhất generated `docs/21-openapi.json`, Dockerfile COPY artifact; Vite embeds vào bundle và runtime `/app/admin-web`. Host `dist` excluded nên rebuild từ source. One-shot image asset check exit 0 ghi Portal title, `/api-docs`, API Reference, operation/filter/disabled Try-it-out text, không CDN; không start service/port. OpenAPI artifact SHA-256 `BB6875EC39013DC4D99D6078734FD212DE6A9267366184F12F9287392630CA8D` theo receipt. Viewer là first-party React OpenAPI viewer; upstream Swagger UI wording vẫn chờ reviewer disposition.
- **Build evidence:** Bake print/load exit 0 theo receipt; intake đọc [literal Bake exit](../coordination/reports/raw/portal-swagger-candidate-build-2026-10-06/candidate-bake.exit.txt) = 0, xác nhận [raw Bake log](../coordination/reports/raw/portal-swagger-candidate-build-2026-10-06/candidate-bake.log) tồn tại và HCL có đúng năm targets/pull/no-cache. Không rerun build từ intake docs này.
- **PM-M02:** config-only verifier exit 0 theo receipt, 3002/8080 không host-publish mặc định, workers dùng Internal Runtime URL. Image `EXPOSE 8080` không phải host publication. Config-only không đóng live ingress/firewall hoặc host8080 collision finding.
- **MIG-08C / route integration:** folder/package vẫn `apps/admin-web` / `@du/admin-web`; r2 đóng mốc đóng gói branding/viewer hiện hành, chưa folder rename. `api-docs` allowlist issue vẫn mở khi `DU_ADMIN_WEB_ROUTES` non-empty; Compose default empty không thay acceptance cho gated deployments.
- **VFY-06 / security / REVIEW-07:** chưa browser/session/authenticated navigation, Ingest/Extract rerun hoặc scan/SBOM trên năm image IDs r2. Không chuyển PASS live snapshot trước hoặc 0 High/Critical ba images trước sang r2. Build monorepo workers cũng không thay scratch standalone template/pilot MIG-05 verification.

**Next owners:** backend owner resolve route allowlist; build integrator refresh candidate nếu source/folder/lockfile đổi. Existing independent tester bind exact r2 IDs (hoặc refreshed IDs) cho browser/session/BFF, relevant contracts và scoped Ingest/Extract; security owner scan final images/lockfiles + SBOM; UI/backend reviewers ký trên cùng snapshot. MIG-08C rename và MIG-05 standalone parity tiếp tục theo leases/sequence hiện hành. Receipt ghi không deploy, không DB touches, không thay `:local` tags; 9 task rows vẫn `[ ]`, acceptance OPEN.

### Portal comprehensive UI E2E intake — oc_1 — 2026-10-06

Receipt: [Portal UI E2E verification](../coordination/reports/portal-ui-e2e-verification-2026-10-06.md). **Scoped UI harness verification PASS**: `node tests/browser/scripts/run-portal-all-features.cjs`, cwd `du-rework`, **31 passed / 1 skipped / 0 failed, exit 0**, 43.1s. Skip là duplicate 768px sweep trong mobile project; desktop sweep đã chạy, không tính skip là pass.

| Phạm vi | Evidence / kết quả | Giới hạn acceptance |
|---|---|---|
| Routes/layout/console | [Raw summary](../tests/browser/artifacts/portal-all-features-summary.json): 30/30 records OK, 14 routes + shell × desktop 1440×900 / mobile 390×844; 0 console errors, 0px horizontal overflow; 31 screenshots gồm 768px sweep | Rendering/interactions trên fixture upstream; không live platform/DB/Redis/provider |
| Interactions | Revoke dialog open/cancel, connector/profile Load, operation artifacts, business versions, crypto-config, API Reference filter/search/detail/schema, mobile nav toggle theo receipt | Không chứng minh successful live mutations, login hoặc full auth/CSRF enforcement |
| Accessibility | 0 critical/serious violations trong các desktop axe scans; sửa `scrollable-region-focusable` bằng `tabIndex={0}` ở API docs scroll regions rồi rebuild dist | Mobile không chạy axe; color-contrast disabled; không tuyên bố full WCAG hoặc mobile axe PASS |
| Shell/build environment | Real `createAdminShellServer` + real Portal dist; platform-admin session cookie, upstream stub fixtures; identity response deterministic trong spec. Windows Node 22.16.0, pnpm 10.18.3, Playwright 1.63.0 Chromium | Tiến bộ so với Vite-preview-only 13/13 trước đó, nhưng chưa Node24 candidate image/browser/session acceptance hoặc independent UI verdict |

Codex Arch intake đối chiếu [final log](../coordination/reports/raw/mig08b-portal-swagger/portal-e2e-final.log) (31 passed, 1 skipped, exit 0), SHA-256 raw summary `136CE77602BB37DE71807CE5465A56C04C77C197801EA3452C574DCB2CE69778` và [Playwright report](../tests/browser/artifacts/playwright-report.json) `C1267B2F9AD021B92E7BC7469FD1D2C49D6231F1083A45E5CD4B99681FCD02E2`, đều khớp receipt. Không rerun suite ở lượt tổng hợp này.

**Candidate freshness:** `api-docs-screen.tsx` hiện hash `5CD84AFE19F86CE89BE8586FAAF3343AD8DD6BFF9B437556CEA1196C916DE8AB`, khớp E2E receipt nhưng khác r2 packaging receipt (`4AC05F07EA8C058C317BF001D965CD7383CE5BB73B9DC9CC38D668B26DD0C6FD`). Vì vậy E2E green trên dist mới không tự verify image r2 hoặc chứng minh a11y fix đã nằm trong r2. Build integrator refresh candidate, ghi new IDs/source/artifact hashes và bind affected image verification/security scans trên snapshot mới.

**Next owners / acceptance:** backend owner vẫn xử lý `api-docs` allowlist cho non-empty `DU_ADMIN_WEB_ROUTES`; MIG-08C folder rename còn mở. Existing independent VFY tester kiểm exact refreshed image, authenticated navigation/session/BFF và relevant route gating/contract cases; Antigravity UI reviewer cho UI_APPROVED, Claude backend/build reviewer cho APPROVED theo gate hiện hành. Owner-authored UI E2E receipt không thay independent review. 9 task rows giữ `[ ]`, 0/9 ACCEPTED; scoped live Ingest/Extract, MIG-05, PM-M02 và security holds giữ như các intake trước.

### Roster refresh và candidate r3 intake — 2026-10-06

**Roster theo user/Coordinator notice:** rút các lane Codex cũ, thay bằng bốn OpenCode đang hoạt động. Đây là intake phân công do người dùng chuyển tiếp, không phải terminal/active-attempt audit hoặc dispatch mới của Codex Arch. Các chỉ dẫn tester cũ trong snapshots trước là lịch sử; coordinator bind independent verification/review bằng roster hiện hành, giữ nguyên tiêu chuẩn độc lập và acceptance gates.

| Agent | Packet hiện hành | Trạng thái bằng chứng ở intake |
|---|---|---|
| oc_1 | CR06-01 HIGH — prompt wiring disbursement + doc-compare | Assigned/active theo notice; chưa receipt fix/independent verify/review |
| oc_2 | CR06-03 MEDIUM — session seam call-sites và mapping | Assigned/active theo notice; chưa receipt fix/independent verify/review |
| oc_3 | CR06-04 MEDIUM — session survive pending async 202 | Assigned/active theo notice; chưa receipt fix/independent verify/review |
| oc_4 | CR06-05 MEDIUM — fail-closed service identity verifier | Assigned/active theo notice; chưa receipt fix/independent verify/review |

Reuse [CR06 acceptance definitions](CODE-REVIEW-FOLLOWUP-2026-10-06.md); việc giao owner không đóng finding. CR06-02/06/07/08/09/10 không có cập nhật disposition trong notice này và vẫn OPEN. CR06-03/04 cần chốt chung session mapping/contract và consumer verification; coordinator giữ exact non-overlapping file leases. Không dùng r3 build PASS làm bằng chứng bốn CR06 fixes đã tích hợp hoặc ACCEPTED.

**Latest packaging — cw1:** [r3 receipt](../coordination/reports/portal-swagger-candidate-build-r3-2026-10-06.md), tag chung `candidate-portal-swagger-20261006-r3`, Bake `pull=true/no-cache=true`, 5/5 images loaded local, exit 0. Node24 baseline theo Coordinator notice/current candidate build; receipt ghi fetch 654 locked packages, Portal tsc/Vite build pass (chunk warning 638.62 kB). [Raw exit](../coordination/reports/raw/portal-swagger-candidate-build-2026-10-06/candidate-bake-r3.exit.txt) = 0; [raw log](../coordination/reports/raw/portal-swagger-candidate-build-2026-10-06/candidate-bake-r3.log) lưu build. Không start Compose services, push registry hoặc commit.

| Image (cùng tag r3) | Local Docker image ID theo receipt |
|---|---|
| du-orchestrator | `sha256:0cc216643c94da8af6b06c1bd6529204ac86cc3700dbba92862b1aae8d062176` |
| du-connector | `sha256:93af9433cc2fd274cc7f9c9502d5eeaccdda6ec3852bdad984a825079431db78` |
| du-document-core | `sha256:a54e2ee00ad777216e9209c74dbfa338d9343adcfe981987ed077e1361ad1740` |
| du-lc-checker | `sha256:b7ea0f462c86e3f58edbf703af61d6e50a49bb8dde75d4ef6f29a1789c0cd601` |
| du-example-review | `sha256:d8a0d9c0782ec37476a118b81f137b9f303df020f1f2f2921bbf629655b4f608` |

**Resolved at source/payload boundary:** r3 read-only one-shot image inspection ghi a11y `tabIndex:0` markers và `api-docs` trong compiled `ADMIN_WEB_ROUTE_NAMES`; host/image Portal assets byte-identical. Embedded JS `index-DtNby8hm.js` SHA-256 `1f0ef150894f8ea674386ec929cd89bf7a57f13599e7c19ccb5abb7bce926ca2`; compiled shell SHA-256 `d1dcd4c9cc36519feb42514c2a116392602833a9ec31c337d2548009c6c4ac7b`. Codex Arch intake đọc source allowlist xác nhận `api-docs` hiện có. Do đó các yêu cầu sửa allowlist/refresh vì a11y ở intake r2/UI trước đã được supersede bằng mốc r3 packaging; không còn code-missing blocker này.

**Remaining gates / next owners:** Portal docs owner sửa stale `apps/admin-web/README.md:93-100` còn nói thiếu allowlist (không sửa docs ngoài lease từ intake). Independent tester theo roster mới kiểm r3 exact IDs: non-empty route allowlist allowed/denied, authenticated browser/navigation/session/BFF, affected contracts và scoped Ingest/Extract; security owner scan final r3 images/lockfiles + SBOM. UI/backend reviewers ký cùng snapshot. Owner UI harness PASS trước và image scans/live PASS cũ không tự áp sang r3. MIG-08C folder/package rename và MIG-05 standalone pilot vẫn OPEN. Sau CR06 fixes nếu candidate đổi, build integrator refresh IDs và rerun affected verification. 9 task rows giữ `[ ]`, 0/9 ACCEPTED; acceptance/release chưa đóng.

### CR06 implementation receipt intake — 3/4 OpenCode packets — 2026-10-06

Các assigned-only entries CR06-01/03/05 trong roster intake trước được supersede bằng owner receipts dưới đây. Không đóng finding từ lời báo hoàn thành; independent verifier theo roster hiện hành và Claude backend review APPROVED vẫn cần trước ACCEPTED.

| Packet / owner receipt | Đã code | Đã verify bởi owner | Đã accept / còn thiếu |
|---|---|---|---|
| CR06-01 HIGH / oc_1 — [prompt wiring](../coordination/reports/cr06-01-prompt-wiring-2026-10-06.md) | disbursement classify/extract/crosscheck/report + doc-compare stages có workflow-owned promptStepId; caller override không thắng stage key | RED trước fix; focused 27/27 và regression 153/153 exit 0; src lint exit 0; offline exact/default/cleared/null behavior qua handler/adapter | OPEN: independent verify/review, publish-B/retry/live pin retention/provider-observed semantics; test:typecheck exit 2 ở pre-existing profilePolicy-missing test fixtures |
| CR06-03 MEDIUM / oc_2 — [session seam](../coordination/reports/cr06-03-session-seam-2026-10-06.md) | 11 invoke sites / 6 actions wired capture/inject; src + template mirror; SDK facade forwards checkpoint sessionRef | src/template tsc exit 0; 99 action/focused, 85 regression, 37 session tests pass ở các runs exit 0; full package 60 suites pass / 3 compile-failed, 959 tests pass / 1 skip / 0 test-level fail, **exit 1** | OPEN: full suite compile reds, CR06-04 async-202, real provider session behavior, independent verify/review; workflows session wiring ngoài scope |
| CR06-05 MEDIUM / oc_4 — [identity enforcement](../coordination/reports/cr06-05-identity-enforce-2026-10-06.md) | Direct constructor fail-closed; overrides inherit config verifier; explicit test-only carve-out + runner guard/warn; HMAC threat-model note | Focused 19/19, Connector 374 passed + 1 skipped / 375 total exit 0; typecheck/build 0; Orchestrator dist consumer 8/8; mutations M1/M2 fail rồi restore xanh | OPEN: reviewer/coordinator disposition test-only carve-out, independent verify, live consumers/security gate; skip là existing live usage projection, không tính pass |
| CR06-04 MEDIUM / oc_3 | Carry sessionRef qua pending 202 đang hoàn tất test theo notice | Chưa có completion receipt được intake trong lượt này; CR06-05 unit run có suite async-202 từ lane khác nhưng không thay handoff CR06-04 | OPEN / in progress theo notice; cần complete producer→pending→SDK error→resume receipt và combined CR06-03/04 verification |

**Session mapping/design claim:** oc_2 chọn WIRE, exact canonical STEP_KEYS, không alias legacy `ocr`/`extract`; capture first-write-wins qua slot checkpoint `p745:session:<slot>`, same-step resume fallback. Receipt gọi mapping settled; Master Plan ghi đây là owner implementation decision chờ contract/consumer review, không tự nâng thành independent-approved rule. Multi-invocation chunk loops dùng chung injected session, capture offered session đầu tiên. Checkpoint GC hoặc real-provider semantics chưa được chứng minh live.

**MIG-05 new hold:** CR06-03 ghi template worker thiếu sanitization strip `promptStepId`/`sessionRef` trước SDK provider options trong khi canonical worker có. Template owner reconcile source/template behavior + tests theo lease trước standalone pilot acceptance; không copy CR06-01/03 changes vào template hoặc regenerate provenance lock mù khi chưa consumer review. Hash của shared `src/worker.ts` khác giữa CR06-01 và CR06-03 receipts do các lanes cùng tác động; final verification phải bind combined current source hash, không chỉ hash một receipt cũ.

**Security scope:** CR06-05 mặc định fail-closed nhưng có `allowUnauthenticatedTestTraffic` test carve-out (explicit flag, test-runner env, warning); production composition không expose config flag theo receipt. Reviewer cần đánh giá guard/threat model và coordinator disposition theo CR06-05 acceptance, không mô tả là mọi path tuyệt đối không ngoại lệ. Vault CR06-02/G-SEC và live integration chưa đóng. Connector full unit count có test CR06-04 concurrent; không cộng counts các runs thành unique test total.

**Next verification/packaging:** coordinator bind independent verifier trên combined Document Core/Connector/template snapshot, focused negatives + combined regressions CR06-01/03/04/05; disposition ba compile-red suites và docs/19/28/35 sync qua docs owner. CR06-04 receipt đến sau phải intake riêng. Build integrator đối chiếu source hashes với r3 và refresh affected images khi fixes chưa nằm trong payload; r3 build/previous UI/live PASS không tự verify các fixes này. Rerun affected contracts/session/identity/live mock flows và final security scans trên new IDs; Claude APPROVED trước closure.

**Progress:** 3/4 packets có owner receipts, 0/4 có independent acceptance evidence trong intake này; toàn bộ 10 CR06 findings vẫn chưa được Master Plan đóng ACCEPTED, sáu findings ngoài đợt này không thay disposition. 9 PLAT-MIG task rows giữ `[ ]`; parent T-PROM-02, G-SEC và relevant migration/release gates OPEN. Không dispatch mới, tick, commit/push hoặc cutover từ intake.

Coordinator hiện hành intake yêu cầu này vào Run/ledger hiện tại, kiểm lease và bind named owners. Reuse ACUI-M06/COMP/RPK/AWEB/SCALE task IDs khi cùng output; không duplicate coordinator, editor hoặc gate. Handoff tối thiểu: changed paths/hash, test command/cwd/namespace/exit/passed/failed/skipped/raw receipt, producer-consumer status và remaining limitations.

Coordinator phải phân biệt code / independent verify / accepted và trả task/dispatch/owner intake receipt. Nếu tool harness coordinator lỗi, giao ready implementation cho agent/tool path đang hoạt động trong existing Run, không báo DONE từ message enqueue. Commit/push/prod DB/backfill/window/provider billed calls giữ authorization tương ứng; không yêu cầu lại approval cho local docs/code/isolated verification đã được user giao.


## PORTAL-REQUEST-CONTROL-20261006 ? direct user request

SPECIFIED; owner implementation, independent verification/review pending.
- Request list/detail, server-side cursor pagination, newest created first.
- Stop delegates audited operations.cancel. Admin retry creates a new operation linked by retryOf; original terminal history remains immutable.
- Immutable startedAt/completedAt distinct from updatedAt; cache/file retention must not alter execution duration. Historical unknown completion remains unknown, never inferred from updatedAt.
- Tests: tenant/RBAC/CSRF/idempotency fences, retry input expiry and crypto rebinding, paging and detail, database timing against maintenance updates.


### PORTAL-OPS-FILTERS-20261006 ? follow-up operations coverage

SPECIFIED / OPEN. User asked whether operations filters cover time/profile/model/business. Current Portal state filter is insufficient for daily operations. Follow-up scope: creation/completion time range (explicit UTC/timezone), tenant and request ID search, business/action, profile ID/name/revision, actual model/provider usage. Distinguish configured model from observed model: requests can invoke multiple models, so actual-model filtering must join usage events with tenant fences and deduplicate operation IDs. Default newest creation sort and cursor semantics must remain stable across filter changes; reset cursor on any changed filter. Backend currently supports state/tenant/id/sort only. No filter-completeness acceptance claim.


### PORTAL-REQUEST-CONTROL-20261006 owner receipt

IMPLEMENTED with owner Node24 builds and 162 focused unit / 21 isolated PostgreSQL / 8 browser checks (191 distinct; no repeated-run inflation). [Receipt](../coordination/reports/portal-request-controls-2026-10-06.md), [contract](../docs/portal-request-management.md). Migration 0034 deployed only to isolated test DB. Independent verification/review and production cutover remain OPEN; no parent checkbox changed. Filters time/business/profile/model remain separate PORTAL-OPS-FILTERS-20261006 OPEN scope.


## PORTAL-IDENTITY-NETWORK-CONFIG-20261006 ? direct user plan request

Status: SPECIFIED / OPEN; plan-only intake, no writer implementation or acceptance claim. Reuse existing LOCAL/OIDC, SETTINGS-WIRE and SSRF/egress packages; no second configuration store or dispatcher.

### Confirmed current gaps

- `/admin/web/identity` has read-only OIDC metadata (issuer, clientId, callback URL, scopes) and local-user management. It has no OIDC configuration editor. Production OIDC is constructed from deployment env/secret inputs in `services/orchestrator/src/app/admin/oidc-boot.ts`; main builds the components at boot.
- `/admin/api/settings` POST currently fails with SETTINGS_WRITER_DISABLED: there is no durable deployment adapter actually applied at boot. A visible settings form is not evidence of a working OIDC/egress writer.
- No Portal editor/inventory for a system-wide outbound URL/domain allowlist was found. Shared `@du/egress`, Connector transport and source acquisition have SSRF/DNS-pinned fetch protection. Existing `allowHosts` is an exact IP exception seam, NOT a deny-by-default domain allowlist; public destinations may currently be accepted without being on a central domain list.

### PORTAL-OIDC-CONFIG-20261006

Owner boundary: existing Identity/LOCAL-OIDC owner owns backend/config/session semantics; Portal owner owns form/readback; Secret/Vault owner owns credential persistence. Coordinator binds non-overlapping existing leases.

- Add platform-admin-only OIDC configuration UI: enabled/auth mode (local/oidc/both), issuer, client ID, trusted callback URL, scopes, approved claim-to-role/tenant mapping, secret reference/rotation and discovery/JWKS connectivity test.
- Durable versioned configuration with expectedRevision/CAS, CSRF, audit and idempotency; validate/test draft before activate. Read view carries secretPresent/reference metadata only; client secret/tokens never returned to browser/logs. Secret is write-only through the existing secret manager.
- Runtime must read the same authoritative configuration. Show configured/applied revision and Pending restart when boot-only fields cannot be hot-reloaded. Never report Save/Active when no reader applies the value. Provide rollback and an explicit local recovery path so a bad issuer cannot lock out all administrators.
- Activate issuer/client/mapping changes with documented existing-session revocation/re-authentication semantics, trusted callback validation, state/nonce/PKCE checks and two-replica convergence. OIDC discovery/JWKS/token calls use the controlled system egress policy; a configuration test must not become an arbitrary HTTP proxy.
- Contract/API/schema/Swagger/docs and tests for admin/operator/viewer, CSRF, secret redaction, invalid issuer/callback, concurrent edit, failure/rollback, restart and actual local/oidc/both login. Independent browser + OIDC backend review required.

### PORTAL-EGRESS-POLICY-20261006

Owner boundary: platform config/egress owner owns authoritative policy and API; Connector owner integrates provider calls; source/webhook/OIDC owners integrate their outbound paths; Worker owners integrate canonical local transport/template; Portal owner owns editor/readback. Roll out with existing coordination leases, no second dispatcher.

- Add a Portal Network/Egress policy page with list/create/edit/disable, exact domain/URL origin, permitted scheme/port (optional constrained path), environment/purpose, tenant/business/profile scope, revision, owner/reason and effective/applied state. Purpose covers provider/Connector, source URL ingestion, webhook/callback, OIDC discovery/JWKS/token, trusted worker-to-platform/service mesh and server-side application/BFF calls. Distinguish outbound destinations from browser CORS/inbound allowed origins; they are different policies.
- Normalized matching: lowercase/punycode host, trailing-dot handling, explicit port/scheme, safe optional subdomain rules, no unrestricted wildcard; deny unknown destinations in enforced mode. Tenant/profile/business rules can narrow platform permission, not widen it. Inventory existing destinations and provide staged rollout/test mode before activation to avoid breaking providers, worker Runtime or login.
- One durable versioned canonical policy + shared enforcement contract. Every affected runtime must fetch/apply a server-authenticated policy snapshot or use the enforcing proxy; show applied revision/last acknowledgement per service. No UI-only list and no stored-but-unconsumed policy. Define revoke propagation and failure behavior (no silent allow-all on policy outage).
- Enforce at connection time and every redirect: pinned DNS resolution, all address answers adjudicated, TOCTOU/rebinding prevention, bounded time/body/redirects, no userinfo or credential forwarding across hosts. A business allowlist cannot bypass SSRF controls. Trusted internal mesh routes use purpose-scoped exceptions, never a blanket allowPrivateNetworks switch for user-provided URLs.
- Cover the actual call paths: Orchestrator source ingestion/webhooks/OIDC/Connector management; Connector provider requests; Worker Runtime/Connector/source calls and direct integrations; server-side app calls. A shared HTTP helper alone cannot constrain arbitrary worker `fetch`/third-party SDK sockets: deployment egress proxy/firewall/network policy is required for an enforceable system-wide promise. Browser JavaScript origins need CSP/connect-src rather than pretending a backend allowlist controls browser networking.
- Preserve non-presigned S3 IAM design: tenant bucket/prefix/expected-owner rules remain a separate resource policy; AWS service endpoints and workload identity credential resolution use trusted system-purpose rules. User-supplied destinations must never gain access to metadata endpoints through a domain exception; do not accidentally disable the controlled workload credential provider needed for IAM roles.
- Tests: allowed/denied/unlisted domains, subdomain boundary, punycode/ports, redirect to foreign domain/private IP, DNS rebinding, protected-address requests, cross-tenant/profile widening, revocation, restart/two-replica acknowledgement, direct Worker bypass and legitimate internal/S3/OIDC traffic. Update schema/API/Swagger/deployment docs and independent security review before acceptance.

Evidence: [OIDC/egress Portal inventory](../coordination/reports/portal-oidc-egress-plan-review-2026-10-06.md). Both gaps remain OPEN until backend consumers and runtime enforcement are verified, not just UI build.


## LOCAL-DEV-ALIGN-20261006

User-requested script alignment: Node 24.21.0, Public 3000/Internal 3002, Portal/BFF 3001, Connector 8088 on loopback, selectable three workers. Build exact package directories including Portal; fail on migration/readiness errors; never kill unrelated port owners. Owner implementation receipt pending; independent acceptance OPEN.

LOCAL-DEV-ALIGN-20261006: IMPLEMENTED (owner validation: Node 24 build 12/12, 10 runner checks, exit 0). Receipt: [local-dev-script-alignment-2026-10-06.md](../coordination/reports/local-dev-script-alignment-2026-10-06.md). Independent verification/acceptance OPEN; no live migrations or cutover.


## SEC-SENSITIVE-DATA-20261006 ? requested security review intake

Status: REVIEWED / CHANGES_REQUIRED; remediation OPEN, no acceptance tick. Receipt: [sensitive-data-security-review-2026-10-06.md](../coordination/reports/sensitive-data-security-review-2026-10-06.md). Current source exposes six High and two Medium findings; six offline defect reproductions and 167 existing primitive/policy tests do not close the gate.

- [ ] SD-01 Connector request/result/session application encryption and historical migration (Connector + crypto contracts).
- [ ] SD-02 URL/IAM-S3 source write through envelope storage + real strict-reader roundtrip (Orchestrator source/artifacts).
- [ ] SD-03 worker output encryption policy enforced at runtime storage admission/finalize, all worker entrypoints (SDK + workers + artifact backend).
- [ ] SD-04 sensitive-data boot policy, explicit synthetic-dev exemption, managed keys and strict reader migration (platform/deployment).
- [ ] SD-05 durable content retention/purge across services, object versions/manifests, historical copies/backups/providers; immutable execution times (lifecycle + Connector + deployment).
- [ ] SD-06 content expiry at grant issue and byte read, including existing grants and purge races (artifact/public/runtime APIs).
- [ ] SD-07 bounded protected temp storage, crash cleanup, actual tmpfs/encrypted-volume and swap evidence (workers/deployment).
- [ ] SD-08 sensitive API no-store headers and ingress/client policy (HTTP/deployment).

Independent security acceptance must inspect persisted bytes in PG/S3, crash/restart, tenant/AAD isolation, key outage, content expiry, purge acknowledgment and deployed storage/provider retention. Existing coordinator assigns non-overlapping implementation leases; this review did not dispatch agents or alter live configuration. Retention duration per data class remains to be agreed.


## SEC-SENSITIVE-PERSISTENCE-20261006 - mandatory encryption implementation

User-confirmed 2026-10-06: sensitive data written to S3 or DB during processing MUST be encrypted before persistence, across Orchestrator, Connector, all workers and every source/input/output/intermediate path. Reuse managed-key envelope crypto; fail closed on missing configuration/key/provider. IAM/TLS/SSE alone does not satisfy application envelope coverage. Explicit isolated synthetic-data exemption only; omitted flags cannot silently disable protection for real data.

Status: SPECIFIED / TODO, implementation required; no dispatch, verification or acceptance claimed. Detailed assignable packet with owners, leases, dependencies and acceptance: [SEC-SENSITIVE-PERSISTENCE-2026-10-06.md](SEC-SENSITIVE-PERSISTENCE-2026-10-06.md).

- [ ] SEC-ENC-01: canonical encryption policy/field inventory and frozen writer-reader contracts (platform crypto/contracts).
- [ ] SEC-ENC-02: encrypt Connector invocation request/result/session; secure poll/resume/replay (Connector backend; SD-01).
- [ ] SEC-ENC-03: encrypt HTTP URL and IAM-S3 acquired source/cache through strict artifact writer/reader (Orchestrator source/artifacts; SD-02).
- [ ] SEC-ENC-04: encrypted worker outputs/intermediates and PG/S3 blobs, server-side admission/finalize enforcement, all three workers/template (artifact/SDK + worker owners; SD-03).
- [ ] SEC-ENC-05: mandatory real-data boot/deployment enforcement for PG and S3, effective policy/read mode/key configuration, safe local-dev behavior (platform/deployment; SD-04).
- [ ] SEC-ENC-06: historical plaintext dry-run/backfill, bounded migration window, old versions/backup disposition; preserve retry/resume and immutable timing (data/crypto migration).
- [ ] VFY-SEC-ENC-01: independent current-candidate PG/S3 persisted-byte inspection, complete processing flow, key outage/tamper/crash/rotation/backfill; independent security review.

Coordinator: assign available existing agents under non-overlapping leases. SEC-ENC-01 interface first; SEC-ENC-02/03/04 parallel after contract freeze; one integrator for canonical crypto/create-app/shared API contracts. SEC-ENC-05 integrates completed writers; SEC-ENC-06 follows format freeze; independent verification/review gates parent closure. SD-05..08 retention/expiry/temp/no-store tasks remain OPEN and are not superseded by encryption. No live migration/commit/push/cutover in these implementation leases.


### SEC-SENSITIVE-PERSISTENCE transport clarification (user-confirmed 2026-10-06)

Internal DU Rework service-to-service transport may use HTTP/plaintext payloads; TLS/mTLS or internal delivery-payload encryption is not mandatory for these encryption tasks. Exception covers transit only: receivers MUST encrypt sensitive content before S3/DB/durable queue/outbox/cache/replay persistence. Keep signed service authentication, tenant/role/lease checks and private ingress isolation. External/public/provider transport is not included in this exception. Detailed packet updated; no source/config deployment change.


## PROFILE-CALLBACK-20261006 - per-profile endpoint payload and auth

User-requested callback policy: notification_only or notification_with_result per profile/endpoint; configured authentication headers or automatic OAuth2 client-credentials token acquisition. Status SPECIFIED / TODO; no implementation/dispatch/acceptance claim. [Assignable packet](PROFILE-CALLBACK-2026-10-06.md) defines contract, ownership, OAuth2 parameters, credential-origin binding, encrypted persistence, expiry, retry and Portal controls. Reuse P2-08/profile/Portal/egress/SEC-ENC owners and non-overlapping leases.

- [ ] CB-01 profile/endpoint versioned callback policy, admission snapshot and contracts.
- [ ] CB-02 notification/result delivery projection, encrypted durable payload, expiry and retry.
- [ ] CB-03 configured headers and OAuth2 token acquisition/cache/renewal, secrets and origin restrictions.
- [ ] CB-04 Portal per-endpoint editor and per-request delivery monitoring/test/resend.
- [ ] CB-05 API/Swagger/receiver documentation and candidate packaging parity.
- [ ] VFY-CB-01 independent integration/browser/security verification and review.

External caller supplies callback URL, never uncontrolled credential/token configuration. Profile credentials may only be sent to approved callback origins; external OAuth2 and authenticated delivery use HTTPS. Internal DU transit exception unchanged. Parent remains OPEN until independent acceptance.


## SECRET-CATALOG-20261006 - named secrets and reusable Secret/Text selector

Status SPECIFIED / TODO. User requested a dedicated Secrets tab, managed write-only values or trusted Vault KV2 path references, and reusable secret-name selection or explicit text input. Secret selections show name/Secret badge, never resolved value. Sensitive text inputs still require encrypted storage. [Packet](SECRET-CATALOG-2026-10-06.md) freezes runtime authorization/resolution, rotation, scope and consumer integration; reuse CR06-02/Vault and callback/OIDC owners. No general catalog currently demonstrated; existing Connector credential slots are partial capability only.

- [ ] SC-01 catalog/ValueSource contracts, metadata and authorized management API.
- [ ] SC-02 managed secret/Vault link adapters and actual runtime resolvers.
- [ ] SC-03 Portal Secrets management and shared Text/Secret selector.
- [ ] SC-04 Connector/callback/OIDC/approved settings consumer integration.
- [ ] SC-05 API/docs/runtime setup and candidate parity.
- [ ] VFY-SC-01 independent runtime/browser/security verification and review.

Existing coordinator assigns scoped owners; no new dispatcher or public secret-resolution endpoint. No implementation/acceptance claim from this intake.
