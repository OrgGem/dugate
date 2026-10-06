# Contract ranh giới Orchestrator parity ↔ legacy API compatibility

> **Admin/config scope 2026-10-04:** [CFGADM](ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md) bổ sung required inventory từ root, mapping 17 settings và operational journeys vào PAR/ACUI/AWEB. Register không tự defer chức năng Admin legacy hoạt động theo conditional/post-cutover lịch sử. Ownership COMP public wire, Connector provider/credential, worker DSL và BFF/policy giữ nguyên; scope UI đầy đủ không mở quyền provider call/DSL execution ở Orchestrator.

**Packet:** `A-TECH-LEAD-PARITY-BOUNDARY-RESOLUTION` (`task_31a1b92c4002`) · **Ngày:** 2026-10-01 · **Mức:** `SPECIFIED` ở phạm vi thiết kế ranh giới, chưa `IMPLEMENTED`/`VERIFIED`/`ACCEPTED`. Tài liệu này giải quyết cách chia việc cho `PAR-XA-01..05` trong [cross-audit](../coordination/reports/review.md#a-tech-lead-parity-plan-cross-audit). Nó không sửa yêu cầu external client dùng nguyên path/wire cũ, không thay tick/gate và không phải lệnh dispatch. Product/architect phải ký phân loại cutover tại `ORCH-PAR-00`; Claude Code review độc lập và Tester vẫn cần cho implementation.

## Quy tắc chung

- `COMP-00..11` sở hữu **external contract**: `/api/v1/docs/*`, public operations trên method/path cũ, `/api/v1/services`, `/api/v1/billing/*`, default legacy wire, golden fixtures và consumer migration. `ORCH-PAR-00..10` sở hữu **Admin/control-plane capability** để cấu hình và vận hành cùng runtime; Admin/internal URL cũ không phải external compatibility promise. P9 sở hữu business/workflow execution, Connector sở hữu revision/credential/adapter.
- Một nghiệp vụ có thể cần cả hai lane nhưng **một source of truth** cho schema, policy, fixture và bằng chứng. `server.ts`, `packages/contracts`, `docs/21-openapi.json`, shared docs/migrations chỉ có một write owner tại một thời điểm; coordinator cấp lease file/packet trước khi giao. Không import workflow interpreter hoặc provider secret vào Orchestrator.
- Nếu plan gốc nói rộng hơn contract ranh giới này, packet triển khai phải trỏ tới quyết định bên dưới và nêu phần chuyển owner; owner docs đồng bộ plan gốc trước khi hai lane cùng sửa shared file. Đây là boundary decision, không tự chứng nhận code đã đáp ứng.

## `PAR-XA-01` — OpenAPI và docs portal

| Deliverable / write path | Single owner | Handoff/acceptance |
|---|---|---|
| External request/response/error schemas và URL/version/default-wire, `packages/contracts/src/**`, `docs/21-openapi.json` | `COMP-02` contracts/API owner cho schema freeze; `COMP-11` docs owner nhận **cùng file** sau handoff để đồng bộ release/migration; không write đồng thời | OpenAPI mô tả legacy mặc định trên path trùng, canonical route/version mới, 31 variants và workflow theo fixtures; diff/spec-vs-live test thuộc COMP-10/11. `COMP-02 → COMP-11` là chuyển giao tuần tự, không hai nguồn schema. |
| External prose/examples `docs/06-public-api.md`, `docs/20-openapi-descriptions.md`, migration guide; phần external trong `docs/19`, `28`, `35` | `COMP-11` docs lane; COMP-02 chỉ cập nhật contract draft theo file lease được cấp | Ví dụ curl cũ không thêm header; external consumer sign-off và golden receipt được trích đúng build. |
| Served spec route, Admin docs navigation/renderer và cache/ETag/version presentation trong `services/orchestrator/src/app/admin/**` (mount `server.ts` chỉ theo Orchestrator lease) | `ORCH-PAR-09` Admin/docs UI owner | **Read-only consumer** của artifact OpenAPI đã freeze; không generate/chỉnh schema hoặc fork bản sao. Link/spec digest, auth-safe examples, không secret trong HTML/log, 404/fallback rõ khi spec unavailable. |

`ORCH-PAR-09` bắt đầu sau `COMP-02` freeze; có thể hoàn thiện UI trước `COMP-11` nhưng không tự publish thay đổi wire. `COMP-11` kiểm tra portal đang serve đúng artifact/hash sau docs handoff. Đây là cách hiểu hẹp của câu “OpenAPI legacy và canonical” trong `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md:51`, không phải hai task cùng viết `docs/21-openapi.json`.

## `PAR-XA-02` — Hai loại test và evidence

| Suite | Chủ sở hữu | Pass criterion; không được suy rộng |
|---|---|---|
| `COMP-10` golden compatibility | Codex Tester của COMP, contract/fixtures do `COMP-01/02` freeze | Cùng request legacy không sửa client trên DUGate cũ và rework: sáu core route/**31 variants**, ba workflow + schema, list/detail/result/lifecycle/download, status/header/body/binary/error/auth/encryption theo matrix. Offline rồi live PG/Redis/S3/Vault/Connector; mỗi case có fixture ID, raw receipt, pass/fail/skip và build digest. Đây là **owner duy nhất** của verdict 31/31 và byte/semantic external parity. |
| `ORCH-PAR-10` Admin-to-public integration | Codex Tester integration khác hoặc slot tuần tự, dùng lại **một số fixture ID đã freeze** từ COMP; không copy/duy trì golden matrix | Browser/API Admin login → create Connector/Vault ref → publish profile → issue key → submit **mẫu đại diện** core và workflow → poll/result/usage → rotate/revoke; chứng minh capability nối tới public route trên cùng build. Negative RBAC/tenant/CSRF/no-secret. Không tuyên bố 31/31 hoặc ghi đè verdict COMP-10; không bắt external consumer dùng Admin URL mới. |

`COMP-11` là integrator duy nhất cho external coverage/compatibility trong `docs/19-traceability-audit-matrix.md`, `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md` và migration guide. `ORCH-PAR-10` nộp receipt Admin journey/BR mapping cho docs lane; cập nhật phần Admin vào cùng docs **chỉ khi** coordinator cấp shared-doc lease (hoặc docs owner merge), ghi rõ test nào reused vs independently executed, không cộng double count. Nếu hai suite cùng chạy một case, cả hai ghi build digest/fixture ID riêng nhưng gate chỉ tính đúng scope của mỗi suite. `ORCH-PAR-10` không thay `COMP-10`; `COMP-10` không chứng minh Admin provisioning.

## `PAR-XA-03` — Profile locked-field policy một lần duy nhất

**Producer/consumer boundary:** Admin `ORCH-PAR-02` publish immutable profile policy revision; `COMP-02/03` decode legacy multipart thành canonical submission input; **cùng** submission service resolve key/tenant/action/profile, áp policy trước operation/task/outbox write và pin kết quả vào execution snapshot. Worker đọc pinned, sanitized effective config; không đọc live profile hoặc secret. `COMP-04` kiểm business variant dùng config đúng, không tái triển khai lock/merge.

| Layer | Owner và contract |
|---|---|
| Policy schema, repository, revision/migration, enforcement service dưới `services/orchestrator/src/modules/profiles/**` | `ORCH-PAR-02` platform/profile owner. Revision chứa allowed action/endpoint, parameter value + `isLocked`/default-lock từ manifest, prompt/model/limits/priority và Connector slot refs theo phiên bản đã chốt. Bind API key/tenant; validate publish và resolve đúng revision khi submit. Existing `profiles.ts` hiện chỉ pin `connectorBindings` (`services/orchestrator/src/modules/profiles/profiles.ts:9`, `:80`), nên đây là **thiết kế cần implement**, không phải claim code hiện có. |
| Public decoders/serializers `packages/contracts` và `services/orchestrator/src/compat/legacy-*.ts` | `COMP-02/03` owner. Decoder chỉ parse/normalize alias, multipart, snake_case, discriminator; truyền canonical client-supplied fields kèm presence metadata tới policy service. Không có bản sao policy trong facade. `server.ts` mount point serialize với ORCH-PAR-02/LOCAL lane. |
| Shared admission decision trong `modules/operations/submission.ts` | `ORCH-PAR-02` owner của call/enforcement seam; `COMP-03` là consumer/test owner trên legacy entry. Typed result tối thiểu: `effectiveInput`, `effectiveProfileRevision`, `connectorBindings`, `policyDenial`; resolve từ authenticated `apiKeyId`/tenant, không tin `apiKeyId`/tenant trong body. Canonical và legacy đều gọi cùng seam trước write; lỗi policy không tạo operation/task/outbox. |

**Merge semantics cần freeze từ legacy characterization:** default profile trước, client field chỉ ghi đè nếu cho phép; sự **hiện diện** của field locked bị từ chối kể cả giá trị client trùng default (legacy `lib/endpoints/profile-resolver.ts:49-86`). Không để “field không xuất hiện” và “field rỗng” bị nhập làm một. Manifest/default-lock và profile lock có thứ tự rõ, unknown/disabled field fail-closed theo schema/contract. Raw request hash/idempotency và immutable profile revision phải giữ replay không làm operation cũ đổi cấu hình; race giữa publish mới và submit pin một revision duy nhất. Không gửi credential material vào snapshot.

**Status/error projection:** policy trả typed denial, không tự viết HTTP. Legacy locked-field wire đang là `400 Forbidden Field` (`lib/endpoints/profile-resolver.ts:75-86`), trong khi rework `docs/06-public-api.md:176` mô tả canonical `403`; `COMP-02` chốt golden status/body cho **từng surface**, adapter chỉ project lỗi, không đổi quyết định policy. `ORCH-PAR-02` test pure merge + DB revision + canonical admission; `COMP-03` test cùng fixture qua legacy decoder và wire; `COMP-04` test variant consumer. Case tối thiểu: locked (kể cả same-value), unlocked override, absent/default, disabled action, unknown field, tenant/key mismatch, stale revision, same idempotency key replay, no DB/outbox on deny. Current `resolveBinding` có legacy no-binding fallback (`services/orchestrator/src/modules/profiles/profiles.ts:12-18`); `ORCH-PAR-00/COMP-00` phải ký phạm vi chuyển tiếp/disable để managed key không bypass policy, chưa được tự coi là an toàn.

## `PAR-XA-04` — Gate dependency không đổi ngầm

`G-COMP` đo external **wire + semantic parity** và consumer sign-off (`COMP-10/11`); `G-ADMIN-OPS` đo Admin operator capability/journey; `G-LOCAL-ADMIN` đo local login; `G-SEC`/`G-DATA`/`G-ENC` giữ tiêu chí riêng. P8-08/G6 tổng hợp **các gate hiện hữu**. Một Admin feature không tự trở thành điều kiện `G-COMP` chỉ vì `ORCH-PAR` gọi nó “đường găng”; nhưng external fixture cần profile/Connector/key thật thì capability upstream tương ứng phải có receipt để `COMP-10` pass. Không tạo gate mới ở packet này.

`ORCH-PAR-00` lập **cutover dependency register** theo journey, Product/API architect/security + external consumer owner ký. Mỗi dòng có `journeyId`, `PAR task`, external `consumerId/COMP fixture` nếu có, `required|post-cutover|retire`, gate đích (`G-COMP` khi là phụ thuộc thực của external parity; `G-ADMIN-OPS` khi là Admin UX/operation), migration/rollback, owner và acceptance receipt. Không thể đánh dấu `retire` cho sáu core, 31 variants, ba workflow + schema hoặc operations legacy bắt buộc: scope này đã chốt trong COMP-00. `ORCH-PAR-01/02/03/04` nào cần để chuẩn bị fixture external phải được ghi là **upstream prerequisite** trong `COMP-10/11` và P8-08 sau khi register được ký; không mặc định yêu cầu toàn bộ UI của các task đó cho `G-COMP`. `ORCH-PAR-05..09` vào gate tương ứng theo register, không ép mọi item P1 vào release.

**Decision path:** `ORCH-PAR-00` ký register → COMP-00/01 gắn `consumerId/fixtureId` → owner docs đồng bộ dependencies vào plan COMP/P8/README theo lease → Tester lập evidence matrix → Claude Code `APPROVED` từng module và release owner đánh giá gate. Nếu chưa có register hoặc plan chưa đồng bộ, item tranh chấp vẫn **BLOCKED**, `G-COMP`/P8/G6 không được nâng. `tasks/P8-release-readiness.md:28`, `:94-96` hiện chưa nêu PAR IDs; tài liệu này không tự sửa P8.

## `PAR-XA-05` — Inventory một chiều, không hai route matrix

| Register | Single owner / nội dung | Handoff |
|---|---|---|
| External consumer + wire matrix | `COMP-00/01` Product/API architect + docs: `consumerId`, app owner, legacy method/path, auth/header, request/response/error/status, variants, workflow, webhook/encryption, fixture ID, cutover sign-off. **Chỉ đây** là nguồn route/wire inventory. | Expose stable `consumerId`, `fixtureId` và yêu cầu provisioning/config cho ORCH-PAR-00; PAR không copy 31-variant rows. |
| Admin/operator journey + config migration register | `ORCH-PAR-00` Product/architect: `journeyId`, actor/role/tenant, legacy Admin UI/route, replacement capability/API, config/data/secret source, affected `consumerId` refs, classification/gate/rollback. **Không** freeze external status/body hoặc tự thêm consumer mới vào COMP matrix. | ORCH-PAR-00 gửi missing external consumer/path về COMP-00/01 để bổ sung **ở matrix COMP**; COMP trả fixture IDs để ORCH-PAR-10 dùng lại. Hai bên dùng ID liên kết, không hai bản sao cùng chỉnh. |

Nếu một legacy Admin journey đồng thời phục vụ external client, lập **hai record có khóa tham chiếu** (Admin journey và external consumer), không hai bản mô tả wire. `COMP-01a/b/c` có thể characterization read-only theo plan hiện hành sau owner check; ORCH-PAR-00 cũng có thể inventory read-only cùng lúc nếu không cùng write file hoặc tranh luận một route owner. Không freeze hay dispatch implementation từ inventory chưa được ký.

## Handoff và điều kiện đóng các finding

| Finding | Contract boundary đã chỉ định | Còn cần trước implementation/acceptance |
|---|---|---|
| `PAR-XA-01` | COMP-02→11 là single-writer OpenAPI; ORCH-PAR-09 consumer portal | Coordinator cấp write lease, plan gốc sửa wording, spec/portal contract test. |
| `PAR-XA-02` | COMP-10 golden 31/31; ORCH-PAR-10 Admin E2E representative | Freeze fixture IDs, tester packet + docs ownership, raw offline/live receipts. |
| `PAR-XA-03` | ORCH-PAR-02 policy/admission seam; COMP-03 decoder/wire | Profile schema + status projection COMP-02, migration, shared tests, no-binding fallback decision. |
| `PAR-XA-04` | ORCH-PAR-00 ký dependency register; COMP/P8 đồng bộ gate mapping | Product/security/consumer sign-off và acceptance matrix; gate vẫn mở. |
| `PAR-XA-05` | COMP external matrix; PAR Admin journey register, link bằng IDs | Data owner và write path trong packet, cross-link check không duplicate. |

**Trạng thái:** năm finding được **phân định ở mức contract**, chưa CLOSED ở mức implementation/review. `ORCH-PAR-00` có thể giao read-only decision packet sau coordinator owner check; `ORCH-PAR-01..10` vẫn theo dependencies trong plan và write leases. Không sửa source, không chạy test sản phẩm, không đổi `[ ]`, không nâng `G-COMP`, `G-ADMIN-OPS`, `G-LOCAL-ADMIN`, `G-SEC`, `G-DATA`, `G-ENC` hay `G6`: tất cả giữ **NO-GO/chưa có bằng chứng pass**.
