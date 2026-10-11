# Code review follow-up — CR10-01..04

Ngày: 2026-10-10 (Asia/Bangkok). Scope: `D:/Git/dugate/du-rework`.
Canonical plan cho bốn finding: file này. Intake: [PLAN-OPEN §8](../coordination/PLAN-OPEN-2026-10-09.md#8-code-review-intake-2026-10-10).

Nguồn: review trực tiếp source và probe trong phiên người dùng yêu cầu review code du-rework, không dựa vào document. Tài liệu điều phối chỉ dùng để đặt finding vào plan; không dùng làm bằng chứng hành vi sản phẩm. Review trên working tree có thay đổi chưa commit, không phải image đã bake. HEAD tại thời điểm ghi plan: `d0b22104e3f9fcda095bc75c9588fac8afac38f3`; HEAD không định danh đầy đủ các hunk đã review.

## 1. Trạng thái và phạm vi

| ID | Ưu tiên | Finding | Đã code sửa | Đã verify bản sửa | Đã accept | Owner lane đề xuất |
|---|---|---|---|---|---|---|
| CR10-01 | P1 | Runtime Docker thiếu context provider bắt buộc khi boot | Chưa | Chưa | Chưa | Orchestrator bootstrap + build integrator |
| CR10-02 | P1 | Usage dispatcher để lọt rejection khi DB lỗi | Chưa | Chưa | Chưa | Connector |
| CR10-03 | P1 | OAuth2 body không bị giới hạn trong lúc đọc về thời gian/dung lượng | Chưa | Chưa | Chưa | Callback/OAuth2 |
| CR10-04 | P1 | OAuth2 token transport bỏ qua kiểm tra DNS/IP và ghim IP | Chưa | Chưa | Chưa | Callback/OAuth2 + egress/security |

Cả bốn task: **SPECIFIED / OPEN**, chưa dispatch, chưa có owner cá nhân hoặc lease. Probe tái hiện lỗi không phải verification bản sửa. Không tick parent/gate hoặc suy trạng thái release từ intake này.

Review tập trung bootstrap/đóng gói, runtime, callback và Connector; chưa phải kiểm toán toàn bộ du-rework. Chưa build Docker, chưa chạy integration với DB thật, chưa thử SSRF qua mạng thật.

## 2. Công việc và acceptance

### CR10-01 — Đóng gói context provider hoặc tách khỏi boot thông thường

- Luồng lỗi: Docker build/deploy → `dist/main.js` → `registerLdb03ContextProvider()` → require file ngoài artifact runtime.
- Bằng chứng source: `orchestrator/services/orchestrator/src/main.ts:233` gọi registration vô điều kiện; `src/app/bootstrap/create-app.ts:157` mặc định nạp `../../../scripts/ldba-context-provider.cjs`; `scripts/docker/build-runtime.cjs:82` đặt files chỉ gồm `dist` và `migrations`. Dockerfile copy deploy output vào `/app` rồi chạy `dist/main.js`.
- Tác động: image mặc định không có provider tại `/app/scripts/ldba-context-provider.cjs`, boot dừng với `LDBA03 context provider module could not be loaded`. Đây là kết luận từ source/packaging, chưa có Docker reproduction.
- Hướng sửa: ship provider và các dependency cần thiết vào runtime, hoặc tách registration dành cho migration khỏi boot service. Giữ lỗi rõ ràng cho cấu hình provider tường minh nhưng không hợp lệ.
- Lease dự kiến: bootstrap/main, provider script nếu cần, `scripts/docker/build-runtime.cjs`, focused packaging/boot tests. Dispatcher chốt exact paths trước khi giao, phối hợp lane LDBA-MDB-01 và build hiện có.
- [ ] Build image từ snapshot được ghi nhận; kiểm tra artifact runtime không phụ thuộc source tree hoặc host mount.
- [ ] Với cấu hình service hợp lệ và không đặt `LDBA03_CONTEXT_MODULE`, image boot được và health trả kết quả thực tế.
- [ ] Provider tường minh không tồn tại vẫn báo lỗi có kiểm soát; flow adapter được chọn không bị regression.
- [ ] Independent verifier ghi command, file hashes/image digest, boot logs và health response; review độc lập trước ACCEPTED.

### CR10-02 — Bắt rejection tại vòng chạy usage dispatcher

- Luồng lỗi: timer → `dispatchOnce()` → `processBatch()` → outbox `claimBatch()` → DB rejection → promise sau `finally()` không có catch.
- Bằng chứng: `orchestrator/services/connector/src/usage-dispatcher.ts:197` gọi `void this.dispatchOnce().finally(...)`.
- Probe source-transpiled trong process riêng: cho `claimBatch()` ném lỗi synthetic database unavailable; listener `unhandledRejection` ghi nhận đúng lỗi đó. Probe dùng listener để quan sát; chưa chạy crash/restart của service thật. Với Node mặc định, rejection không được xử lý có thể kết thúc Connector.
- Hướng sửa: bắt lỗi ở scheduler boundary, ghi log an toàn, giữ cadence retry và semantics shutdown; không đánh dấu usage đã giao khi DB/sink chưa thành công.
- Lease dự kiến: `orchestrator/services/connector/src/usage-dispatcher.ts` và focused dispatcher tests.
- [ ] `claimBatch()` reject không tạo unhandled rejection hoặc làm process thoát.
- [ ] DB phục hồi thì lượt poll tiếp theo giao được event; không mất event hoặc tự đánh dấu DELIVERED.
- [ ] Lỗi `markDelivered()`/`defer()` cũng được containment tại scheduler; shutdown vẫn dừng timer.
- [ ] Independent verifier chạy fault/recovery test và integration với DB disposable; ghi functional assertions, không chỉ exit code.

### CR10-03 — Giữ timeout và byte cap đến hết token response

- Luồng lỗi: token fetch nhận headers → clear timer → `response.text()` đọc toàn body → kiểm tra byte count sau đó.
- Bằng chứng: `orchestrator/services/orchestrator/src/modules/webhooks/oauth2-client.ts:390`, `:405`, `:409`.
- Probe timeout: `timeoutMs=20`; sau 100 ms body vẫn pending, signal chưa abort.
- Probe stream: `maxResponseBytes=64`; stream tạo 1,048,576 byte qua 17 lần pull, không bị cancel; chỉ sau EOF mới báo `TOKEN_RESPONSE_TOO_LARGE`.
- Tác động: token endpoint gửi body chậm/vô hạn có thể giữ lượt webhook dispatch; body lớn không có Content-Length có thể gây cạn bộ nhớ. Các probe dùng synthetic fetch/stream, không gọi provider thật.
- Hướng sửa: đọc stream với byte cap và cancel khi vượt ngưỡng; giữ deadline/abort đến hết body; cleanup cả nhánh status/content-type/declared-length bị từ chối.
- Lease dự kiến: `oauth2-client.ts`, focused OAuth2 tests. Cùng owner source với CR10-04 để tránh trùng writer.
- [ ] Headers về ngay nhưng body không kết thúc: request bị abort trong deadline có tolerance, dispatch có thể tiếp tục.
- [ ] Body chunked vượt cap: dừng/cancel trong lúc đọc, không buffer đến EOF; kiểm tra bằng byte count/pull count và cancellation.
- [ ] Response hợp lệ, cap boundary, retry và 401 reacquire vẫn hoạt động; không lộ token/secret trong lỗi/log.
- [ ] Independent verifier chạy regression và receiver HTTP(S) local có body chậm/lớn; ghi bằng chứng cancellation và tiến triển dispatcher.

### CR10-04 — Áp dụng egress policy cho token URL

- Luồng lỗi: callback policy → OAuth2 client → global fetch(tokenUrl), không qua DNS/IP adjudication và pinned transport.
- Bằng chứng: `orchestrator/services/orchestrator/src/modules/webhooks/oauth2-client.ts:285` chọn global fetch, `:378` gửi token request. `orchestrator/packages/contracts/src/profile-callback.ts:152` chỉ từ chối DENIED; hostname trả NEEDS_RESOLUTION trong `ip-policy.ts` vẫn qua schema.
- Probe: callback auth schema chấp nhận `https://auth.internal.example/token`; token client gọi global fetch stub thành công. Probe này chứng minh đường dispatch không có DNS guard, không chứng minh một đích private thật đã được kết nối.
- Tác động có điều kiện: khi callback OAuth2 được composition bật với secret resolver, hostname phân giải về private/loopback có thể đi qua HTTPS và tạo SSRF. Không suy rằng default main hiện đã nối resolver.
- Hướng sửa: dùng shared egress/pinned transport cho token request, kiểm tra toàn bộ DNS answers trước khi kết nối, kết nối đúng IP đã duyệt; giữ redirect denial và policy opt-in tường minh.
- Lease dự kiến: `oauth2-client.ts`, callback wiring nếu cần, focused OAuth2/egress tests; package egress chỉ sửa nếu thực sự cần và đã có lease.
- [ ] Private/loopback/link-local/metadata, IPv4/IPv6 và mixed DNS answers bị chặn trước connect mặc định.
- [ ] DNS rebinding giữa kiểm tra và connect không đổi IP đích; public HTTPS token endpoint hợp lệ vẫn chạy được.
- [ ] Redirect không chuyển credential sang đích khác; denial không đưa token/secret vào lỗi/log.
- [ ] Independent verifier chạy DNS/pinned-connect matrix và integration HTTPS local có kiểm soát; không dùng provider hoặc credential thật.

## 3. Evidence đã có và phần còn thiếu

Trong review trước khi ghi plan, tại cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`, Node `v24.21.0`:

```text
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/cb-03-outbound-auth.test.ts tests/mdb-01-composition-provider.test.ts
Test Suites: 2 passed, 2 total
Tests:       22 passed, 22 total
Snapshots:   0 total
Time:        21.577 s
Exit:        0
```

Đây là regression của hai suite hiện có, không phải full suite và không đóng các finding. Probe độc lập đã mô tả ở CR10-02..04. Raw output nằm trong tool output của phiên review; chưa lưu receipt/script tái lập riêng trong repository. Bảng evidence này là intake từ phiên, không giả danh raw receipt độc lập. Tester cần tạo regression bền vững và receipt mới trên snapshot bản sửa.

## 4. Thứ tự và điều phối

1. Claude Code dispatcher kiểm tra assignment/lease thật, gắn CR10-01 vào lane bootstrap/build và CR10-02 vào Connector; hai lane có thể chạy riêng khi exact paths không trùng.
2. Gộp CR10-03 và CR10-04 vào cùng implementation lease cho `oauth2-client.ts`; acceptance và evidence vẫn tách theo ID.
3. Giao verifier độc lập với implementation owner; reviewer không tự accept source/test của mình. Receipt dự kiến: `coordination/reports/cr10-01-verify-<date>.md` đến `cr10-04-verify-<date>.md`, kèm raw evidence và provenance.
4. Sau functional verification và review độc lập, dispatcher cập nhật từng task rồi reconcile parent/gate liên quan. Không tạo dispatcher thứ hai, không nhận các lane đề xuất ở đây làm bằng chứng dispatch.
