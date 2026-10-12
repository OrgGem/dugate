# Review Orchestrator: tương thích DUGate, chuyển dữ liệu và UI vận hành

> **ORV14 full implementation — IN PROGRESS, 2026-10-11:** Người dùng đã yêu cầu triển khai toàn bộ chức năng còn lại. [Execution/leases](../coordination/ORV14-FULL-ADMIN-EXECUTION-2026-10-11.md), [architecture/coverage](../coordination/reports/orv14-architecture-review.md). Sáu lane Luna6 max triển khai settings/runtime defaults/storage generations, rich COST+all-scope budgets, workflow XML/Profile/Test/Wizard, incidents+ops UI, queue/maintenance/backup-restore/HA và Identity/Connector/key parity. Các chức năng required giữ nguyên; scoped ORV13 không thay full CFGADM/AOPS. Chưa có independent full verification hoặc final acceptance; production data/credential/ingress proof tách riêng.

Ngày: 2026-10-11. Nhánh: `codex/fix-workflow-builder`. HEAD được review: `7e36a1e`.

Yêu cầu hiện tại: giữ contract API cho các hệ thống đang tích hợp; chuyển đầy đủ dữ liệu cũ sang hệ thống mới rồi cutover. Người dùng đã xác nhận **không yêu cầu hai hệ thống đồng bộ liên tục**. Orchestrator điều phối business độc lập; UI cần phục vụ đơn vị vận hành.

Các finding dưới đây là baseline review trước sửa trên HEAD nêu trên. Người dùng đã giao thực thi; source đang được cập nhật trong working tree theo ORV11 ledger. Chưa chuyển dữ liệu production hay thay trạng thái nghiệm thu của các task lịch sử.

> Execution authorized 2026-10-11: người dùng yêu cầu thiết lập và chạy plan. Operations public chỉ phục vụ đọc kết quả theo ID; list/cancel/resume/delete/retry chuyển về internal. Giữ cả download theo ID trên public để bảo toàn việc tải kết quả; canonical result và thao tác quản trị nằm ở internal. Các bảng review bên dưới là baseline trước sửa; trạng thái thực thi nằm trong [ORV11 execution ledger](../coordination/ORV11-EXECUTION-2026-10-11.md), không suy baseline là trạng thái code sau sửa.

> **Tiếp tục implement theo yêu cầu mới:** [ORV12 execution ledger](../coordination/ORV12-EXECUTION-2026-10-11.md) theo dõi các mục còn mở: cấu hình có phiên bản, biểu mẫu HITL, mapping/đối soát migration, usage và hạn mức chi tiêu, đăng nhập local sau reset, retry callback và download trên storage thực tế. Các kiểm chứng mới vẫn đang chạy; không dùng kết quả ORV11 để nghiệm thu code ORV12 chưa được kiểm tra.

> **Kết quả ORV12 — 2026-10-11:** đã cập nhật code và hoàn tất kiểm chứng/review độc lập cho các cơ chế bàn giao. [Receipt kiểm thử](../coordination/reports/orv12-verification.md):8 kiểm tra chính,31 biến thể core và4 workflow được chọn; [callback](../coordination/reports/orv12-callback-verification.md):11 kiểm tra riêng. [Reviewer](../coordination/reports/orv12-independent-review.md) APPROVED backend trong phạm vi bàn giao, UI_APPROVED luồng native profile/settings và HITL trên bundle cuối. Deselect ngoài phạm vi được ghi riêng, không cộng owner/rerun vào tổng. Các finding §3 là baseline trước sửa. **Full customer cutover vẫn chưa được nghiệm thu.**

> **ORV13 Admin completion — scoped ACCEPTED, 2026-10-11:** [execution/leases](../coordination/ORV13-ADMIN-UI-EXECUTION-2026-10-11.md), [main independent evidence](../coordination/reports/orv13-verification.md), [Compose independent evidence](../coordination/reports/orv13-compose-verification.md), [APPROVED/UI_APPROVED](../coordination/reports/orv13-ui-review.md). Docker Compose trên host là môi trường người dùng chọn. Đã bổ sung các luồng Admin ưu tiên và adapter release/restart/rollback allowlist; scoped verdict chỉ áp dụng các luồng đã chạy trên bundle cuối. §6 giữ plan/acceptance cụ thể cho global settings, budgets, incidents, queue/data maintenance, XML và customer cutover. Chưa deploy hoặc chuyển dữ liệu production; không thay parent/release gates.

### Trạng thái sau thực thi ORV11/ORV12

| Plan | Đã code và kiểm chứng | Phần chưa thể đóng toàn bộ acceptance |
|---|---|---|
| P00–P03 | Compatibility six core/31 variants, named/schema workflow, result/download public theo ID, replay/sync/callback và internal controls; ORV11 receipts + regression ORV12 | Credentials/provider và tích hợp khách hàng thực tế |
| P04 | Mapping/provenance/inventory đủ9 nhóm mẫu, IDs/membership/history/blob, encrypted connector/schema replay, local reset→login→scoped BFF và hai instance; audited effective mapping CLI | Dữ liệu khách hàng và mọi settings có disposition manual/deployment; imported schema runtime chưa được chạy trong fixture DATA mới |
| P05 | Frozen snapshot/timezone guard, bounded import, immutable replay/drift guards, target reconciliation/readiness | Production sizing, backup/restore, drain/HITL/callback/retry window, switch ingress và rollback sau writes mới |
| P06 | Revision/diff/validate/apply/restore với CAS/audit/encryption, native profile exact endpoint/pins, real workflow.test/poll và guided HITL/fallback | Typed HITL dùng schema mẫu; domain schemas generic vẫn cần advanced JSON; validation không phải paid-provider execution |
| P07 | Callback retry bounded/CAS/idempotent không chạy lại provider; UNKNOWN/budget guard; operator cancel/resume, migration dashboard và honest cost status | Callback browser mới kiểm panel rỗng; hành trình populated callback, mobile/keyboard toàn diện và rich COST export chưa nghiệm thu |
| P08 | Kiểm thử PG/Redis/Chromium/S3 emulator/HTTP độc lập và reviewer trên đúng source/build | Customer snapshot/timezone proof, cloud IAM/key provider/SSO/TLS/capacity và cutover rehearsal thực tế |

Các phần còn lại giữ mở, không đánh dấu parent task lịch sử hoàn thành. Lệnh mapping/local activation và cấu hình nằm trong [DATA runbook](../coordination/reports/orv12-data.md) và [LOCAL handoff](../coordination/reports/orv12-local.md).

## 1. Kết luận

**Chưa đáp ứng điều kiện thay thế hệ thống cũ mà không sửa các client đang sử dụng.** Kiến trúc điều phối có nền tảng phù hợp, nhưng các đoạn nối giữa API compatibility, business input/output và migration còn mismatch có thể chặn request, làm mất kết quả trả về hoặc bỏ qua policy đã nhập.

| Phạm vi | Đánh giá hiện tại | Điều kiện còn thiếu |
|---|---|---|
| Tách orchestrator / business / connector | Có implementation phù hợp hướng thiết kế | Kiểm chứng luồng thực tế qua các service trên cùng build |
| API tài liệu cũ | Có route và decoder; chưa tương thích đầu-cuối | Input schema, file references, output projection, sync, replay |
| API workflow cũ | Có named workflow, schema catalog, runtime và resume | Kiểm chứng workflow thực tế, auth transition, unsupported overrides, UI test |
| Operations / download / callback | Có các route; kết quả core và callback còn lệch contract | Đọc artifact result, giữ output và callback wire cũ |
| Migration schema mới | Có runner, ledger và verify object tồn tại | Chạy bộ schema hiện tại trên DB sạch và DB nâng cấp |
| Chuyển dữ liệu legacy | Có importer và kiểm tra bất biến; chưa đủ để cutover | Mapping slug, profile membership, file/state/user/settings, timezone |
| UI vận hành | Có shell, overview, operations, business cockpit, profiles, connectors | Settings thực thi được; workflow test thật; kiểm chứng hành trình trên trình duyệt |

Không suy tỷ lệ hoàn thành từ số route, số test đã viết hoặc checkbox lịch sử.

## 2. Contract cần giữ

Source root đang có **6** action tài liệu, không chỉ 5: `ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`. Trừ khi người dùng chủ động loại một API khỏi phạm vi, cả 6 đều thuộc acceptance.

| Surface legacy | Mapping hiện tại / yêu cầu |
|---|---|
| `POST /api/v1/docs/ingest` | `document-core/ingest`, 4 mode |
| `POST /api/v1/docs/extract` | `document-core/extract`, 6 type |
| `POST /api/v1/docs/analyze` | `document-core/analyze`, 7 task |
| `POST /api/v1/docs/transform` | `document-core/transform`, 5 action |
| `POST /api/v1/docs/generate` | `document-core/generate`, 6 task |
| `POST /api/v1/docs/compare` | `document-core/compare`, 3 mode |
| `POST /api/v1/docs/workflows` | `disbursement`, `doc-compare` vào document-core; `lc-checker` vào business riêng |
| `POST /api/v1/docs/workflows/schema` | Schema pin theo tenant/revision, thực thi `document-core/schema-workflow` |
| `GET /api/v1/operations`, `GET/DELETE /api/v1/operations/:id` | Giữ query, pagination, envelope, trạng thái, ownership, soft delete |
| `POST /api/v1/operations/:id/cancel`, `/resume`; `GET .../download` | Giữ lifecycle, dữ liệu resume, nội dung và headers tải xuống |
| `GET /api/v1/services`, `/billing/balance`, `/billing/usage` | Giữ discovery, profile visibility và số liệu tương ứng với dữ liệu cũ |

Baseline phải bao gồm multipart `file`, `files[]`, `source_file`, `target_file`; `file_urls`; discriminator; default/locked parameters; prompt/connection overrides; `output_format`; `webhook_url`; `Idempotency-Key`; `?sync=true`; HTTP status, error envelope, `Operation-Location`, polling, output bytes và chi phí. So sánh theo hành vi root code, không chỉ OpenAPI hiện có.

## 3. Findings từ source hiện tại

### ORV11-01 — P0: decoder không tạo đúng input của business

- Producer: [legacy-wire-decoders.ts](../orchestrator/services/orchestrator/src/compat/legacy-wire-decoders.ts), dòng 169–175, 203–242: lấy `mode/type/task/action`, bỏ discriminator gốc, chỉ đặt `input.variant`.
- Consumer: [document-core.manifest.ts](../businesses/document-core/src/manifest/document-core.manifest.ts), dòng 124–317: ingest yêu cầu `mode`, extract yêu cầu `type`, analyze/generate yêu cầu `task`, compare yêu cầu `mode/source/target`.
- [submission.ts](../orchestrator/services/orchestrator/src/modules/operations/submission.ts), dòng 410–440: validate effective input bằng manifest; không có bước đổi `variant` lại thành các field đó.
- Probe thực thi decoder hiện tại đã xác nhận 5/6 input thiếu field bắt buộc. Với profile không bù những field này, request cũ hợp lệ bị từ chối ở admission. Profile có default còn có nguy cơ làm biến thể thực thi khác ý định client.
- Fix: adapter theo từng action, dùng đúng business DTO; test producer→manifest→worker, không chỉ test decoder tự khẳng định output `variant`.

### ORV11-02 — P0: file và output chưa đi đầy đủ tới worker

- [legacy-host-adapter.ts](../orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts), dòng 81–110: upload file rồi truyền ở `submission.artifacts`; `submission.input` giữ nguyên.
- [submission.ts](../orchestrator/services/orchestrator/src/modules/operations/submission.ts), dòng 490–500: payload của task thường chỉ là `effectiveInput`. `submit_artifacts` được lưu riêng; không chuyển thành `input.artifactIds`, `source/target`.
- [input-normalizer.ts](../businesses/document-core/src/validation/input-normalizer.ts) và [worker.ts](../businesses/document-core/src/worker.ts), dòng 1975 trở đi: business lấy file từ input artifact IDs hoặc compare sides. Top-level artifact grant không tự biến thành business input.
- Decoder giữ `file_urls` thành `input.fileUrls`, trong khi các action core không có consumer tải danh sách này. Canonical `sourceUrl` có ingestion path riêng, không thay thế được nhiều URL kèm tên/auth của legacy.
- `output_format` nằm trong `submission.output.format`, còn business normalizer đọc `input.outputFormat`; task payload hiện không chứa output DTO. Chưa có bảo đảm format client yêu cầu được thực thi.
- Fix: một bước materialize input rõ ràng cho từng action; ánh xạ thứ tự/vai trò file, multi-URL và output. Kiểm tra policy trước ghi file và cleanup upload không liên kết khi admission/replay lỗi.

### ORV11-03 — P0: polling/download legacy chưa đọc kết quả core mới

- [worker.ts](../businesses/document-core/src/worker.ts), dòng 1987–2102: 6 action ghi result envelope vào artifact rồi trả `artifact://<id>`.
- [runtime.ts](../orchestrator/services/orchestrator/src/modules/runtime/runtime.ts), dòng 934–943: hoàn thành operation bằng `result_ref`, không ghi các cột `output_content/extracted_data/output_file_path` legacy.
- [legacy-host-adapter.ts](../orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts), dòng 457–494, 527–534, 602–640: `toLegacyRow` đọc các cột cũ. Projection từ `result_ref` chỉ áp dụng khi có workflow marker. Download chỉ đọc `outputContent/outputFilePath`.
- Hậu quả: dù sửa đầu vào để core chạy thành công, polling có thể trả `SUCCEEDED` với content/data null; download không tìm thấy output. Đây là thiếu wiring, không phải thiếu route.
- Fix: projection versioned từ canonical document result/artifacts sang legacy envelope và download; bảo toàn error/usage/steps/progress và giải mã theo tenant. Dùng chung projection cho async, sync, list/detail khi cần.

### ORV11-04 — P1: sync và multipart idempotency chưa giữ hành vi cũ

- Root [submit.ts](../../lib/pipelines/submit.ts), dòng 388–405: sync enqueue rồi chờ worker tới timeout trước reload.
- Rework [legacy-http-mount.ts](../orchestrator/services/orchestrator/src/compat/legacy-http-mount.ts), dòng 283–285, 636–650: sync chỉ đổi response thành HTTP 200 sau submit/load; không chờ terminal state.
- Mỗi request core upload file mới trước khi replay được kiểm tra. [artifacts.ts](../orchestrator/services/orchestrator/src/modules/artifacts/artifacts.ts), dòng 361 tạo UUID mới; host chỉ truyền artifactId/role. [hashing.ts](../orchestrator/packages/contracts/src/hashing.ts), dòng 24–25 dùng artifactId khi không có sha256. Request multipart giống hệt với cùng key có thể thành `IDEMPOTENCY_CONFLICT` vì UUID khác.
- Fix: bounded wait như contract legacy; hash ổn định theo nội dung/vai trò file trước side effects; replay không tạo blob/operation/provider charge mới. Giữ behavior timeout `200 + done:false` nếu đúng baseline.

### ORV11-05 — P1: callback và service discovery còn lệch

- Root [engine.ts](../../lib/pipelines/engine.ts), dòng 428–432 gửi `{operation_id,state,done}`. Rework [webhooks.ts](../orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts), dòng 158–177 mặc định gửi `{deliveryId,eventType,operationId,state,stateVersion,occurredAt}`; không có legacy callback projector trên đường submit này.
- [legacy-http-mount.ts](../orchestrator/services/orchestrator/src/compat/legacy-http-mount.ts), dòng 895–901 trả `services: []` nếu host không có `serviceCatalogue`. Host production hiện không cấp capability này.
- Fix: pin loại wire protocol khi submit; giữ callback cũ cho client cũ, dùng contract mới trên surface mới. Discovery đọc registry và profile có quyền sử dụng, bao gồm subcase và parameter visibility.

### ORV11-06 — P0: migration không map slug thực tế và bỏ thiếu profile membership

- Root [runner.ts](../../lib/endpoints/runner.ts), dòng 180 trở đi tạo slug như `extract:invoice`; workflow tạo `workflows:lc-checker`, `workflows:schema:<slug>`.
- [ldba-03-production-adapter.cjs](../orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs), dòng 453–479, 642–647: registry map chỉ theo `action.name`, rồi lookup nguyên slug. Context provider mặc định không export `resolveBusinessAction`. Vì vậy các slug có subcase/prefix không resolve mặc định và thành `UNMAPPED_ENDPOINT`.
- [ldba-03-backfill.cjs](../orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs), dòng 580–650 tạo bindings, active pointer, name nhưng không tạo `profile_api_keys`. Destination spec/order cũng không có entity này.
- Runtime [profiles.ts](../orchestrator/services/orchestrator/src/modules/profiles/profiles.ts), dòng 400–433 bắt buộc JOIN `profile_api_keys`; không có membership thì có thể trở về mode `legacy`, bỏ qua disabled/default/locked policy đã nhập.
- Migration [0039_profile_api_keys.sql](../orchestrator/services/orchestrator/migrations/0039_profile_api_keys.sql) seed membership từ bindings có sẵn tại lúc chạy DDL. Chạy schema trước rồi importer sau không tạo membership cho các row nhập sau đó.
- Chỉ thêm membership vẫn chưa đủ: nhiều profile legacy `extract:invoice` và `extract:contract` có thể bị gộp vào cùng action `extract`, còn runtime chọn một row theo action. Cần giữ chiều subcase và precedence exact→generic, không tùy tiện chọn profile mới nhất.
- Fix: mapping endpoint/subcase/workflow riêng có version, migration membership theo cùng transaction, pin connector slots và giữ policy theo subcase. Nghiệm thu bằng request thật với chính API key cũ sau import.

### ORV11-07 — P0: importer chưa bảo toàn dữ liệu thực tế

- [ldba-03-backfill.cjs](../orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs), dòng 35–39 chỉ map `RUNNING/SUCCEEDED/FAILED`; root còn có `WAITING_USER_INPUT/CANCELLED`.
- `mapOperation`, dòng 353–429 từ chối `filesJson` không rỗng, webhook URL/timestamp và `filesDeleted=true`; không giữ idempotency mapping và createdByUserId. Chỉ nhập operation row, không tạo task/checkpoint/wait/outbox cho operation RUNNING.
- `mapFileCache`, dòng 689–748 đổi storage key thành `legacy-filecache/<id>` và để operation_id null, nhưng operation.output_file_path vẫn giữ giá trị cũ. `getBlob` tìm theo storage_key mới; cần map liên kết để download lịch sử còn hoạt động.
- `mapProfile` bỏ rateLimitPerMin/maxConcurrent; `connector_bindings` là object rỗng. AppSetting chỉ xử lý workflow schema, không thay thế đầy đủ settings AI/prompt/storage.
- Adapter identity có `migrateLegacyLocalCredentialOnLogin`, nhưng source production không có caller tới hàm này. Importer bỏ qua user chờ rehash và các assignment phụ thuộc: chưa thể kết luận tài khoản cũ đăng nhập được.
- Fix: inventory theo nhóm dữ liệu và từng trường; không bỏ row hợp lệ âm thầm. Terminal history phải đọc/download được; job đang chạy phải drain hoặc có chiến lược ownership/resume riêng; HITL cần giữ wait/schema/input. User dùng đường rehash-on-login đã nối thật hoặc quy trình reset có mapping đầy đủ. Settings/secret cần converter riêng.

### ORV11-08 — P0: chưa có đường cutover migration được kiểm chứng

- `timezoneGuardFailure` trong [ldba-03-backfill.cjs](../orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs), dòng 938–947 chặn mọi execute trừ khi dùng bypass `LDBA_ALLOW_UNVERIFIED_TIMEZONE=1`; CLI dòng 1347 cũng chặn. A1 metadata hiện không cung cấp một đường execute bình thường thay guard này.
- Importer đọc các bảng lần lượt vào bộ nhớ; [production adapter](../orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs), dòng 431–448 scan toàn bảng bằng SELECT, không có source snapshot chung tại đây.
- `applyImmutableBatch`, dòng 591–620 chỉ insert/identical; source row đổi sau lần nhập trước thành immutable conflict. Đây không phải cơ chế apply delta cho dữ liệu còn biến động.
- Với yêu cầu chuyển một lần, không cần xây CDC hai chiều. Cần chọn: snapshot ổn định + dừng ghi/drain tại cutover; hoặc snapshot ban đầu + delta có watermark/version và đối soát cuối. Phải thử trên quy mô DB thực tế, không giữ toàn bộ dữ liệu lớn trong RAM mặc định.
- Fix: chứng minh timezone nguồn, chuyển đúng timestamp và ghi receipt/checksum theo snapshot; không dùng bypass làm quy trình production. Rehearsal cả schema hiện tại + dữ liệu + blobs + auth/profile + API sau import; rollback có ranh giới dữ liệu rõ ràng.

### ORV11-09 — P1: phạm vi đọc/xóa operation core rộng hơn API key

- [legacy-host-adapter.ts](../orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts), dòng 396–416, 602–612 chỉ áp key fence khi pipeline có workflow marker: `(pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3)`.
- Operation core thông thường không có marker. Các key cùng tenant có thể đọc/list/delete operation của nhau trên surface này. Importer mặc định gom legacy vào tenant `legacy-default`, làm phạm vi này đáng chú ý khi chuyển hệ thống.
- Fix: xác định rõ ownership legacy theo key/profile; áp cùng predicate cho list/detail/download/delete/cancel/resume. Quyền quản trị tenant dùng principal riêng. Test hai key cùng tenant và hai tenant khác nhau. Không phục dựng fallback ADMIN hoặc tin body apiKeyId chưa xác thực chỉ để giống lỗi bảo mật của bản cũ.

### ORV11-10 — P1: UI chưa hoàn thành hành trình vận hành

- Có nền tảng hữu ích: global tenant, trạng thái health có freshness, overview/worker inventory, business cockpit, operation detail/trace/usage/audit, stop/retry/bulk cancel và profile keys. Đây là các implementation có thể tiếp tục phát triển.
- [settings-screen.tsx](../orchestrator/apps/admin-web/src/features/settings/settings-screen.tsx), dòng 19–27, 65–99: catalog tĩnh, Apply/Replace secret disabled, không đọc/ghi effective settings. Đơn vị vận hành vẫn phải sửa deployment ngoài UI.
- [workflows-screen.tsx](../orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx), dòng 423–468 gọi `workflow.test`; [dispatcher.ts](../orchestrator/services/orchestrator/src/modules/admin-actions/dispatcher.ts), dòng 175–176 chỉ đăng ký provision/retire. Unknown action bị 404. Simulation được gắn nhãn riêng nhưng không chứng minh backend thực thi.
- Workflow screen gắn badge `Vault Transit Encrypted` cố định (khoảng dòng 515), chưa xuất phát từ trạng thái deployment. Preset dùng tên business như connector; cần kiểm tra mapping/pins trước quảng bá “Ready To Test”.
- Operations screen có stop/retry nhưng chưa thấy operator flow resume/HITL đầy đủ. Workflow editor chủ yếu import JSON; cần mapping connector, validation và lỗi ở từng node phục vụ người vận hành.
- Fix theo hành trình ở §5, dùng capabilities/effective state thực tế. UI nên giải thích lỗi bằng việc cần làm, thay các mã task nội bộ và thông báo implementation bằng nội dung vận hành.

## 4. Kiểm chứng thực hiện trong phiên này

- Đọc root API handlers/runner/format/DB schema; compat mount/host/decoder; submit/runtime/profile/worker/manifest; importer/production context/schema migrations; admin action registry và các màn hình vận hành.
- Probe tại `/workspace/scratch/orchestrator-compat-probe.mjs`: thực thi decoder TS và lấy required-key declarations từ manifest hiện tại; tái hiện 5/6 input thiếu field. Log `/workspace/scratch/orchestrator-compat-probe.log`. Đây là boundary probe, không phải full HTTP/E2E.
- Chạy 3 suite Node: `ldba-03-runner-skip.test.cjs`, `ldba-03-backfill-offline.test.cjs`, `ldba-03-production-adapter.test.cjs`.
- Lượt đầu: 43 test, 23 pass, 20 fail; 6 fail do workspace thiếu `pg`, 14 fail tại timezone guard. Đã cài riêng `pg@8.12.0` trong scratch, không thay manifest/lockfile của repo.
- Lượt sau với `NODE_PATH=/workspace/scratch/orchestrator-review-deps/node_modules`: **43 test, 29 pass, 14 fail, 0 skipped, exit 1**. Các failure còn lại nhận `BLOCKED_TIMEZONE_UNVERIFIED` trước các nhánh mà fixture muốn kiểm tra. Log `/workspace/scratch/orchestrator-review-ldba-tests-with-pg.log`. Không tắt guard để báo test xanh.
- Node của môi trường là `v24.19.0`, thấp hơn engines `>=24.21.0 <25` của repo. Kết quả trên là diagnostic; cần chạy lại runtime được hỗ trợ khi thực hiện plan.
- Chưa có DB legacy/production, object store hoặc snapshot khách hàng; chưa chạy full stack/provider/browser. Do đó không kết luận có bao nhiêu row thực tế sẽ bị chặn, không xác nhận chất lượng hiển thị/responsive hay performance production.
- Receipt LDBA-09 ngày 09/10 dùng schema/fixture lịch sử, có skip và negative test chủ đích. Không dùng receipt đó để chứng nhận importer hiện tại chuyển đầy đủ DB khách hàng.

## 5. Plan cập nhật và acceptance

Các ID ORV11 là nhãn review mới, gắn vào các nhóm COMP/WFA/LDBA/CFGADM/AOPS hiện có; không thay thế board hoặc tự đánh dấu các task cũ đã hoàn thành. Vai trò trong bảng là đề xuất phân công, chưa phải dispatch.

| Giai đoạn | Packet / phạm vi | Deliverable | Acceptance |
|---|---|---|---|
| 0 | ORV11-P00 · COMP/WFA/LDBA; owner API + data | Chốt legacy contract theo root commit, 31 variants, workflows, lifecycle; inventory schema/data/blob/settings/keys; phân biệt behavior cần giữ và security fix | Golden fixtures có HTTP/status/headers/body/files/callback; map từng field và từng nhóm dữ liệu; mọi thay đổi bắt client sửa phải ghi rõ |
| 1A | ORV11-P01 · COMP; owner compat + document-core | Sửa ORV11-01/02, giữ exact/generic profile precedence | 31 variants đi qua HTTP thật → submit → worker; file/URL/compare/output đúng; profile locked/default/disabled và secret không bị bỏ qua |
| 1B | ORV11-P02 · COMP/runtime; sau input contract | Result projector + sync + content-stable replay + callback/discovery + ownership | Submit/poll/download/callback khớp legacy; cùng multipart/key replay cùng operation, không thêm charge/blob; sync chờ đúng budget; same-tenant foreign-key và cross-tenant denied |
| 1C | ORV11-P03 · WFA; owner workflow business/runtime | Named + schema workflows, legacy input/override compatibility, HITL/resume | disbursement/doc-compare/lc-checker và schema thực tế chạy đủ happy/failure/cancel/restart/HITL; pin cũ không đổi khi publish revision mới; import unsupported feature báo trước khi execute |
| 2A | ORV11-P04 · LDBA; owner data + profile/identity | Slug/subcase mapping; membership/pins; user/assignments/settings; artifact links/history; xử lý omissions | API key cũ giữ hash và gọi đúng policy; IDs lịch sử giữ nguyên; output hash/download và số liệu usage khớp; disabled endpoint vẫn disabled; user đăng nhập đúng quyền |
| 2B | ORV11-P05 · LDBA/DEP; sau 2A | Timezone evidence, bounded batch, snapshot/cutover/drain/delta nếu cần; rehearsal + rollback | Chạy trên DB clone đúng phiên bản và dữ liệu đại diện; ledger đầy đủ read/import/reject/skip/conflict; không có row mất không giải thích; rerun an toàn; đo thời gian/RAM/DB locks; thử rollback |
| 3A | ORV11-P06 · CFGADM/AOPS; owner admin API + UI | Settings có effective value/revision, diff/test/save/apply/rollback; workflow.test backend; mapping/publish/test/poll/HITL UI | Save/reload/restart giữ giá trị; backend execution tạo operation và kết quả thật; UI phản ánh unavailable/stale/partial/denied; quyền/audit đúng |
| 3B | ORV11-P07 · AOPS; owner UI/runtime | Ca trực: health → queue/worker → operation/trace → connector → xử lý → audit; migration dashboard/readiness | Người vận hành xác định và xử lý lỗi không cần đoán mã task hay sửa JSON thường xuyên; có resume và callback retry an toàn; không retry mù invocation UNKNOWN |
| 4 | ORV11-P08 · verification độc lập | Regression old-client → new stack + migration rehearsal + browser journeys đúng build | Tester khác implementation owner; không skip acceptance bắt buộc; raw log/build hash/test data manifest; reviewer UI/backend độc lập; đủ bằng chứng mới quyết định cutover |

Thứ tự quan trọng: chốt contract → sửa input/profile/output → chứng minh request cũ chạy đúng → hoàn thiện data import → rehearsal → cutover. UI có thể được triển khai song song sau khi API contract của từng màn hình đã ổn định. Chưa nên thêm API mới lớn trước khi đóng các lỗi P0 này.

### Hành trình UI cần nghiệm thu

1. Cấu hình business/connector/profile/key → gọi thử API legacy → xem output/download/cost; lỗi config dẫn thẳng tới nơi sửa, không gửi operator tìm ID thủ công.
2. Ca trực phát hiện queue già/worker thiếu → mở business/operation bị ảnh hưởng trong tối đa 3 lần điều hướng → xử lý theo quyền → kiểm audit.
3. Workflow import → map connectors và quyền egress → validate → publish → upload/test → polling → human approval/resume → kết quả. Simulation luôn tách khỏi execution.
4. Lỗi provider/callback → trace/correlation → xem failed/unknown/partial → reconcile/retry theo khả năng backend, hiển thị kết quả từng mục.
5. Settings/secret revision → diff/test/apply → observed effective state → rollback; operation cũ tiếp tục dùng snapshot đã pin.
6. Kiểm tra role viewer/operator/admin, scope tenant, hết phiên, backend mất kết nối; keyboard, focus, long text, pagination, desktop/tablet/mobile. Chỉ kết luận UI thuận tiện sau chạy những hành trình này với người vận hành hoặc reviewer độc lập.

### Runbook chuyển dữ liệu một lần

Lệnh, biến môi trường, định dạng bằng chứng timezone và connector mapping hiện tại nằm trong [ORV11-DATA handoff/runbook](../coordination/reports/orv11-data.md#concrete-one-time-migration-runbook). Chỉ trạng thái APPLIED của importer không phải cutover-ready; đối chiếu kiểm thử độc lập trong execution ledger.

1. Inventory DB/blob/timezone/key/user/config và các tích hợp trực tiếp DB nếu có. Không cấp worker mới quyền ghi bảng legacy.
2. Backup + thử restore; chốt source snapshot và mapping phiên bản. Dựng target cô lập với đủ migrations Orchestrator/Connector hiện tại.
3. Import bản sao; đối soát per-table/per-state/per-profile counts, tiền/token, IDs, deleted state, schema/prompt revision, file hashes và API history/download. Mọi skip phải được giải trình.
4. Chạy các client contract fixtures bằng API key cũ trên target; đo thông lượng và thời gian migration/cutover bằng dữ liệu gần production.
5. Trước cutover dừng nhận job mới ở legacy, drain job đang chạy; xử lý riêng WAITING_USER_INPUT dài hạn. Chốt quyền sở hữu callback/job để không xử lý hai lần. Lấy snapshot cuối hoặc apply delta có version nếu giai đoạn copy trước đó còn writes.
6. Đối soát cuối rồi chuyển ingress; smoke submit/poll/download/workflow/resume/auth/profile. Giữ legacy read-only trong cửa sổ rollback.
7. Rollback sau khi hệ mới đã nhận writes phải giữ nhật ký/dữ liệu phát sinh và có phương án reconcile; chỉ chuyển DNS về DB snapshot cũ sẽ làm mất operations mới. Chốt điểm rollback an toàn trước rehearsal.

Cutover chỉ nên được duyệt khi các P0 đã sửa và được kiểm chứng độc lập, contract suite đầy đủ xanh, migration không còn omissions ảnh hưởng khách hàng, historical download/login/policy hoạt động và operator journeys đã được review trên đúng build.

## 6. Phần còn lại sau đợt bổ sung Admin ORV13

Đợt ORV13 sửa các finding trong [review Admin](../coordination/reports/orv13-ui-review.md) và bổ sung adapter cho môi trường Docker Compose người dùng đã chọn. Trạng thái code/kiểm thử/review từng packet nằm trong [execution ledger](../coordination/ORV13-ADMIN-UI-EXECUTION-2026-10-11.md); các hạng mục dưới đây giữ mở theo plan gốc, không suy ra hoàn tất từ các màn hình mới. Đây là backlog có acceptance cụ thể, chưa phải dispatch mới.

| Hạng mục | Cập nhật cần tiếp tục | Acceptance để đóng |
|---|---|---|
| Full global settings/CFGADM parity | Map đủ17 settings legacy tới consumer, native revision/effective configuration và form chỉnh sửa; giá trị nhạy cảm dùng secret refs; nối apply với consumer/approved release | Save/reload/restart đúng consumer, revision/diff/audit và rollback; operation đã pin không đổi; kiểm tra từng setting với client/data cũ |
| Rich COST và ngân sách | Thu thập invocation/attempt/step/connector/price provenance thật; lưu cấu hình budget và nối UI với admission/settlement thực tế | Đối soát event→reservation→settlement→summary, không cộng trùng, đo trạng thái unpriced/pending, RBAC/tenant/audit, budget được lưu và thực thi |
| Incident lifecycle | Thêm persisted incident, owner/ack/resolve và audit; chuyển tín hiệu triage hiện có vào cơ chế quản lý incident thật | Hành trình phát hiện→nhận xử lý→khắc phục→đóng→audit trên dữ liệu thật; CAS/quyền và dedup không mất lịch sử |
| Queue/process control và bảo trì dữ liệu | Adapter riêng cho queue pause/drain, backup/restore/cleanup với preview, durable job, kết quả từng mục và guard dữ liệu | Side effects thực tế, không ảnh hưởng tenant/stack khác; lỗi/partial/UNKNOWN và khôi phục có bằng chứng; không dùng Compose app rollback để suy ra DB rollback |
| Workflow XML legacy | Converter hỗ trợ rõ subset và validation trước publish; hiện editor hỗ trợ JSON | Golden XML legacy→immutable revision→execution/HITL/result, unsupported nodes báo trước khi tạo job |
| Availability và customer cutover | Hai replica/lease-safe rollout, backup-restore rehearsal, dữ liệu/credentials/provider khách hàng và ingress production | Chứng minh downtime/lease behavior, dữ liệu/history/download/login/API cũ, counts/hash/timezone và rollback boundary; quyết định cutover dựa trên receipt customer |

Single-server Compose runner hiện chỉ thao tác application services/release được phê duyệt trong manifest. Không coi deploy/restart/rollback application là chứng minh không gián đoạn, đổi cấu hình toàn hệ thống, chuyển DB hoặc rollback dữ liệu. Lệnh/cấu hình/hạn chế vận hành nằm trong [host runbook](../docs/41-compose-operations-host-runbook.md).
