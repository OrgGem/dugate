# Phân bố lại shared packages — triển khai sau khi hoàn thành plan hiện tại

> **Repo topology đã chốt thêm — 2026-10-05:** [DU Platform architecture](../docs/40-du-platform-architecture.md) / [PLAT-MIG](DU-PLATFORM-MIGRATION-2026-10-05.md): tối đa ba loại repo, mặc định hai loại Orchestrator và Worker. Connector thuộc repo Orchestrator nhưng có service/image riêng; Worker template nhân bản cho từng business repo, build/deploy/scale tự đủ. Repo Connector độc lập tùy chọn. RPK-01 layout và RPK-10/15/18 build/extraction phải đáp ứng topology này; reuse tasks RPK thay vì tạo redistribution lane thứ hai. RPK-00 và DEFERRED sequencing dưới đây giữ nguyên; boot/ingress fixes độc lập theo PLAT-MIG phase A không tự kích hoạt RPK.

Ngày: 2026-10-05. Yêu cầu người dùng: contracts về Orchestrator; worker SDK và document kit về từng worker, chấp nhận duplicated source; thêm guideline/skill cho agent phát triển. Mọi business, kể cả Document Core, chạy trên worker và scale độc lập.

Trạng thái: **SPECIFIED / DEFERRED**, chưa IMPLEMENTED/VERIFIED/ACCEPTED. Chỉ viết plan và liên kết roadmap ngay. Toàn bộ implementation, tạo reference/bundle/skill và migration chờ `RPK-00`. Không dispatch từ tài liệu này, không thay ledger, code/import/build hoặc contract freeze đang chạy.

## 1. Điều kiện bắt đầu

Hoàn thành [plan hiện tại](PLAN-COMPLETION-2026-10-04.md), scope required trong [task index](README.md) và [P8 release readiness](P8-release-readiness.md) trước. Không dùng refactor này làm prerequisite mới, không buộc owner hiện tại đổi đường dẫn, không đóng task cũ bằng kiến trúc tương lai.

`RPK-00` chỉ đạt khi coordinator hiện hành ghi receipt xác nhận:

- Scope required hiện tại đã ACCEPTED, gồm các bổ sung người dùng đã chốt tới thời điểm closure: Admin/config parity và [AOPS](ADMIN-SYSTEM-OPERATIONS-SUPERSET-2026-10-05.md), API/business compatibility, security/data/encryption, continuity và [scale/HA](SCALE-HA-2026-10-05.md) trong phạm vi required. Không chỉ nhìn checkbox lịch sử.
- P8-08/G6 và mọi gate đầu vào áp dụng đã đạt với independent evidence/reviewer verdict; không còn finding/hold required. Khi còn live/browser/user decision hold, backlog này tiếp tục DEFERRED, không tự miễn hold để bắt đầu.
- Có baseline commit/build digest, contract version, image/config/migration revisions, receipt index và rollback artifact tái lập được. Release ready không tự cấp quyền chuyển production traffic.
- Các file lease liên quan được giải phóng; coordinator chỉ định named owner/lease cho đợt mới. Plan không cấp blanket lease.

Đây là dependency sequencing, không thêm gate cho release hiện tại. Acceptance baseline được giữ trong lịch sử; không tự chứng nhận bản đã di chuyển. Các task mới là đợt cuối sau closure, không chiếm capacity implementation hiện tại.

## 2. Kiến trúc đích

Giữ đường thực thi: client → Orchestrator → DB/outbox/queue → business worker → Runtime/Connector API → provider/artifact → checkpoint/result/usage/audit. Migration source giữ nguyên wire/state/policy; thay hành vi cần ID/acceptance riêng.

- **Orchestrator** sở hữu source contract chuẩn, validation server và logic điều phối/nghiệp vụ của mình. Xuất spec bundle độc lập source/build để consumer tự triển khai.
- **Connector** giữ adapter/provider ledger/quota và validation của mình; Connector owner cùng duyệt contract Connector. Consumer giữ bản contract local được pin, không import source Orchestrator lúc build/runtime.
- **Document Core Worker, Example Review Worker, LC Checker Worker và worker mới** sở hữu toàn bộ source runtime/client/document modules cần dùng, manifests/lockfiles/tests/Dockerfile/config riêng. Nhiều replica consume queue business/exactVersion tương ứng; rebuild một worker không bắt rebuild worker khác.
- **Core worker** là runtime nền bên trong từng worker, không phải service tập trung chạy mọi business. Orchestrator không trực tiếp chạy parser/pipeline business.
- **Reference và skill** hỗ trợ phát triển/nâng cấp source local, không nằm trên đường thực thi hoặc là dependency ngoài build context worker.

Layout dự kiến, chốt theo inventory RPK-01; không đổi route API:

```text
services/orchestrator/src/contracts/       # contract authority
services/orchestrator/src/modules/         # domain logic thuộc Orchestrator
services/connector/src/contracts/         # local wire copy đã pin
businesses/<worker>/src/platform/          # runtime/clients/artifacts/crypto/egress
businesses/<worker>/src/contracts/         # local types/validators cần thiết
businesses/<worker>/src/document/          # local parser/converter cần thiết
development/contract-bundles/<version>/   # spec/schema/vectors/digest, không secret
development/worker-reference/             # source mẫu, không build import
development/skills/                       # skills có version
```

Build context mỗi service/worker phải tự đủ. Bundle/reference được đưa vào source lúc phát triển, không tải `latest` khi build. Dependency bên thứ ba/toolchain được pin và cung cấp qua nguồn/cache được môi trường cho phép. Không cần publish `@du/*` lên registry; không tuyên bố offline hoàn toàn nếu chưa kiểm chứng dependency/toolchain offline.

## 3. Mapping 6 packages

**Bổ sung người dùng 2026-10-05 — canonical source cùng một repo:** contracts/server modules và canonical worker/client/document/egress/observability references, vectors, guides/skills thuộc repo Orchestrator. Consumer source local trong Worker được phép theo pin/provenance; không thêm repo Shared/SDK và không cần build/publish SDK nội bộ riêng cho worker. API-first áp dụng cho Runtime/Connector integration; skill materialize/upgrade thin client + executable helpers, không thay worker loop/lease/checkpoint/security bằng hướng dẫn. Document parse vẫn local. RPK-01 phải kiểm manifest/imports direct/transitive, server→worker-sdk, duplicate invokers, tests/tooling/CI/Docker và libs ngoài sáu packages; RPK-05/14/16 dùng pinned templates/skills; RPK-10/15/18 và VFY-RPK-01/05 chứng minh self-contained build không SDK sibling. Source reference chuẩn colocated Orchestrator, domain logic về đúng service owner theo mapping dưới. RPK-00 sequencing giữ nguyên.

Inventory dựa trên source ngày 2026-10-05, bắt buộc kiểm kê lại sau RPK-00 vì plan hiện tại tiếp tục phát triển. Kiểm cả production, tests, fixtures, admin/tooling/CI và Docker consumers.

| Package | Phân bố source đích | Spec/guideline/skill và invariant |
|---|---|---|
| `contracts` | Source chuẩn về Orchestrator; consumer giữ subset local. Pricing/budget/usage aggregation và quyết định operation/task state về module Orchestrator; logic riêng Connector về owner Connector nếu có | Bundle API/queue/event/schema/error/state/limits + canonical hash/encryption vectors. Giữ một authority; worker không import source Orchestrator. State/schema mô tả chung, service owner thực thi transition |
| `worker-sdk` | Runtime/clients/lease/checkpoint/continuation/artifact/crypto/temp workspace local mỗi worker. Ingestion orchestration/pin receipt về Orchestrator; acquisition helper còn consumer khác thì copy local có tracking | Lifecycle/artifact/ingestion guide và worker skill; giữ fencing, checkpoint durable, UNKNOWN reconcile, queue/exactVersion, CPU isolation và shutdown |
| `document-kit` | Modules cần dùng về từng worker; Document Core Worker giữ reference đầy đủ, Example Review/LC Checker giữ subset theo call sites | Document guide/skill, format/limits/fallback/ZIP/CPU fixtures. Không biến thành service mới; không gọi PDF parser hiện có là engine hoàn chỉnh; không silently bỏ qua chức năng thiếu |
| `connector-client` | HTTP client local từng caller; đối chiếu/hợp nhất chức năng với `worker-sdk/connector-invoker` trước bỏ package | Invoke/replay/poll/cancel/wait, auth/grant/deadline/errors/UNKNOWN. Giữ stable ID/hash/grant refresh, bounded timeout cả body; provider adapter/secret ở Connector |
| `observability` | Logger/context/redactor/metrics local mỗi service/worker; collector thành tool/process vận hành riêng với source/build tự đủ | Log schema/redaction vectors/correlation/bounded labels/health-readiness. Không đưa collector hoặc Elasticsearch credential vào mọi worker; giữ spool/retry/log routing |
| `egress` | Pinned fetch implementation local tại consumers cần outbound URL | Egress/security guide và vectors; giữ DNS adjudication→dial cùng address, redirect/IP policy/TLS/SNI/credential boundaries, không thay bằng hướng dẫn thuần văn bản |

Hai package cuối được phân bố để build tự đủ; bảo toàn security/observability đã nghiệm thu. Mỗi consumer chỉ mang phần cần, với provenance và quy trình nhận bản vá.

## 4. Contract, bản sao và nâng cấp

Mỗi consumer có manifest local: `contractVersion`, `contractBundleDigest`, `referenceRevision`, module source hashes, local patch inventory, supported producer versions, owner và receipt index. Contract version, reference revision, business exactVersion và image digest là các chiều khác nhau.

Bundle bất biến gồm endpoints/auth/errors/schema/examples, queue/event payloads, state semantics, timeout/retry/idempotency, limits và test vectors. Chọn một nguồn contract machine-readable và xuất artifact từ đó, có drift check; không duy trì hai bản schema chuẩn viết tay. JSON Schema export phải giữ refinement hoặc bổ sung semantic validators/tests. Types/OpenAPI không thay chứng minh lease/state/hash correctness.

Upgrade: chọn revision → xem affected modules/changelog → diff reference và custom patches → merge có review → conformance/regression → canary → cập nhật manifest. Không copy đè tùy biến, không tự tải code mới trong production. Security advisory có affected consumer list/owner/thời hạn theo policy hiện hành và receipt bản vá mỗi consumer; duplication không cho phép bỏ qua mandatory fix.

Breaking contract cần version mới/coexistence window và compatibility đã verify. Migration này mặc định wire-compatible baseline, không ép rollout đồng thời mọi worker. Rollback phải xét producer/consumer versions thực tế.

## 5. Guideline và skills cần tạo sau baseline closure

Chưa tạo/cài skill trong lượt lập plan. `SKILL.md` tham chiếu contract/reference revision cụ thể và commands thật; không sao chép contract thành authority thứ hai. Artifact/crypto/egress/observability guides là tài liệu hỗ trợ.

| Skill | Output | Acceptance |
|---|---|---|
| `durework-service-integration` | Clients/validators local từ consumer repo + bundle pin | Runtime/Connector calls đúng auth/tenant; không shared package hoặc DB platform access |
| `durework-business-worker` | Manifest/handlers/runtime/build/config/tests local | Register→queue→claim→checkpoint→result, replicas/lease loss/restart/shutdown đúng |
| `durework-document-worker` | Subset document modules/fixtures theo formats/actions | Parse/conversion/fallback/ZIP/CPU/memory bounds đúng, thiếu module fail rõ |
| `durework-worker-upgrade` | Reviewed diff từ local manifest/patch inventory và target revision/advisory | Giữ custom patches, xử lý conflicts, test trước ghi upgraded, security fix từng consumer |

Thử skill trên scratch repo không packages/source service khác. Skill không tự publish/deploy hoặc cấp secret; generated code phải qua cùng kiểm thử/review như code viết tay.

## 6. Tasks và dependencies

Owner là vai trò dự kiến, chưa assignment. Coordinator hiện hành đặt named owner/file lease sau RPK-00. Tester độc lập; Claude Code review backend/module/migration rủi ro cao. UI nếu bị ảnh hưởng cần Antigravity review đúng build theo contract hiện hành.

| ID / trạng thái | Task / owner dự kiến | Dependency | Deliverable và acceptance |
|---|---|---|---|
| RPK-00 [ ] | Xác nhận baseline complete — Coordinator/Reviewer | Required scope hiện tại ACCEPTED, P8-08/G6 theo §1 | Closure receipt/digests/rollback/leases; chỉ sau đây mới mở implementation |
| RPK-01 [ ] | Inventory và ADR layout — Architecture/owners | RPK-00 | Graph import/runtime/test/tool/Docker của 6 packages; export→owner→consumer→test đầy đủ; layout và boundaries |
| RPK-02 [ ] | Contract authority/compatibility — Orchestrator/Connector | RPK-01 | Wire/version/hash/state/auth/bounds ownership; baseline/new compatibility matrix; IDs cho mismatch ngoài refactor |
| RPK-03 [ ] | Contracts và domain logic về owner — Orchestrator | RPK-02 | Canonical source tại Orchestrator, domain modules đúng owner; transitional callers còn build; schema/vector/wire parity |
| RPK-04 [ ] | Bundle và conformance harness — Contract/tooling | RPK-03 | Version/digest/schema/vectors/examples/mock/provider checks/drift detection; đối chiếu routes, không chỉ generated types |
| RPK-05 [ ] | Worker runtime reference — Worker owner | RPK-04 | Core runtime + clients/lease/checkpoint/fan-out/HITL/artifact/crypto/shutdown tự đủ, provenance; không import packages |
| RPK-06 [ ] | Source ingestion về owner — Orchestrator/Worker | RPK-04, RPK-05 | Local pin/receipt orchestration; URL→bytes→immutable storage→READY/error giữ semantics/SSRF/hash; helper local đúng consumers |
| RPK-07 [ ] | Document reference/guide — Document Core | RPK-04 | Parser/converter/ZIP/PDF source/fixtures, CPU/memory/fallback/dependency/subset inventory tự đủ |
| RPK-08 [ ] | Egress/observability local — Platform/security | RPK-04 | Local modules/vectors, collector topology tương thích, patch tracking; bounded labels/spool và redaction |
| RPK-09 [ ] | Pilot Document Core Worker — Document Core | RPK-05, RPK-07, RPK-08 | Local platform/contracts/document; sáu actions/workflow giữ baseline; exactVersion/replica routing và subset manifest |
| RPK-10 [ ] | Build pilot độc lập — Build owner | RPK-09 | Local manifest/lockfile/Docker/entrypoint; context chỉ worker và dependencies cho phép; không sibling COPY/import, digest/dependency inventory |
| RPK-11 [ ] | Independent verify pilot — Tester | RPK-06, RPK-10 | VFY-RPK-01/02/03 pilot PASS và Claude APPROVED; chưa đạt thì không mở chuyển worker khác |
| RPK-12 [ ] | Example Review Worker — Worker owner | RPK-11 | Runtime/contracts/document subset local; giữ custom review logic; isolated build và manifest |
| RPK-13 [ ] | LC Checker Worker — Worker owner | RPK-11 | Local runtime/contracts/document theo inventory, fan-out/workflow/custom patches giữ; isolated build/manifest |
| RPK-14 [ ] | Connector callers/clients — Connector/caller owners | RPK-11 | Local invoker/client thống nhất semantics tại mỗi caller; auth/grant/UNKNOWN/cancel/replay parity; không provider code ở worker |
| RPK-15 [ ] | Build services/collector độc lập — Service/Build | RPK-06, RPK-08, RPK-14 | Orchestrator/Connector/collector local build/config/migrations/health/logging không cần sibling source |
| RPK-16 [ ] | Guides và 4 skills — Developer tooling | RPK-11 | SKILL.md, pin bundle/reference, scaffold/upgrade workflow; scratch caller/worker build+conformance; giữ custom patch |
| RPK-17 [ ] | Patch/version workflow — Platform/worker owners | RPK-12, RPK-13, RPK-15, RPK-16 | Manifests/compatibility table/upgrade/advisory routing; rehearsal patch conflict/security fix propagation |
| RPK-18 [ ] | Migrate tooling và retire packages — Integration owner | RPK-12, RPK-13, RPK-15, RPK-16, RPK-17 | Tests/fixtures/scripts/CI/workspace/root lockfile/docs đổi; quét mọi consumer rồi mới bỏ 6 packages; không shared shim trá hình |
| RPK-19 [ ] | Verify toàn bộ candidate — Tester | RPK-18 | VFY-RPK-01..05 PASS trên exact build; mixed versions/2 tenants/2 replicas/business/security/skill evidence |
| RPK-20 [ ] | Canary/rollback rehearsal — Deployment/Tester | RPK-19 + backend APPROVED | Namespace cô lập, drain/mixed images/rollback; operation/checkpoint/artifact/usage không mất hoặc nhân đôi; không production switch từ plan |
| RPK-21 [ ] | Acceptance và rollout — Coordinator/owners/reviewers | RPK-20 | Candidate APPROVED + evidence; runbook/authorization deployment theo quy tắc hiện hành; traceability/test inventory cập nhật; onboarding mới dùng mô hình mới |

RPK-03 được dùng shim/alias chuyển tiếp trong đợt migration; RPK-18 phải bỏ toàn bộ cùng packages. Không tạo shim trước RPK-00. RPK-12/13 có thể chạy song song sau pilot với leases không giao nhau; root workspace/lockfile/contract/reference single writer. Không cấp quyền xóa packages hoặc deploy ngay từ task row.

## 7. Verification và acceptance cuối

| Packet độc lập | Phạm vi bắt buộc |
|---|---|
| VFY-RPK-01 — isolated build | Mọi worker, Orchestrator/Connector/collector build từ context local, sibling source/packages bị loại khỏi môi trường. Pin dependencies/toolchain; không publish internal packages. Rebuild một worker không bắt rebuild worker khác; integration CI full matrix không là build prerequisite từng image |
| VFY-RPK-02 — contract/security | Baseline vs relocated producer/consumer; invalid/missing/unknown/null/default/bounds, canonical hash/options/session/deadline/Unicode vectors; tenant/auth/grant negatives; redaction/tamper/encryption/SSRF/redirect/DNS pin. Không tự đổi thuật toán |
| VFY-RPK-03 — worker/document | Duplicate delivery, stale/expired lease, lost ACK, crash sau provider success trước checkpoint, pending continuation, UNKNOWN không dispatch lại, fan-out/HITL/restart/drain/CPU starvation. Sáu Document Core actions/workflow + Example Review/LC Checker; parser/ZIP/stream cleanup/crypto/result regression |
| VFY-RPK-04 — replicas/versions | 2 replica cùng business/exactVersion, 2 tenant; queue version isolation; old/new worker cùng producer hỗ trợ, producer rollback compatibility; durable outbox/checkpoint/usage idempotency, health/readiness |
| VFY-RPK-05 — skills/upgrade/deploy | Scratch repo dùng skills không packages/sibling source; scaffold/client, upgrade giữ patch/xử lý conflict/security advisory; canary/drain/rollback namespace riêng, dữ liệu in-flight không mất/nhân đôi |

Receipt ghi task/test IDs, commands/cwd, baseline/candidate/template/bundle/image digests, timestamp, namespace, pass/fail/skip, exit code, raw output và verdict. Evidence cũ chỉ reuse phần không đổi đã chỉ rõ; relocated/build/consumer paths verify lại. Skipped/zero discovered/mock-only không thay live lifecycle/deployment. Independent verification và Claude APPROVED mới cho phép ACCEPTED; UI theo gate hiện hành khi có ảnh hưởng.

Hoàn thành khi không consumer build/runtime nào phụ thuộc packages hoặc source sibling; mọi business vẫn thực thi trên worker scale độc lập; Orchestrator sở hữu contract nhưng không là worker build dependency; bản sao có provenance/patch workflow; 4 skills hoạt động trên repo độc lập; toàn bộ kiểm thử/rehearsal đạt trên reviewed candidate.

## 8. Rủi ro và nguồn inventory

- Duplicate code drift/bỏ sót bản vá: manifest/conformance/advisory routing và receipt từng consumer, không copy đè.
- Circular imports/mất exports: dependency graph, owner modules một chiều và isolated builds.
- Mất validator refinement/timeout/crypto/SSRF: semantic vectors trước xóa source cũ; generated types không đủ.
- Build tự đủ chưa chắc offline: xác minh nguồn/cache dependencies/toolchain đích.
- Rollback với in-flight provider: mixed-version rehearsal, giữ queue/checkpoint/ledger; không purge hoặc đánh FAILED để ép rerun.
- Ảnh hưởng tiến độ hiện tại: RPK-00 hard prerequisite; code/reference/skill/CI chỉ làm sau baseline complete.

Nguồn: [Contracts](../packages/contracts/README.md), [Worker SDK](../packages/worker-sdk/README.md), [Connector client](../packages/connector-client/README.md), [Document kit](../packages/document-kit/README.md), [Observability](../packages/observability/README.md), [Egress](../packages/egress/README.md). RPK-18 chuyển các links sang inventory/reference đích khi bỏ packages và giữ baseline digest để truy lịch sử.


<!-- COORDINATOR-ADD 2026-10-05 authorization -->
## Coordinator update 2026-10-05 - USER AUTHORIZED local implementation

User instruction: 'hãy yêu cầu các agent trong workspace xử lý task tách libs và migration. hãy nhắc và cho phép agent điều phối thực hiện'. Full packet: tasks/USER-AUTHORIZED-LIBS-MIGRATION-2026-10-05.md.

- The RPK-00 WAIT for LOCAL implementation and isolated candidates is SUPERSEDED. Local code changes, isolated build contexts, tests and disposable infrastructure are authorized.
- RPK-00 REMAINS a baseline/acceptance TRACKING task. Record actual open findings, freeze the exact working-tree snapshot per candidate, preserve independent verification and release gates. This authorization does NOT mark RPK-00 or any implementation ACCEPTED.
- Export MUST use an explicit allowlist with current source hashes, including classified product files that are untracked. HEAD-only exports and blanket dirty-tree copies are NOT approved source.
- Unclassified files require an owner decision.
- Production deployment, remote publication and destructive cutover remain OUTSIDE the packet.
- Bound lanes: RPK-INVENTORY-FREEZE-889 (qwen_1), WORKER-TEMPLATE-PILOT-890 (qwen_5, Document Core first). Orchestrator canonical libs lane staged.

