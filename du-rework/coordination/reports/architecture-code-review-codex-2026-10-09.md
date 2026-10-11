# Đánh giá kiến trúc và code DU Rework — 2026-10-09

## Phạm vi và độ tin cậy

- Yêu cầu: đánh giá kiến trúc `du-rework` và triển khai `du-rework/orchestrator`, đưa findings và plan xử lý.
- Baseline: HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` **cộng working tree đang thay đổi**, gồm tracked/untracked source. Không coi HEAD là toàn bộ bản code đã review.
- Review tĩnh, tập trung các đường submit/outbox/runtime/lifecycle, Connector invocation/usage/readiness và ranh giới module. Đọc kiến trúc, source và một số test liên quan; không audit toàn bộ UI, crypto, migration hoặc mọi endpoint.
- Không chạy build/test/live fault injection trong lượt này. Các findings dưới là kết luận từ control flow/SQL; kịch bản kiểm chứng runtime được ghi riêng trong acceptance. Không xác nhận VERIFIED/ACCEPTED hoặc trạng thái release toàn dự án.
- Chỉ thêm báo cáo này; không sửa product source/test, không dispatch worker hay sửa trạng thái canonical task board.

## Đánh giá kiến trúc

Hướng thiết kế phù hợp với document gateway có workflow dài: PostgreSQL là nguồn trạng thái bền vững; BullMQ chỉ vận chuyển delivery; transactional outbox nối state với dispatch; worker dùng lease/epoch và checkpoint; Connector sở hữu provider invocation ledger, quota và credential. Việc giữ API và orchestration runtime cùng codebase/process hiện tại là hợp lý nếu background work có giới hạn concurrency, timeout và drain rõ ràng.

Các quyết định nên giữ:

1. Tách Business Worker và Connector thành deployment riêng; không kéo parser/provider logic vào API handlers.
2. Public/Internal listener có audience do server quyết định, ingress fence chạy trước đọc body. Đây là boundary rõ hơn dựa vào header do client cung cấp.
3. Operation snapshot/pinned revision, durable invocation identity và UNKNOWN cho outcome không xác định. Không hứa exactly-once provider execution.
4. Artifact metadata/ownership ở platform, bytes qua storage facade; contracts dùng chung và worker không ghi platform DB.

Điểm yếu chính hiện tại là **composition và vận hành khi dependency lỗi hoặc chạy nhiều replica**, không phải thiếu service mới. Code có invariant tốt ở module riêng nhưng một số production wiring chưa thực thi invariant đó.

## Findings

### ARC-01 — HIGH: deadline không được enforce tự động; ingestion bị bỏ sót

**Evidence:** `services/orchestrator/src/modules/lifecycle/lifecycle.ts:76–81` có `sweepDeadlines`, nhưng các caller production tìm được chỉ là admin action/route (`modules/admin-actions/dispatcher.ts:467`, `http/routes/admin.ts:286`). Recovery timer tại `app/bootstrap/create-app.ts:1019` gọi lease recovery, queue integrity, multipart và artifact cleanup, không gọi deadline sweep. Không thấy scheduler tương ứng trong compose/infra/scripts đã tìm kiếm.

Ngoài ra SQL sweep chỉ liệt kê ACCEPTED/QUEUED/RUNNING/WAITING_CHILDREN/WAITING_INPUT/RETRY_PENDING; thiếu PENDING_INGESTION, dù `packages/contracts/src/operations.ts:74` cho phép trạng thái đó chuyển TIMED_OUT. Ingestion consumer không đọc operation deadline. `runtime.ts:537` đọc deadline khi claim nhưng không dùng nó làm điều kiện từ chối claim.

**Tác động:** khi không có tác nhân bên ngoài gọi admin sweep, operation chờ người dùng hoặc nằm trong queue có thể quá deadline mà vẫn chưa terminal; task có thể được claim sau hạn. Ngay cả chạy sweep thủ công cũng không xử lý PENDING_INGESTION. Provider timeout riêng không giải quyết deadline của toàn operation.

**Xử lý:** nối bounded, single-flight deadline sweep vào lifecycle; xử lý đầy đủ nonterminal states theo contract; chặn thực thi sau hạn tại claim/resume/grant và trước chuyển ingestion sang READY. Chuẩn hóa lock order với complete/cancel để tránh thêm deadlock. State transition và terminal webhook vẫn phải cùng transaction.

**Acceptance:** operation ở QUEUED, WAITING_INPUT và PENDING_INGESTION tự TIMED_OUT sau hạn mà không gọi admin endpoint; không dispatch/claim mới; human wait đóng; race complete/cancel/sweep và hai replica không làm hồi sinh terminal state hoặc tạo webhook logic trùng.

### ARC-02 — HIGH: Redis outage có thể chiếm hết PostgreSQL pool

**Evidence:** `services/orchestrator/src/modules/queue/dispatcher.ts:28–85` giữ transaction và row locks trong lúc `await queue.add`. `app/bootstrap/create-app.ts:314` tạo shared Redis client với `maxRetriesPerRequest: null`; `dispatcher.ts:95` chạy `setInterval` không single-flight. `db/db.ts:25` giới hạn pool ở 10 connection.

**Kịch bản:** có backlog và Redis mất kết nối; publish có thể tiếp tục chờ reconnect. Mỗi tick tiếp theo mở transaction khác và chờ Redis; khi đủ các batch, toàn bộ pool bị giữ. API/runtime dùng cùng pool cũng chờ, bao gồm heartbeat. SKIP LOCKED chỉ tránh trùng row, không giải phóng connection đang chờ I/O.

**Xử lý:** claim outbox trong transaction ngắn với token/expiry, publish ngoài transaction bằng producer Redis connection có thời hạn lỗi hữu hạn, rồi acknowledge bằng CAS token. Giữ stable job ID để replay an toàn khi publish thành công nhưng DB ack thất bại. Thêm single-flight/concurrency cap, metric backlog/oldest age/failure và bounded drain. Chỉ thêm Promise.race mà không xử lý I/O còn treo là chưa đủ.

**Acceptance:** có backlog lớn hơn nhiều batch; ngắt Redis khi publish và giữ qua nhiều tick. DB vẫn phục vụ heartbeat/API, pool không bị chiếm hết; Redis phục hồi thì delivery tiếp tục; crash ở giữa publish và ack không mất task. Shutdown phải có thời hạn.

### ARC-03 — HIGH: readiness HTTP của Connector không probe DB/Redis

**Evidence:** nhánh production `services/connector/src/composition.ts:140` đặt `http.ready = async () => true`, rồi truyền chính object đó vào `createConnectorServer(http)` tại dòng 143. Wrapper thực sự ping DB/Redis chỉ nằm trong object mới trả về `dependencies` ở dòng 156–162. HTTP server giữ object cũ; `http/server.ts:213–215` gọi `dependencies.ready()` của object được truyền vào server.

**Tác động:** sau khi startup, `/health/ready` có thể trả 200 dù DB hoặc Redis không dùng được. Health consumer gọi helper trả về từ composition có thể nhận false trong khi network endpoint vẫn báo ready.

**Khoảng trống kiểm thử:** `tests/composition.test.ts:10–59` kiểm tra nhánh overrides và gọi trực tiếp `composition.dependencies.ready()`, không chứng minh production HTTP wiring.

**Xử lý:** tạo một readiness function chung trước khi tạo server; cùng function phục vụ HTTP và API composition; bounded probes, trả 503 khi dependency lỗi hoặc đang drain.

**Acceptance:** đi qua HTTP listener của nhánh production composition với dependency doubles tại adapter boundary; DB down, Redis down, recovery và draining lần lượt cho đúng 503/200. Không thay cả composition bằng override path trong test này.

### ARC-04 — HIGH: lỗi usage background task thoát thành unhandled rejection

**Evidence:** `services/connector/src/usage-dispatcher.ts:194–198` dùng `void this.dispatchOnce().finally(...)` không catch. `processBatch()` có thể reject từ `outbox.claimBatch` (dòng 151); `deliver()` cũng reject nếu `outbox.defer` trong catch thất bại (dòng 187). `finally` schedule tick tiếp theo nhưng không xử lý rejection. Entry point không có handler cho rejection này.

**Tác động:** khi bật usage sink, sự cố DB tạm thời trong background usage có thể tạo unhandled rejection, có thể kết thúc process với runtime policy mặc định. Đây là nguy cơ availability cho toàn Connector, không chỉ usage lag.

**Xử lý:** bắt lỗi ở biên background loop, ghi structured log/metric đã redaction, retry với backoff; giữ drain theo dõi active task. Không dùng global handler hoặc catch im lặng để thay thế xử lý ở đúng owner.

**Acceptance:** inject lỗi claimBatch và defer trong timer path; process không phát unhandled rejection, scheduler phục hồi và deliver tiếp sau khi DB ổn; shutdown không để promise ngoài vòng đời quản lý.

### ARC-05 — MEDIUM: usage outbox không có claim bền vững giữa các replica

**Evidence:** `services/connector/src/db/usage-outbox.ts:30–60` SELECT FOR UPDATE SKIP LOCKED rồi chỉ tăng attempts và commit. Không cập nhật claim token/expiry hoặc dời due time. Gửi HTTP diễn ra sau commit trong `usage-dispatcher.ts:150–152`. `markDelivered` và `defer` không có fencing token.

**Kịch bản:** replica A commit claim rồi chờ sink; replica B lập tức thấy cùng hàng vẫn due và claim lại. Row lock chỉ bảo vệ transaction ngắn, không bảo vệ khoảng gửi HTTP. Các replica có thể cùng tăng attempts, gửi trùng và thay retry schedule của nhau; ngưỡng poison retry có thể đạt sớm do tranh claim.

**Tác động:** tải thừa, retry/backoff không phản ánh các attempt độc lập và usage chậm hội tụ. Platform đã dedup `event_id` (`services/orchestrator/src/modules/usage/usage.ts:340`), nên finding này **không khẳng định billing bị đếm đôi**.

**Xử lý:** claim token + lease expiry được persist; ack/defer CAS theo token; reclaim khi owner chết. Không chuyển sang giữ transaction suốt HTTP request vì sẽ lặp lại ARC-02.

**Acceptance:** hai dispatcher trên cùng PostgreSQL và sink cố tình chậm; một event chỉ có một owner còn lease; owner crash cho phép reclaim; ack/defer từ token cũ không ghi đè attempt mới; replay tại sink vẫn idempotent.

### ARC-06 — MEDIUM: cancel chỉ abort provider socket trong cùng process

**Evidence:** `services/connector/src/invoke.ts:65–72` lưu AbortController trong Map local. `services.ts:180–187` ghi ledger CANCELLED rồi gọi `abortInFlightProviderDispatch` tại process nhận cancel. Không có owner routing hoặc thông báo cross-replica trong đường code này.

**Kịch bản:** invoke được phục vụ ở replica A, request cancel vào replica B. Ledger chuyển CANCELLED nhưng B không có controller của A; provider request ở A tiếp tục đến response/timeout. Cửa sổ cancel trước khi controller được đăng ký cũng cần test riêng.

**Tác động:** trạng thái bền vững và việc dừng I/O không đồng thời; có thể tiếp tục tiêu thụ provider/quota sau cancel. Không khẳng định remote provider chắc chắn dừng xử lý ngay cả khi socket đã abort.

**Xử lý:** durable cancel intent + bounded polling ở invocation owner hoặc notification cross-replica có durable fallback; recheck cancellation trước dispatch. Chốt rõ contract: cancel platform state, abort local transport best effort, remote cancellation chỉ khi adapter/provider hỗ trợ. Usage thực tế vẫn phải được reconcile.

**Acceptance:** hai process thật, invoke ở A và cancel ở B; A quan sát intent và abort trong cancellation SLA đã chốt; stale completion không đổi CANCELLED; kiểm tra usage/quota, reconnect notification và race cancel-before-send.

## Nợ kiến trúc cần đưa vào kế hoạch, không coi là lỗi chức năng đã tái hiện

1. **Composition root và state machine quá tập trung.** `create-app.ts` trên 1.100 dòng và `runtime.ts` trên 2.000 dòng đang quản lý nhiều trách nhiệm. Tách assembly, background supervisor, HTTP lifecycle và các command handler của runtime theo invariant/transaction boundary; tránh chỉ chia file theo số dòng. ARC-03 cho thấy cần test ở đúng production composition boundary.
2. **Dependency direction còn đảo.** Server ingestion import runtime/type từ `@du/worker-sdk` (`modules/operations/ingestion-consumer.ts:13`, `ingestion-storage-s3.ts:10`). Target trong `docs/40-du-platform-architecture.md` đã yêu cầu đưa server-domain về đúng owner. Extract source acquisition/storage ports sang module owner trung lập hoặc server; worker reference dùng subset có version/provenance. Chưa có cơ sở gọi riêng việc còn dùng workspace package là vi phạm vì migration được ghi là đang mở.
3. **Tài liệu target/current/history khó đối chiếu.** `architecture/README.md` đã đánh dấu 01–09 là lịch sử; không nên lấy chúng làm current contract. Tuy vậy cần một trang canonical mapping đến topology/code/ADR hiện hành và SHA/digest evidence, đặc biệt cho Portal hiện có `apps/admin-web`, shell/BFF và target repo split. Không suy ra source/deployment đã migrate từ sơ đồ target.
4. **Observability của background work thiếu đồng đều.** Dispatcher/recovery có catch im lặng; usage loop lại để lỗi thoát. Chuẩn hóa loop owner, tick duration, last success, pending age, error count và drain. Không chỉ dựa dependency health để tuyên bố workflow đang tiến triển.

## Plan xử lý đề xuất

Đây là backlog review, **chưa dispatch**. Canonical umbrella giữ tại `tasks/README.md`; khi thực thi, single dispatcher hiện hành ánh xạ các ID ARC vào task/lease của plan đang có. Báo cáo này là nguồn finding và acceptance, không thay thế canonical migration/release plans.

| Thứ tự | Packet / phạm vi đề xuất | Owner theo vai trò | Phụ thuộc | Điều kiện hoàn thành |
|---|---|---|---|---|
| 0 | Chốt snapshot SHA + diff hash; ánh xạ ARC vào task hiện hành, tránh lease trùng | Coordinator | Không | Có baseline reviewable, exact path lease, owner và verifier độc lập |
| 1A | ARC-01: lifecycle deadline + runtime/ingestion guards | Orchestrator owner | 0 | Deadline tự thực thi, đầy đủ state; race tests bằng DB thật |
| 1B | ARC-03: Connector readiness production wiring | Connector owner | 0 | HTTP probe phản ánh lỗi dependency/recovery/drain |
| 1C | ARC-04 + ARC-05: usage scheduler, durable claim/fencing, migration | Connector owner | 0 | Timer failure và hai replica/slow sink/crash tests pass; cùng lane vì chạm shared files |
| 2 | ARC-02: queue producer isolation + outbox claim/publish/ack | Orchestrator owner | 0; điều phối lease với 1A tại bootstrap | Redis outage không làm cạn pool; recovery và shutdown bounded |
| 3 | ARC-06: cancellation semantics + owner notification | Connector + Worker owner | Chốt cancellation SLA/contract | Two-process cancel và usage reconciliation pass |
| 4 | Background supervisor, runtime module boundaries, dependency direction, docs | Platform owner | Correctness fixes ổn định; bám RPK/MIG hiện có | Contract behavior giữ nguyên; build graph và production wiring được kiểm chứng |
| Gate | Fault suite trên deployment nhiều replica, build/image đúng baseline | Verifier độc lập | 1–3 | Raw evidence, passed/failed/skipped, SHA/digest; reviewer kết luận theo phạm vi |

Các verification packets cần chạy trên DB/Redis cô lập, provider mock, có ít nhất hai replica khi kiểm concurrency. Không dùng DB legacy/production. Không đóng finding bằng test gọi private/helper method nếu lỗi nằm ở HTTP wiring, timer hoặc ranh giới process.

Ưu tiên trước khi cân nhắc production: **ARC-01 đến ARC-04**. ARC-05/06 cần giải quyết trước khi chấp nhận multi-replica behavior tương ứng. Sau đó mới đánh giá việc tách process background dựa trên đo tải và SLO; chưa có bằng chứng cần thêm một microservice mới.
