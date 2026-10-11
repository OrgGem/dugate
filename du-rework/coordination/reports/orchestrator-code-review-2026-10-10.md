# Orchestrator processing code review — 2026-10-10

Review trên working tree tại `d0b22104e3f9fcda095bc75c9588fac8afac38f3`, có nhiều thay đổi chưa commit. Kết luận dựa trên source và probe thực thi, không lấy tài liệu/spec hoặc báo cáo cũ làm bằng chứng hành vi.

**Kết quả: 7 finding mới (5 P1, 2 P2), cộng 3 finding Orchestrator đã nêu ở lượt review trước. Chưa sửa hoặc accept finding nào.** Finding scheduler Connector CR10-02 nằm ngoài phạm vi báo cáo này.

## Phạm vi và giới hạn

Rà các đường xử lý bootstrap/HTTP/auth, admission và profile pinning, ingestion, operation lifecycle/retry, queue/worker runtime, invocation grants, artifact/storage/encryption, callback, usage/quota, admin actions và idempotency. Đọc consumer liên quan khi cần xác định dữ liệu producer có được dùng đúng hay không.

Đây là review luồng backend, không phải xác nhận từng dòng của toàn bộ service, audit giao diện admin, hoặc kiểm chứng deployment end-to-end. Các module không có finding dưới đây không được mặc nhiên coi là đã chứng minh không có lỗi. Probe dùng dữ liệu tổng hợp và DB/fetch/repository giả trừ phép kiểm tra encoding bằng PostgreSQL 16 được ghi rõ. Không gọi dịch vụ AI hoặc gửi credential thật.

## Finding mới

### OR10-01 — P1: Source credential không bị ràng buộc với origin đã được phê duyệt

- Vị trí: [acquisition-ref-resolver.ts:278](../../orchestrator/services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts#L278), đoạn 262–285.
- Caller được phép dùng profile có bearer/header credential có thể submit `sourceUrl` đến một HTTPS origin công khai do họ kiểm soát. `validateSourceUrl` chỉ kiểm tra URL/egress; không kiểm tra origin được phép nhận credential.
- [ingestion-consumer.ts:577](../../orchestrator/services/orchestrator/src/modules/operations/ingestion-consumer.ts#L577) resolve credential theo operation/tenant rồi bọc fetcher. `withSourceAuth` chọn chính origin của request đầu tiên làm origin tin cậy và gắn secret vào request đó.
- Vì vậy public API key có thể dùng luồng ingestion để lấy credential của profile. Kiểm tra IP riêng và bỏ auth khi redirect sang origin khác không ngăn được request đầu tiên đến origin của caller.
- Probe gọi `validateSourceUrl` rồi `withSourceAuth` với URL tổng hợp `https://attacker.example/source.pdf`: URL được chấp nhận và fetch stub nhận bearer tổng hợp. Wiring production có tại `create-app.ts:642,676`. Chưa thực hiện HTTP end-to-end qua S3.
- Hướng sửa: pin origin/allowlist được admin cấu hình cùng credential; xác thực URL đầu tiên trước khi gắn auth, tiếp tục bảo vệ từng redirect.
- Regression cần có: profile credential hợp lệ + public API caller + origin ngoài allowlist phải bị từ chối trước khi gửi request có auth.

### OR10-02 — P1: Request đang đọc session có thể khôi phục session đã logout/revoke

- Vị trí: [session-store.ts:175](../../orchestrator/services/orchestrator/src/modules/auth/session-store.ts#L175), đoạn 175–184.
- `get()` đọc record rồi `repo.set(touched)` vô điều kiện. `destroy()` xóa record tại dòng 223. Redis adapter cũng dùng SET không có điều kiện tồn tại/CAS (`redis-session-repository.ts:149–157`).
- Interleaving: request A đọc session; logout B xóa session thành công; A ghi lại bản đã đọc. Session ID cũ lại có hiệu lực, làm mất tác dụng thu hồi.
- Probe trì hoãn thao tác touch trong repository: delete hoàn tất rồi release touch; record xuất hiện trở lại. Probe chạy session-store thật với repository kiểm soát thứ tự, chưa chạy race trên Redis nhiều replica.
- Hướng sửa: touch nguyên tử chỉ cập nhật session còn tồn tại và cùng generation; revoke/rotate cần không cho snapshot cũ ghi lại session.
- Regression cần có: `get` đồng thời với destroy/revoke/rotate; session cũ không được tái xuất hiện sau thao tác thu hồi.

### OR10-03 — P1: Replay delivery ID vượt qua kiểm tra worker đang giữ lease

- Vị trí: [runtime.ts:593](../../orchestrator/services/orchestrator/src/modules/runtime/runtime.ts#L593), đoạn 593–603.
- Khi `last_delivery_id === deliveryId`, `claimTask` trả claim ngay trước kiểm tra `leased_by` và hạn lease. Worker B cùng business dùng lại delivery ID của worker A nhận được cùng lease epoch đang còn hiệu lực.
- Probe với task RUNNING, worker A giữ lease epoch 7 chưa hết hạn: worker B claim cùng delivery ID vẫn nhận epoch 7.
- Hai worker có thể tiếp tục xử lý cùng task với cùng fencing epoch; kiểm tra epoch ở heartbeat/complete không phân biệt được hai chủ thể này. Điều kiện cần là cùng business authorization, không phải caller public chưa xác thực.
- Hướng sửa: chỉ replay claim cho đúng worker sở hữu lease hợp lệ; khi takeover phải áp dụng chuyển trạng thái và tăng epoch.
- Regression cần có: cùng delivery ID, khác worker; replay sau hết lease; replay khi task đang đợi input/children.

### OR10-04 — P1: Retry workflow làm mất schema snapshot của task gốc

- Vị trí: [retry.ts:69](../../orchestrator/services/orchestrator/src/modules/operations/retry.ts#L69).
- Submission tạo task payload `{ input, legacyWorkflowSchema }` (`submission.ts:493–499`). Retry đọc task gốc nhưng dựng payload mới chỉ từ `operations.input_ref`, hoặc `{input,sourceUrl,ingestionState}`.
- Consumer `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:360–361` yêu cầu `legacyWorkflowSchema`; thiếu trường này gây `LEGACY_WORKFLOW_SNAPSHOT_MISSING`.
- Probe retry một schema-workflow FAILED có snapshot: payload task mới là input thuần và không còn pin. Retry được tạo nhưng không giữ đủ dữ liệu để chạy workflow.
- INSERT operation mới tại dòng 74–80 cũng không sao chép `endpoint_slug`/`pipeline_json`; cần kiểm tra thêm các nhánh named workflow phụ thuộc chúng, chưa tính thành finding riêng.
- Hướng sửa: dựng retry từ payload/snapshot bất biến của execution gốc và re-seal theo ID mới; không resolve schema hiện hành thay cho pin gốc.
- Regression cần có: submit workflow → failed → retry → worker đọc được đúng snapshot ban đầu, kể cả schema hiện hành đã đổi.

### OR10-05 — P1: Download URL của artifact có storage key phân cấp luôn tra sai key

- Vị trí: [runtime.ts:274](../../orchestrator/services/orchestrator/src/http/routes/runtime.ts#L274).
- `artifacts.ts:1352` dùng `encodeURIComponent(storageKey)` để tạo blob URL. Route lấy segment regex rồi tra DB nguyên chuỗi, không `decodeURIComponent`.
- Ingestion tạo key `du/tenants/<tenant>/operations/<operation>/source` (`ingestion-consumer.ts:221–222`). URL chứa `%2F`; DB chứa `/`. Bootstrap chuyển `url.pathname` vào route nguyên dạng, vì vậy lookup không tìm thấy artifact.
- Probe gọi route thật với URL encoded đúng cách: DB nhận `du%2Ftenants%2Ftenant-a%2Foperations%2Foperation-a%2Fsource`; route trả 404. Đây là probe route/lookup với DB stub, không phải lượt download S3 thật.
- Hướng sửa: decode segment đúng một lần, xử lý escape không hợp lệ và dùng cùng decoded key cho lookup/read/write/decrypt.
- Regression cần có: requestAccess → dùng chính downloadUrl được trả về → đọc artifact có key chứa `/`, `%`, Unicode.

### OR10-06 — P2: Idempotency replay của admin bỏ qua resource tenant authorization

- Vị trí: [dispatcher.ts:492](../../orchestrator/services/orchestrator/src/modules/admin-actions/dispatcher.ts#L492), cùng cấu hình key/hash dòng 399–402.
- Key là global; hash chỉ gồm action/params, không gồm tenant/principal. `executeIdempotent` trả marker sẵn có tại `idempotency.ts:123–124` trước khi callback work kiểm tra tenant của operation.
- Probe `operations.cancel`: marker thuộc tenant A; caller operator tenant B có cùng key và params nhận 200 cùng body operation của A, không mở transaction để thực hiện tenant fence.
- Tác động đã chứng minh là replay kết quả ngoài tenant và phản hồi thành công sai quyền. Không chứng minh caller B thực hiện được mutation mới trên operation A. Cần biết/trùng key và payload; vì vậy xếp P2.
- Hướng sửa: scope marker theo principal/tenant và giữ kiểm tra resource authorization trên cả replay path.
- Regression cần có: marker của A + caller B cùng key/body không nhận response của A; replay sau khi quyền resource bị thu hồi cũng bị từ chối.

### OR10-07 — P2: Advisory lock quota truyền NUL vào PostgreSQL text

- Vị trí: [budget-reservations.ts:218](../../orchestrator/services/orchestrator/src/modules/usage/budget-reservations.ts#L218).
- Lock key nối scope/window bằng `\u0000`, rồi truyền cho `hashtextextended($1,0)`. PostgreSQL text không nhận byte NUL; reserve/transition/reconcile đi qua helper này sẽ lỗi trước khi hoàn tất nghiệp vụ.
- Probe gọi `createBudgetReservationService.reserve` thật với fixture hợp lệ để lấy tham số truy vấn đầu tiên. Chuyển đúng bytes đó qua `convert_from(decode(hex,'hex'),'UTF8')` trong cùng biểu thức lock trên PostgreSQL 16: exit 1, `invalid byte sequence for encoding "UTF8": 0x00`.
- PostgreSQL được chạy trong container riêng, network none, không port/host mount, data tmpfs. Đã xóa container sau probe. Đây là kiểm chứng encoding của tham số, chưa chạy toàn bộ reserve transaction qua node-postgres.
- Các test hiện tại dùng fake query bỏ qua parser SQL. Chưa tìm thấy caller HTTP production của budgetReservations; xếp P2 cho đường service này, không kết luận quota hiện hành toàn hệ thống đã ngừng hoạt động.
- Hướng sửa: hash/encode tuple thành chuỗi không chứa NUL hoặc thành khóa bigint trước khi gửi DB; giữ tính phân biệt tuple.
- Regression cần có: reserve và reconcile chạy qua PostgreSQL thật, cùng kiểm tra concurrent admission.

## Ba finding Orchestrator của lượt trước vẫn còn trong source

Các finding này đã nằm trong [CODE-REVIEW-FOLLOWUP-2026-10-10.md](../../tasks/CODE-REVIEW-FOLLOWUP-2026-10-10.md); không tạo ID trùng.

| ID | Mức | Vấn đề và bằng chứng |
|---|---|---|
| CR10-01 | P1 | `main.ts:233` bắt buộc load context provider; default tại `create-app.ts:157` là `scripts/ldba-context-provider.cjs`, nhưng `scripts/docker/build-runtime.cjs:82` chỉ package `dist,migrations`. Default image thiếu file, boot ném lỗi. Kết luận dựa đường packaging; chưa build/boot image trong review này. Cấu hình module ngoài mặc định có thể tránh nhánh này. |
| CR10-03 | P1 | `oauth2-client.ts:390` hủy timeout trước `response.text()` dòng 405; byte cap kiểm sau khi đọc xong. Probe timeout 20ms vẫn pending sau 100ms, signal chưa abort; cap 64 bytes vẫn đọc 1 MiB rồi mới từ chối. Callback có thể treo hoặc giữ body lớn. |
| CR10-04 | P1 | OAuth2 token URL hostname qua schema ở trạng thái cần DNS resolution, nhưng client dùng global fetch mà không giải quyết/pin IP theo egress policy. Probe schema chấp nhận hostname rồi đi tới default fetch stub. Khi callback OAuth2 và secret resolver được cấu hình, hostname trỏ private IP có thể đi ra ngoài egress policy. Chưa thực hiện request đến private network. |

## Kiểm chứng

- CWD service: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`: exit 0.
- `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/admin-idempotency.test.ts tests/session-store.test.ts tests/redis-session-repository.test.ts tests/cb02c-retry-callback-pin.test.ts tests/grant-artifact-pins.test.ts tests/budget-reservations.test.ts tests/mm10-claim-cancel-flag-offline.test.ts`: 7 suites, 129 tests passed, 14.587s, exit 0. Jest có cảnh báo open handles sau chạy; không tính cảnh báo này thành lỗi chức năng mới.
- Probe bổ sung chạy hàm TypeScript hiện tại bằng transpile in-memory, không sửa product code hoặc thêm test vào suite. Test pass không bao phủ các interleaving và producer/consumer mismatch đã nêu.
- Chưa chạy full test suite, load test nhiều replica, browser audit, hoặc deployment E2E. Không tuyên bố release-ready.

Ưu tiên xử lý: chặn lộ source credential và session resurrection; sửa lease ownership, retry snapshot, artifact URL; sau đó xử lý replay scope/quota SQL và các finding boot/OAuth2 đã có. Mỗi fix cần regression và kiểm chứng độc lập trước khi đóng finding.
