# Kế hoạch sửa kết nối business worker với orchestrator

Mục tiêu là bảo đảm task tiếp tục được thực thi sau pause/resume, yield, mất kết nối và rollout nhiều phiên bản, đồng thời giữ server fencing và kết quả Connector đã được ghi nhận. Plan xử lý tám finding của review source ngày 2026-10-12 và yêu cầu business/version, profile, endpoint/workflow, connector được người dùng làm rõ tại mục 9; không mở rộng sang tái thiết kế auth key.

- Repo scope: `D:/Git/dugate/du-rework`; không sửa legacy root.
- Baseline: branch `codex/fix-workflow-builder`, commit `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`.
- Canonical plan: `coordination/PLAN-WORKER-ORCHESTRATOR-2026-10-12.md`.
- Intake: [PLAN-OPEN mục 20](PLAN-OPEN-2026-10-09.md#20-plan-worker-orchestrator--2026-10-12).
- Trạng thái: **IMPLEMENTATION IN PROGRESS** theo yêu cầu người dùng ngày 2026-10-12; chưa VERIFIED/ACCEPTED. Trạng thái và ownership hiện tại ghi tại [Codex execution](WOC-CODEX-EXECUTION-2026-10-12.md).
- **Authority mới 2026-10-12:** người dùng yêu cầu chỉ dùng luồng Codex, backup và thay AGENTS cũ, giữ worker Luna max. Primary Codex giao việc bằng collaboration tools và tổng hợp evidence; không phụ thuộc Claude dispatcher, Orca, scheduler hoặc gates điều phối cũ. Các đề cập dispatcher/roster bên dưới áp dụng cho primary và live subagents của Codex; coordinator contract cũ là lịch sử.

## 1. Quyết định giữ nguyên auth key

Người dùng xác nhận ngày 2026-10-12: thiết kế auth key trùng giữa các business worker có ý đồ riêng và tạm thời giữ nguyên.

Toàn bộ task phải giữ cách cấp, chia sẻ, mapping và xác thực auth key hiện tại. Không thêm yêu cầu mỗi business/replica có key riêng, không thêm kiểm tra cấm key trùng, không đổi token format, rotate/revoke, credential provisioning, Vault policy hoặc cấu hình auth. Không thêm cơ chế authentication thứ hai. Các kiểm tra business/version trong execution dùng manifest, worker instance đã đăng ký và task snapshot; không chuyển thành thay đổi mô hình key.

Auth key và checkpoint/grant key là hai khái niệm khác nhau. Plan cũng chưa thay định dạng checkpoint/grant key, branch marker hoặc cách grant authorization dựng identity của Document Core. Khuyến nghị chuẩn hóa định dạng này từ review trước được **DEFERRED**, không là prerequisite hay acceptance hold của đợt sửa này. Test bảo vệ authorization hiện có được giữ; không thêm giả định key phải khác nhau.

## 2. Finding và phạm vi bằng chứng

| Finding | Mức | Source baseline | Task sửa |
| --- | --- | --- | --- |
| SDK ACK thành công với mọi claim 409, gồm admission tạm đóng | P1 | `orchestrator/packages/worker-sdk/src/worker.ts:365`; runtime claim `runtime.ts:640,657,662` | WOC-01 |
| Yield giữ lease cũ khi parent được resume/join | P1 | `runtime.ts:1313,1475,1640,2114` | WOC-02 |
| Delivery thiếu transport retry; recovery coi failed/completed job là sống và bỏ continuation | P1 | queue `dispatcher.ts:121`; `runtime.ts:106,1913` | WOC-03 |
| Handler dùng queue kind; claim chưa ràng buộc execution version với worker | P1 | SDK `worker.ts:375`; contracts `runtime.ts:55`; runtime `runtime.ts:651` | WOC-04 |
| Timeout không bao phủ body; parse JSON làm mất ambiguous write outcome | P1 | SDK `runtime-client.ts:145,148,149,155` | WOC-05 |
| Thiếu local watchdog theo hạn lease | P2 | SDK `worker.ts:454`; `task-context.ts:402` | WOC-06 |
| ACK thêm backupEffectFence bắt buộc trên cùng wire v1 | P2 | contracts `runtime.ts:43`; `docs/05-business-registry.md:64` | WOC-07 |
| Vendored SDK template phân loại INVOCATION_UNKNOWN khác canonical | P2 | canonical SDK `worker.ts:632`; template vendor SDK `worker.ts:526` | WOC-08 |

Các path `runtime.ts` trong bảng, trừ khi ghi contracts/SDK, thuộc `orchestrator/services/orchestrator/src/modules/runtime/`. Đây là line tại baseline; owner phải đối chiếu lại SHA trước sửa.

Baseline offline: sáu suite source-mapped có 89 pass / 19 fail; năm probe bổ sung có 5 pass. Source-mapped tắt ts-jest diagnostics nên không chứng minh typecheck/build. Test mặc định dùng dist chưa khớp declarations và dừng trước khi chạy. Các lỗi suite gồm mười ACK fixture thiếu trường, một expectation INVOCATION_UNKNOWN cũ và tám DB fixture chưa mô hình hóa runtime controls. Không tính chúng thành 19 production bug.

Receipt hiện có: `C:/Users/Gem/AppData/Local/Temp/du-rework-source-route-591d8e1dce2c4eb0a80e928219c0b465/verification-summary.md`; raw observations ở `source-probe-results.json` cùng thư mục. Đây là evidence tạm local, chưa là receipt đóng task. Probe heartbeat chưa vượt lease expiry; WOC-06 phải kiểm chứng tình huống đó riêng. Chưa có live multi-replica E2E cho bản sửa.

## 3. Contract và tiêu chí xuyên suốt

**PostgreSQL giữ trạng thái task, lease và intent delivery.** BullMQ cung cấp vận chuyển có thể lặp. Job hoàn tất không đủ chứng minh task hoàn tất; mất job không được làm mất task runnable. Retry vận chuyển và retry nghiệp vụ có budget riêng: chưa claim được task thì không tăng attempt nghiệp vụ.

**Queue payload không quyết định execution.** Handler, business version và manifest compatibility phải dựa trên snapshot đã pin và instance đã đăng ký. Image digest phục vụ provenance triển khai; không thay thế manifest/version compatibility.

**Claim refusal có outcome rõ ràng.** Terminal hoặc delivery đã được chứng minh stale có thể ACK; pause/drain/chưa đăng ký/version chưa có consumer phù hợp phải giữ delivery hoặc ghi recovery intent bền vững. Live foreign lease chỉ cho phép ACK khi có bằng chứng một execution hợp lệ đang sở hữu task và mọi đường yield/expire đều có recovery. Không phân loại chỉ bằng HTTP status.

**Lease loss và cancellation có ý nghĩa khác nhau.** Abort local vì hết lease phải dừng việc mới và mọi ghi stale bị server fence, nhưng không tự gửi terminal cancel cho logical Connector invocation. Kết quả chưa xác định phải reconcile theo ID/checkpoint cũ, không tạo provider invocation mới.

## 4. Các task thực thi

Mỗi task có implementation owner và tester/reviewer độc lập do dispatcher chọn sau kiểm live roster. Owner cập nhật contract/docs cùng source; tester ghi receipt riêng. Không task nào được ACCEPTED chỉ từ owner smoke.

### WOC-00 Chốt contract và khôi phục baseline kiểm thử

Dependency: không. Owner: PENDING. Lease đề xuất: `orchestrator/packages/contracts/src/runtime.ts`, các file contract được liệt kê bổ sung trước dispatch; fixture/test đang lỗi của SDK và orchestrator; docs Runtime/SDK và inventory liên quan. Handoff source lease contracts trước WOC-01/07.

Chốt bảng claim outcomes, delivery retry budget, lease/yield transitions và ma trận capability/rollout cho backup fence. Tái dùng field/code hiện có nếu đủ; mọi DTO bắt buộc mới phải tuân thủ quy tắc major contract và rollout song song. Không đổi wire chỉ để che lỗi fixture.

Executor build dependencies theo graph hiện có, bắt đầu contracts, rồi chạy typecheck và sáu suite baseline bằng cấu hình package thông thường. Cập nhật fixture ACK hiện tại và SQL mock chính xác; giữ ca ACK legacy riêng để kiểm compatibility. Không tắt diagnostics làm tiêu chí nghiệm thu. Tách lỗi fixture khỏi regression sản phẩm; các ca mới tái hiện finding được phép đỏ trước fix và phải gắn ID.

Acceptance: contract/state matrix rõ producer và consumer; build/typecheck baseline hoặc blocker thực có raw evidence; không còn failure do dist cũ hay fixture cũ che khuất test; audit diff xác nhận không chạm auth key. Receipt: `coordination/reports/receipt-woc-00.md`.

### WOC-01 Giữ delivery khi admission tạm đóng

Dependency: WOC-00 contract. Owner: PENDING. Lease đề xuất: SDK `src/worker.ts`; runtime claim/error mapping và route/schema chỉ khi contract cần sửa, kê exact file trước dispatch. Các path SDK/runtime dùng chung phải serialize với WOC-02/04/06/07.

Thay nhánh mọi 409 đều ACK bằng quyết định theo code/outcome. Pause/drain/unregistered phải chờ hoặc chuyển sang delivery delayed/retry có recovery intent; không giữ lease task, không tăng business attempt và không busy-loop. Chỉ throw về BullMQ khi retry policy WOC-03 đã bảo đảm redelivery. Job đang active bị shutdown trong lúc chờ vẫn có đường phục hồi.

Acceptance: enqueue rồi tenant pause trước claim; drain replica trước heartbeat tiếp theo; register/resume chậm; shutdown khi đang chờ. Với mỗi ca, handler chạy 0 lần khi gate đóng, task vẫn recoverable, sau gate mở có đúng một execution hợp lệ. Terminal/stale delivery vẫn kết thúc sạch, không retry vô hạn. Receipt: `coordination/reports/receipt-woc-01.md`.

Independent core review bổ sung P1 local single-flight: cùng instance nhận lại original job khi Runtime lease vẫn sống có thể nhận same-owner replay và chạy handler lần hai. SDK phải guard theo task/lease từ trước handler start tới handler settlement, kể cả stalled/redelivery concurrency > 1; giữ server replay cần cho lost claim ACK. Guard không chỉ nhìn promise/context count tổng và không được release sớm khi handler không hợp tác với AbortSignal.

### WOC-02 Kết thúc lease khi yield và tạo continuation an toàn

Dependency: WOC-00; chạy cùng đợt WOC-01 nhưng tránh chung file lease. Owner: PENDING. Lease đề xuất: runtime `runtime.ts`, lease/yield tests.

Trong transaction spawn/wait, xóa `leased_by` và `lease_expires_at`; fence epoch theo contract để writer của execution đã yield không thể tiếp tục ghi. Giữ replay idempotent của spawn/wait bằng kết quả bền vững, không mở lại quyền ghi cho token cũ. Join/resume tạo một intent continuation và đưa parent runnable mà không mang foreign lease cũ. Không reset budget nghiệp vụ ngoài quy tắc đang có.

Acceptance: replica A yield, child hoàn tất hoặc input resume ngay, replica B claim ngay mà không phải đợi lease cũ; duplicate spawn/wait/join/resume không nhân child hoặc continuation; write từ A sau yield bị fence; stale delivery không đánh thức task đang WAITING. Receipt: `coordination/reports/receipt-woc-02.md`.

### WOC-03 Retry vận chuyển và recovery từ durable task state

Dependency: WOC-00; tích hợp WOC-01/02 trước đóng task. Owner: PENDING. Lease đề xuất: queue `dispatcher.ts`, runtime `runtime.ts`, queue factory trong bootstrap nếu cần, queue integrity tests. Bootstrap lease phải kiểm với lane khác trước dispatch.

Cấu hình bounded attempts/backoff/jitter cho transport trước claim; phân biệt admission deferred và business failure. Recovery bao phủ dispatch và continuation/resume đang dùng, kiểm actual job state thay vì chỉ `getJob != null`. Chỉ recover task runnable không có valid lease; không đụng active handler hoặc task terminal.

Xử lý stable jobId collision bằng protocol durable: CAS xác nhận task/delivery cần phục hồi, lưu delivery generation hoặc intent thay thế rồi enqueue idempotently. Không chỉ reset `dispatched_at`, không xóa active job, không tạo delivery mới cho task đang RUNNING. Crash giữa DB/Redis phải có replay an toàn. Cap recovery có escalation và owner action rõ ràng, không âm thầm bỏ task.

Review độc lập phát hiện source recovery đã tạo delivery row ID mới nhưng payload vẫn mang deliveryId cũ; dispatcher không overwrite từ row authority. WOC-03 phải sửa producer/consumer này và regression race original claim commit sau replacement CAS. New generation envelope phải dùng actual durable row deliveryId; không đổi logical invocation/checkpoint ID. Kiểm thêm same-instance duplicate delivery với concurrency > 1 để không khởi động hai handlers dưới cùng lease.

Acceptance: claim mất mạng trước durable claim; ACK claim bị mất sau server đã lease; job missing/failed/completed; parent continuation; worker chết giữa DB và enqueue; hai sweeper đồng thời. Task runnable được chạy lại, active task không bị execute thêm, counter nghiệp vụ không tăng vì enqueue retry, cap có evidence incident. Receipt: `coordination/reports/receipt-woc-03.md`.

### WOC-04 Ràng buộc kind và version với execution snapshot

Dependency: WOC-00; SDK/runtime lease sau WOC-01/02 theo roster. Owner: PENDING. Lease đề xuất: SDK `worker.ts`, runtime claim/buildClaimResult trong `runtime.ts`, contracts runtime nếu cần, instance metadata reader nếu cần; không sửa worker identity/auth modules.

SDK chọn handler bằng kind trong claim snapshot. Server đối chiếu business/version và manifest identity cần thiết giữa task pin với worker instance đã đăng ký trước cấp lease. Payload queue sai kind/version không được điều khiển execution. Với rollout nhiều version, đưa task tới consumer tương thích hoặc giữ task pending có recovery; không ACK bỏ task, không reinterpret task cũ theo active version mới.

Acceptance: queue kind khác snapshot; replica version A nhận task pin B; thiếu manifest/instance; duplicate delivery; đổi active version khi backlog cũ còn. Kind đúng chạy, worker không tương thích không nhận execution lease, task cũ vẫn có đường chạy trên version phù hợp. Authentication vẫn theo thiết kế key hiện có. Receipt: `coordination/reports/receipt-woc-04.md`.

### WOC-05 Timeout toàn response và reconcile ambiguous write

Dependency: WOC-00; file độc lập, có thể triển khai song song WOC-01/02/03. Owner: PENDING. Lease đề xuất: SDK `runtime-client.ts`, RuntimeClient tests; xử lý ở task-context/worker chỉ sau handoff lease nếu cần.

Giữ timeout/abort tới hết đọc body và parsing; bảo đảm bounded settlement khi body treo và transport tôn trọng abort. Normalize HTTP status trước khi parse lỗi body; giữ status/code cho denial có kết luận rõ. Write có thể đã apply nhưng response body/ACK hỏng phải thành ambiguous outcome; reconcile state/checkpoint theo cùng logical ID, không báo handler failure vĩnh viễn hoặc lặp side effect mới.

Acceptance: headers tới nhưng body treo; body chậm; body stream reject; 502 HTML; 200 JSON lỗi sau write; caller abort; 401/403/409/410/429 giữ phân loại đúng; server commit rồi ACK mất. Request settle trong budget và recovery không nhân checkpoint/provider effect. Receipt: `coordination/reports/receipt-woc-05.md`.

### WOC-06 Local watchdog theo lease expiry

Dependency: WOC-00/05; SDK worker lease sau WOC-01/04/07. Owner: PENDING. Lease đề xuất: SDK `worker.ts`, `task-context.ts`, lease/abort tests; không sửa Connector cancellation protocol nếu chưa có scope bổ sung.

Theo dõi deadline từ claim và mỗi heartbeat ACK hợp lệ, dùng safety margin cho clock/network. Lỗi transport tạm thời không abort sớm khi lease còn hiệu lực, nhưng không được kéo dài deadline khi thiếu ACK. Đến deadline thì abort local và ngăn effect/ghi mới; ACK muộn không hồi sinh execution đã abort. Task terminal cũng kết thúc local handler theo outcome contract. Server epoch fencing tiếp tục là hàng bảo vệ cuối.

Acceptance: heartbeat partition vượt lease bằng clock điều khiển; renew trước deadline; ACK tới muộn; handler không hợp tác với AbortSignal; task terminal; lease loss giữa Connector call. Không write mới sau expiry, server từ chối stale writes, replica mới tiếp tục được, không phát terminal cancel cho invocation chỉ vì lease loss. Receipt: `coordination/reports/receipt-woc-06.md`.

### WOC-07 Compatibility cho heartbeat và backup fence

Dependency: WOC-00; ưu tiên chốt trước rollout SDK, hợp nhất SDK changes trước WOC-08. Owner: PENDING. Lease đề xuất: contracts `runtime.ts`, SDK `worker.ts` và `runtime-client.ts` nếu cần, runtime `worker-instances.ts`/control response và wire docs; không sửa identity credential handling.

Ưu tiên capability negotiation/extension tương thích v1. Nếu field vẫn bắt buộc làm breaking DTO thì tăng major và hỗ trợ song song theo docs, không tiếp tục gắn nhãn cùng wire tương thích. Thiếu thông tin backup fence phải UNKNOWN/không có bằng chứng an toàn, tuyệt đối không mặc định OPEN hoặc tự ACK thay worker.

Ma trận rollout phải ghi bốn cặp SDK/server cũ-mới. Cặp hỗ trợ chạy phải chứng minh admission và backup fence; cặp không hỗ trợ phải trả lỗi compatibility rõ trước claim, không crash Zod/undefined hoặc silently bypass fence. Backend được cập nhật trước; chỉ retirement backend/SDK cũ khi không còn consumer/backlog cần nó. Rollback không được hạ xuống bản bỏ qua fence khi fence đang HELD/UNKNOWN.

Acceptance: bốn cặp version; OPEN/HELD/UNKNOWN; stale observed revision; old ACK thiếu field; resume sau drain; restart/mixed replica. Không false acknowledgement; không effect mới qua fence chưa xác nhận; startup denial có code/action rõ; supported combination có receipt. Receipt: `coordination/reports/receipt-woc-07.md`.

### WOC-08 Đồng bộ template theo canonical fixes

Dependency: WOC-01/04/05/06/07 đã handoff canonical source; WOC-03 integration trước nghiệm thu toàn flow. Owner: PENDING. Lease đề xuất: `businesses/document-core/template/vendor/worker-sdk/**`, vendor contracts thực sự bị ảnh hưởng, vendor lock/provenance và template tests; kê exact changed files khi dispatch.

Đưa các fixes liên quan vào pinned template và lock theo quy trình hiện có; không làm toàn bộ redistribution/RPK và không thêm repo SDK. Với ConnectorTransportError INVOCATION_UNKNOWN, canonical và template cùng chọn reconcile/retry cùng logical invocation ID; không suy rộng finding này sang mọi wrapper nghiệp vụ. Kiểm consumer wrapper có làm mất retryability trước SDK, và sửa phần ảnh hưởng acceptance dưới lease riêng nếu xác nhận.

Acceptance: conformance vectors canonical/template cho claim refusal, heartbeat compatibility, timeout, lease expiry và INVOCATION_UNKNOWN; template build độc lập; vendor lock chỉ ra exact canonical revision; mock provider chứng minh replay không dispatch lần hai. Giữ nguyên auth config và checkpoint/grant key format. Receipt: `coordination/reports/receipt-woc-08.md`.

## 5. Thứ tự và file lease

| Đợt | Công việc | Điều kiện handoff |
| --- | --- | --- |
| 0 | WOC-00 và thiết kế compatibility WOC-07 | Chốt claim/lease/capability contract, consumer matrix và baseline fixture |
| 1 | WOC-01/02/03; WOC-05 song song ở file riêng | Delivery không mất sau pause/yield/mất mạng; recovery hữu hiệu |
| 2 | WOC-04/06/07 implementation và WOC-09/10 sau source audit | Execution đúng snapshot; handler dừng theo lease; self-registration và business/profile gates đúng yêu cầu |
| 3 | WOC-11/12 phần gap đã xác nhận, WOC-08 và VFY-WOC-01/02/03 | UI registry/profile/connector đúng yêu cầu; canonical/template conformant; independent offline/live/review receipts |

Dispatcher có thể giao task độc lập ngay sau contract handoff, không phải đợi full E2E của đợt trước. Task cùng file phải serialize: `worker.ts` giữa WOC-01/04/06/07; runtime `runtime.ts` giữa WOC-01/02/03/04; contracts giữa WOC-00/04/07; `runtime-client.ts` giữa WOC-05/07. Quyền ghi chỉ có hiệu lực sau kiểm live roster/assignment, cấp lease và dispatch thực. Roster lịch sử trong repo không chứng minh file đang rảnh. Docs shared chỉ có một docs owner khi update `docs/19`, `docs/28`, `docs/35`.

## 6. Verification và điều kiện đóng

| ID | Phạm vi độc lập | Điều kiện |
| --- | --- | --- |
| VFY-WOC-01 | Typecheck/build, focused unit và contract vectors canonical/template | Dùng cấu hình bình thường, không diagnostics:false; fixture hiện tại đúng; không bỏ legacy compatibility cases |
| VFY-WOC-02 | PostgreSQL + Redis/BullMQ thật trong namespace cô lập, ít nhất hai worker replica và hai orchestrator replica | Pause/resume, drain, quick join/HITL resume, expiry/takeover, missing/failed/completed jobs, concurrent sweep, mixed version, process crash và network fault; mock provider kiểm count/logical invocation ID |
| VFY-WOC-03 | Review backend/SDK độc lập và rollout rehearsal | Đối chiếu source/contract/receipt trên exact SHA/image digest; prove auth/key và checkpoint format không đổi, fence không bypass, không nhân provider invocation; rehearsal rollback đúng capability matrix |

Implementation/test executors dùng `gpt-6-luna`, reasoning `max`, fork `none` theo AGENTS mới. Code reviewer độc lập dùng review model theo developer policy; primary giữ planning và synthesis. Primary ghi agent ID thực từ collaboration tools vào execution record; không dùng roster Orca hay dispatch proof cũ.

Receipt mỗi VFY ghi command/cwd, timestamp/timezone, SHA/image digest, environment/namespace, task/test ID, passed/failed/skipped, functional verdict và raw log locator. Raw artifacts để trong `coordination/reports/raw/vfy-woc-*` khi tester bàn giao; receipt tại `coordination/reports/receipt-vfy-woc-*.md`. Cần trace DB task/lease/outbox và Redis job state cùng case, không chỉ nhìn HTTP status hoặc exit code.

Task chỉ chuyển IMPLEMENTED khi owner có source + smoke/typecheck thích hợp; VERIFIED khi tester độc lập có evidence đúng phạm vi; ACCEPTED khi reviewer APPROVED và toàn acceptance liên quan đạt. Offline pass không thay live gate; test skipped vẫn mở. Lượt lập plan không thay G6 hay các acceptance hold của plan khác.

## 7. Rollout và giới hạn thay đổi

Sau verification, rollout backend có compatibility trước, rồi canary worker/SDK/template theo business/version tương thích, kiểm backlog cũ và recovery, rồi mở rộng. Image đang chạy phải chứng minh được build từ SHA đã review. Rollback giữ pin của task và capability fence; không chuyển task pin cũ sang manifest mới hoặc tắt fence để chạy được.

WOC-03 sửa đường recovery tự động trước. Task hiện đang mắc kẹt cần inventory read-only và packet remediation riêng có task IDs, dry run, namespace và receipt; không blanket delete Redis jobs/reset DB hoặc tự vận hành production trong plan này. Không provisioning/rotate credential, không đổi provider thật; verification dùng mock để tránh chi phí AI. ETA sẽ do owner ước lượng sau contract/file lease handoff, không suy từ số task.

## 8. Task register

| Task | Specified | Implemented | Verified | Accepted | Owner | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| WOC-00 | Có | Một phần | Chưa | Chưa | woc_backend + woc_sdk | Contract đã bàn giao; baseline full-suite failures còn mở |
| WOC-01 | Có | SDK đang handoff | Chưa | Chưa | woc_sdk | Focused tests đạt; cần independent delayed-delivery test |
| WOC-02 | Có | Source core | Chưa | Chưa | woc_backend | Owner receipt; cần real DB/replica replay |
| WOC-03 | Có | Source core | Chưa | Chưa | woc_backend | Owner receipt; cần real BullMQ recovery/fault cases |
| WOC-04 | Có | Source core | Chưa | Chưa | woc_backend + woc_sdk | Test pin/kind/version độc lập |
| WOC-05 | Có | Có | Chưa | Chưa | woc_transport | Owner 14 tests/typecheck pass; independent verification |
| WOC-06 | Có | SDK đang handoff | Chưa | Chưa | woc_sdk | Watchdog/late ACK focused tests đạt; independent faults |
| WOC-07 | Có | Source core | Chưa | Chưa | woc_backend + woc_sdk | Optional extension đã sửa; verify rollout matrix |
| WOC-08 | Có | Source frozen | Independent isolated 5/5; 11 hashes và 61 vendor files khớp | Source APPROVED | woc_sdk | Baseline crypto failure retained; không deployed proof |
| WOC-09 | Có | Source SDK/backend | Real PG/Redis: 2 v1/1 v2, same scoped token, exact-version routing | Source APPROVED | woc_backend + woc_sdk | Không separate-process/network/image proof |
| WOC-10 | Có | Source frozen | Final profile PG 8/8; settings 12/12; owner 22/22 | Bounded source/tests approved | profile_groups_backend | Giữ deployment/process/network/provider gaps riêng |
| WOC-11 | Có | Source frozen | Built-SPA mock browser smoke và actual connector clicks | Source APPROVED | business_profile_ui | Full UI 26 failures reproduced on baseline; không live-service E2E |
| WOC-12 | Có | Existing screen/service boundary reused | Source audit + isolated SDK mock conformance | Source boundary matched | Existing source | Actual Connector service → mock provider E2E còn thiếu |
| VFY-WOC-01 | Có | Bounded checks complete | Builds, 190 SDK / 134 backend; baseline comparison | Bounded evidence | verify_worker_orchestrator | RSS behavior unclassified; không full-suite green claim |
| VFY-WOC-02 | Có | Owned harness + targeted tests | 64 migrations; runtime 3/3, BullMQ 2/2, final profile 8/8 | Bounded targeted evidence | verify_worker_orchestrator | Cleanup owned containers; không production acceptance |
| VFY-WOC-03 | Có | Read-only reviews complete | Core/template/UI/profile source APPROVED | Bounded source approval | requirements_alignment | Không deploy/process/network/provider E2E proof |

## 9. Đối chiếu với yêu cầu nghiệp vụ được làm rõ

Người dùng ngày 2026-10-12 yêu cầu đối chiếu và chỉnh ngay mọi mismatch. Mục này mở rộng phạm vi implementation đang chạy, không thay các fix delivery/lease trước đó. Source audit độc lập do `/root/requirements_alignment` thực hiện; coverage triển khai của yêu cầu bổ sung chỉ được ghi sau đối chiếu, không coi draft plan là chức năng đã có.

| Yêu cầu | Hành vi phải đạt | Đối chiếu hiện tại | Task và acceptance |
| --- | --- | --- | --- |
| Worker tự đăng ký business/version | SDK khởi động đăng ký manifest `(businessId, version)` idempotently, rồi heartbeat instance riêng, rồi mới consume. Nhiều replica cùng version không nhân business/version; version khác không ghi đè version đang có. | **MISMATCH:** SDK chỉ heartbeat, route register yêu cầu platform credential; WOC ban đầu chưa sở hữu phần self-registration. | WOC-09: A/v1 hai replica + A/v2 một replica đăng ký đồng thời tạo một business, hai version, ba worker; restart/replay không nhân bản, digest mismatch cùng version bị từ chối. |
| Queue tách theo version và có business enable gate | Task pin version nào đi tới queue version đó. Business disabled vẫn được đăng ký và heartbeat nhưng không nhận execution mới. Hai version có thể có replica đồng thời; không dùng active-version pointer để ghi đè task đã pin. | Queue business+version hiện **MATCH** theo source registry/dispatcher/SDK; logical business-enable gate **MISSING** trong submit/dispatch/claim. | WOC-04/10: jobs v1 chỉ worker v1, jobs v2 chỉ worker v2; disable chặn enqueue/admission theo policy rõ và không mất backlog; enable mở lại an toàn. Con trỏ default version không thay business-enable state. |
| UI một business chứa các version và replica | Một hàng A, trong đó v1 có hai worker và v2 có một worker; mỗi worker có identity, status, version, thông tin queue intake/capacity đúng đơn vị. | **PARTIAL:** list đã nhóm business; detail còn bảng version và bảng worker phẳng riêng (`business-detail-cockpit.tsx:142-202`); inventory chỉ capacity/activeLeases, thiếu intake count. | WOC-11: browser test dữ liệu A/v1=2 và A/v2=1; không ba hàng business hoặc trộn status giữa version. |
| Profile chỉ chọn business đã có trong DB | Tạo profile mới, chọn nhiều business đã đăng ký và được enable, load manifest/function catalog của từng business để setup. Server kiểm tồn tại/enable khi bind, không chỉ frontend filter. | **MISMATCH:** createRevision và runProfileUpsert chưa validate business/version/action (`profiles.ts:469-529`, `profile-actions.ts:201-240`); model/UI chỉ một business/version/action. | WOC-10/11: aggregate profile có identity/revision riêng và nhiều function bindings; DB business chưa có hoặc disabled không bind được; atomic save/reload đủ mọi binding. |
| Document Core dùng endpoint riêng | Chọn Document Core active trong profile phải thấy danh sách endpoint của Document Core và schema cấu hình tương ứng. Các business còn lại dùng workflow catalog. Worker vẫn có thể xử lý async qua orchestrator; không vì endpoint riêng mà mở thêm public listener cho mọi worker. | **PARTIAL:** facade và endpoint selector đã có, nhưng danh sách `coreEndpoints` tĩnh và descriptor chưa gắn selected manifest/version. | WOC-10/11: catalog endpoint/schema của version đã chọn là nguồn chuẩn; giữ facade; workflow business có workflow descriptor riêng; Document Core không bị thay thành workflow-only. |
| Connector đăng ký ở màn hình riêng | Register/configure connector độc lập với register business; profile/function tham chiếu connector đã có. Worker gọi Connector service, service resolve binding/grant rồi gọi LLM provider. | **MATCH source:** connectors-screen, service revision route và SDK `/invocations` đã có. Cần verify flow; không viết lại chức năng đã tồn tại. | WOC-12: dedicated screen create/list/update connector; business registration không tự tạo provider credential; mock provider chỉ nhận call qua Connector service, không worker direct provider call. |

### WOC-09 Worker tự đăng ký business và version

SDK là producer manifest đăng ký; registry Runtime HTTP là consumer. Dùng credential và cách xác thực business hiện có, không cấp key mới hoặc áp quy tắc unique key. Sửa quyền của đúng registration route để worker được phép đăng ký business của mình theo auth policy hiện tại; giữ worker credential bị chặn khỏi public/admin capabilities ngoài phạm vi. Registration upsert/idempotent theo business+version+digest, worker inventory theo instance riêng. Ownership/catalog root phải được tạo nhất quán để business đã register xuất hiện trong discovery phù hợp; không tự gán tenant ownership từ input không được xác thực.

Dependencies: audit route/auth/registry và WOC-00 contract. Phạm vi dự kiến SDK startup, Runtime registration route, registry/catalog và focused tests; primary chỉ cấp exact file lease sau audit, serialize với backend/SDK owners. Registry hiện SELECT absent row FOR UPDATE rồi INSERT, không khóa được registration đầu đồng thời; phải dùng cơ chế concurrent insert/replay phù hợp rồi kiểm digest, không coi PK violation là success. Catalog root và version registration cùng transaction. Acceptance gồm concurrent registration, version/digest conflict, restart, disabled business vẫn heartbeat, không consume khi register fail, key dùng chung giữ nguyên. Nếu cần migration additive thì owner phải khai rõ trước ghi; không sửa production DB trong lượt này.

**Giới hạn auth được giữ rõ, không âm thầm sửa:** source hiện tại `modules/runtime/worker-identity.ts:47-50,84-99` resolve một business theo token và reject cùng token xuất hiện trong nhiều business mappings hoặc trùng platform credential; `app/bootstrap/create-app.ts:463` gọi validation này. Nhiều replica của cùng business dùng chung một mapping/token không bị kiểm tra này cấm. Chưa có bằng chứng cấu hình thực tế đi vào nhánh duplicate across-business; không gắn limitation đó cho mọi trường hợp key dùng chung. Đợt WOC không thay key/config hay helper validation vì người dùng yêu cầu giữ thiết kế hiện tại; registration tận dụng credential/authorization path hiện có, hỗ trợ platform-runtime credential đã được phép và scoped worker credential. Không tự thêm cấm trùng hoặc cơ chế credential thứ hai. Nếu cấu hình thực tế đi vào existing duplicate-rejection branch thì ghi exact acceptance limitation riêng, không tuyên bố đã giải quyết auth across-business hoặc đổi cấu hình để che kết quả.

### WOC-10 Business enable và profile function discovery

Business tồn tại trong DB là điều kiện để profile tham chiếu; enabled là điều kiện để chọn chức năng và nhận execution mới. Khai rõ lifecycle business và default/active version selection là hai việc khác nhau. Giữ task pin của backlog và nhiều registered/running version, không dùng một con trỏ active để làm biến mất replica/version khỏi UI. Server admission và claim phải cùng bảo vệ business-enable, còn leases đang chạy theo policy drain hiện có.

Profile phải tạo mới, chọn nhiều business, load function schemas/capabilities từ version được chọn. Aggregate profile có `id`, tenant, name và revision riêng; mỗi revision chứa nhiều binding theo `(businessId, businessVersion, function/action)` và options/connector references của từng function. Tái sử dụng semantics của binding hiện có, không biến một row single-business thành multi-business bằng multiselect frontend đơn thuần. Save/reload một aggregate revision phải atomic hoặc có trạng thái commit/failure rõ, không báo success khi chỉ một phần binding được lưu. Legacy single-binding IDs và public consumers phải có adapter/compatibility explicit; không mặc định aggregate ID là binding ID hoặc thay auth key của profile để nối group.

Descriptor phải phân biệt endpoint của Document Core với workflow của business khác, có schema và selected manifest/version/digest tương ứng; tham chiếu connector không biến thành đăng ký connector ngầm. Facade core hiện có được giữ nguyên. Phạm vi source chỉ cho những gap audit xác nhận; feature đã có được tái sử dụng và nghiệm thu, không implement lại. Acceptance backend/API gồm missing/disabled business, undeclared action, multi-business profile, atomic rollback/save/reload, stale version pin, catalog rỗng hoặc digest lệch và endpoints/workflows không trộn sai.

Unique `business_versions.is_active` của migration 0006 là con trỏ default cho new submission, không phải business-enable và không cấm nhiều running versions. Giữ unique index; logical enabled gate cần kiểm ở submission, dispatch và claim theo contract riêng, giữ leases hiện có theo drain policy. Không tuyên bố multi-explicit-version admission nếu chưa có API contract/evidence cho nó.

#### Contract implementation đã chốt sau audit read-only

- Migration 0066: `business_catalog.enabled` và existing lifecycle revision/CAS; bổ sung root còn thiếu từ known registered versions theo migration 0043, ON CONFLICT DO NOTHING, không overwrite owner/lifecycle. Catalog roots đã đăng ký được backfill enabled để giữ hành vi cũ, root mới sau migration mặc định disabled. Worker counters tăng trong successful fenced claim transaction, heartbeat không reset. Scope count là business-instance lifetime qua các version, kèm epoch từ migration/row creation; không gắn count giả thành riêng version. Default version và enabled giữ riêng.
- Migration 0067: additive `profile_groups`, immutable revisions/member snapshots và ownership của child profiles; không tái sử dụng legacy binding ID làm aggregate ID. Group save gắn existing API-key membership vào child bindings, không có group credential mới.
- API additive `/api/v1/admin/profile-groups` list/create, `/:groupId` read/replace, `/:groupId/rollback`; BFF `/admin/api/profile-groups`. Save có expectedRevision, selected tenant/existing key và complete businesses/functions set. Read trả group revision và child binding IDs/revisions. Tenant/session/CSRF fences theo API hiện có.
- Business enabled mutation có matching `/admin/api/businesses/:businessId/enabled` BFF forwarding, không chỉ upstream route. CAS/lifecycle state và capability/tenant ownership phải được bảo vệ, tenant admin không được toggle shared/foreign business chỉ bằng ID.
- Catalog `/api/v1/admin/businesses/:businessId/versions/:version/functions` trả selected version/digest/enabled và endpoint/workflow descriptors cùng schemas/connector slots. Dynamic workflow slug không tự trở thành execution policy: smallest compatible implementation chỉ cho declared executable manifest action, trừ khi có selector/admission mapping được implement và verify riêng.
- Group revision transaction validate business/version/enabled/digest/action/connector, ghi child revisions + memberships + aggregate snapshot/pointer cùng transaction. Removed functions được disable; legacy mutations của group-owned child phải hướng về group edit. Rollback full member set atomic; overlap active key/function bị từ chối rõ để tránh resolver vô tình chọn cấu hình khác.
- Phase2 review bổ sung acceptance: overlap check và selector membership/pointer writes phải serialize giữa group và mọi legacy writer; direct profile-bindings route không được sửa group-owned child; enabled catalog validation phải giữ lock tới commit; read/edit/rollback phải hoạt động sau existing key rotation bằng current authorized memberships, không đổi credential scheme hoặc rewrite lịch sử. Hai P1 và hai P2 đang được owner sửa; xem `reports/review-woc-phase2-2026-10-12.md`.
- Registration dùng cùng `WorkerConfig.runtimeToken`, không thêm config/token. Route giữ platform authorization và cho scoped worker credential qua existing business authorization sau URL/manifest-coordinate validation. Đây không giải quyết duplicate-token mapper boot/claim limitation đã nêu.

### WOC-11 UI registry và profile theo business và version

UI nhóm business → versions → worker instances. Status, đang xử lý, capacity và số job đã tiếp nhận phải ghi đơn vị/nguồn rõ; queue backlog thuộc business/version, không gán giả cho một worker. Không đồng nhất số queues subscribe với số jobs. Đã hỏi người dùng về intake metric; chưa có câu trả lời thì dùng assumption số task claim thành công + đang xử lý, kèm capacity riêng. Count chỉ tăng khi successful fenced claim, không tăng bởi duplicate/deferred BullMQ delivery; phạm vi theo worker instance và reset khi instance identity mới. Nguồn durable/read DTO, sampled time và reset behavior phải rõ; không hiển thị giá trị không được đo như số 0 thật.

Profile chooser lọc business enable, mở endpoint configuration khi chọn Document Core và workflow configuration khi chọn business workflow. Browser acceptance gồm A/v1 hai worker, A/v2 một worker; status on/off/draining riêng; create/edit profile với nhiều business; function setup/save/reload; disable trong khi UI đang mở; loading/error/empty states có lý do rõ. Worker source không tự giữ public profile UI hoặc provider secrets.

### WOC-12 Connector riêng và đường gọi provider

Giữ màn hình connector riêng với API/service producer-consumer hiện có. Audit phần đã có trước khi giao sửa; gap UI hoặc binding invocation được task riêng với exact file lease. Acceptance qua UI/API tạo connector, tham chiếu trong profile/function, worker → Connector service → mock LLM provider, success/replay/denial/unknown. Các fix retry/lease WOC không được tạo invocation ID mới chỉ để né ledger hoặc expose provider key cho worker/UI.

### Handoff và nghiệm thu phạm vi bổ sung

WOC-09/10 là backend/SDK; WOC-11/12 UI/API/binding chỉ sửa gap đã xác nhận. Tất cả implementation/verification workers dùng Luna max theo Codex AGENTS; review độc lập read-only theo review policy. VFY-WOC-01/02 mở rộng registration/profile/connector contract và live routing cases; VFY-WOC-03 thêm browser verdict cho source/build có UI đổi. Intake metric hoặc lifecycle policy còn mơ hồ được ghi rõ để chốt, không suy expected behavior từ code hiện có. Existing root AGENTS guidelines và key preservation tiếp tục áp dụng; không quay về dispatch/gates cũ.
