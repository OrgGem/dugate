# Review Orchestrator app và core API — 2026-10-05

Kết luận: **CHANGES_REQUIRED** trong phạm vi review. Có 6 findings: 4 HIGH/P1, 2 MEDIUM/P2. Đây là review theo yêu cầu người dùng, không thay verdict của reviewer/gate hiện hành, không dispatch hoặc sửa source sản phẩm.

Snapshot: working tree dirty trên HEAD `b088eececcb5f3df0b4edbe073a29401dafda624`; SHA-256 các file chính trong [raw probe receipt](orchestrator-app-core-review-2026-10-05.raw.json). Timestamp probe cuối `2026-10-04T19:36:55.628Z` = 2026-10-05 02:36:55 +07:00. Findings áp dụng cho snapshot này, cần đối chiếu lại nếu owner sửa file sau receipt.

Scope: app bootstrap/HTTP listener, Admin BFF auth/tenant/CSRF/upstream, public submission/operation/result/artifact routes, runtime task commands, legacy facade cho sáu core actions và operation download; đối chiếu shared contracts và SDK consumers. Không tuyên bố review mọi nhánh UI hoặc mọi handler Document Core; không browser/provider/deployment acceptance.

## RCR-01 — HIGH/P1: HTTP input không hợp lệ làm process Orchestrator lỗi uncaught

- File: [create-app.ts:584](../../services/orchestrator/src/app/bootstrap/create-app.ts:584), [URL construction:589](../../services/orchestrator/src/app/bootstrap/create-app.ts:589).
- Expected: request không hợp lệ bị trả 400/problem response, listener vẫn xử lý request tiếp theo.
- Actual: callback `createServer` là async, nhưng `setHeader` và `new URL(..., http://${Host})` chạy trước cả hai vùng try/catch. Request chưa auth với `Host: [` làm `new URL` throw `ERR_INVALID_URL`; rejected listener Promise không có catch ở ngoài. Node ở chế độ unhandled-rejections strict kết thúc process.
- Evidence: RCR-01 probe lấy đúng callback từ source bằng TypeScript AST, chạy trong child HTTP server trên loopback, gửi raw request và nhận child exit 1/ERR_INVALID_URL. Không boot full app/DB/Redis; default deployment behavior còn phụ thuộc Node flags/proxy có chặn Host không.
- Owner: Orchestrator app/HTTP. Fix: bọc toàn callback trong error boundary, parse request URL bằng base đã cấu hình và kiểm tra Host theo nhu cầu; không để request-controlled validation throw ra khỏi listener.
- Verify: raw invalid Host và malformed request URL trên real assembled app trả controlled 4xx; subsequent health request còn hoạt động; correlation/header edge cases không unhandled rejection.

## RCR-02 — HIGH/P1: spawn/wait chấp nhận worker có lease hết hạn

- Files: [spawnChildren:949](../../services/orchestrator/src/modules/runtime/runtime.ts:949), [parent transition:1110](../../services/orchestrator/src/modules/runtime/runtime.ts:1110), [waitInput:1185](../../services/orchestrator/src/modules/runtime/runtime.ts:1185).
- Expected: worker writes cần current epoch, RUNNING và live lease, theo invariant ở đầu runtime module; expired owner không tạo children/outbox/wait.
- Actual: hai hàm lock task và so epoch/state nhưng không đọc/check `lease_expires_at`; INSERT/UPDATE không có expiry fence. Sau lease expiry, trước recovery sweep bump epoch, worker cũ vẫn có thể tạo child work hoặc chuyển parent sang WAITING_INPUT/WAITING_CHILDREN. Recovery sweep chỉ chọn RUNNING nên transition này còn có thể tránh đường recovery.
- Evidence: real runtime functions + scripted DB với RUNNING, epoch 1, expired lease; spawn ack WAITING_CHILDREN với 5 writes, wait ack với 3 writes. Không query/predicate nào có expiry. Đây là chứng minh code-path offline, chưa là live PG concurrency receipt.
- Owner: P2/runtime. Fix: fence expiry và business identity ở transaction/write time cho mutation mới; giữ semantics replay của mutation đã durable bằng rule riêng.
- Verify: expire lease rồi spawn/wait trước recovery tick phải 409 LEASE_LOST và 0 new rows; expiry giữa read và write; valid/replayed requests và cancel races không regression.

## RCR-03 — HIGH/P1: idempotency replay phụ thuộc config/version hiện tại

- Files: [submission.ts:232](../../services/orchestrator/src/modules/operations/submission.ts:232), [profile resolution:249](../../services/orchestrator/src/modules/operations/submission.ts:249), [lookup:293](../../services/orchestrator/src/modules/operations/submission.ts:293).
- Expected: cùng key/body trong replay window trả original operation; không đánh giá lại defaults/version của admission mới. Comment T-SUB-04 của chính module cũng yêu cầu profile edit không phá replay.
- Actual: kiểm tra referenced artifacts, active business version, effective profile và action input schema trước lookup `submission_keys`. Nếu version đã deactivate, replay trả 404 dù operation và matching key còn tồn tại. Profile/default/schema thay đổi cũng có thể chặn replay trước lookup. Đây là lỗi trả lại operation đã accepted, không chứng minh tạo duplicate operation trong probe.
- Evidence: real submission service, matching record sẵn trong scripted DB, active version đã disable → 404; không hề query submission_keys.
- Owner: P2/submission + Profile owner. Fix: sau auth/current caller scope và structural normalization/hash cần thiết, ưu tiên lookup scoped key và trả original operation; admission policy/config/artifact readiness hiện tại áp dụng cho request mới. Chốt authorization replay rõ, không bỏ key/tenant fence.
- Verify: accepted submit→disable/drain version hoặc đổi profile defaults→same-key same-body replay original; khác body 409; revoked key/foreign tenant vẫn deny; concurrent requests và sealed metadata không regression.

## RCR-06 — HIGH/P1: download legacy không gửi bytes đã đọc

- Files: [legacy-http-mount.ts:597](../../services/orchestrator/src/compat/legacy-http-mount.ts:597), [public adapter:294](../../services/orchestrator/src/http/routes/public.ts:294), [serializer:682](../../services/orchestrator/src/app/bootstrap/create-app.ts:682).
- Expected: `/api/v1/operations/:id/download` trả nguyên output bytes, MIME và content length đúng.
- Actual: mount tải `bytes` rồi trả `body: {}` với `content-length=bytes.length`. Public adapter chỉ chuyển status/body/headers, không `raw`; app serializer gửi JSON `{}`. File bị mất, body size không khớp header; client có thể lỗi truncated body.
- Evidence: probe gọi real `handlePublicRoutes`→legacy mount/host với SUCCEEDED operation và inline output 49 bytes; returned raw undefined/body `{}` (2 bytes), declared length 49. Chưa live storage/download browser.
- Owner: COMP/legacy API + HTTP owner. Fix: truyền raw Buffer/stream xuyên LegacyRouteResult→RouteResult→listener; giữ tenant fence, at-rest/deployment delivery policy; không chỉ xóa content-length để biến lỗi thành JSON success.
- Verify: real HTTP download và SHA-256/content length/bytes match, gồm non-ASCII/binary/output storage; foreign/missing/not-ready denied; regression current artifact download/encryption policy.

## RCR-04 — MEDIUM/P2: saveStep bỏ schema/default nên request hợp lệ có thể lỗi 500

- Files: [runtime route:412](../../services/orchestrator/src/http/routes/runtime.ts:412), [saveStep INSERT:701](../../services/orchestrator/src/modules/runtime/runtime.ts:701), [contract default:170](../../packages/contracts/src/runtime.ts:170), [NOT NULL column:108](../../services/orchestrator/migrations/0001_platform_v1.sql:108).
- Expected: request không truyền status được parse thành SUCCEEDED; schema sai trả 422 trước DB.
- Actual: route cast body, service cũng không parse SaveStepRequestSchema. Request `{leaseEpoch:1,inputHash:'h',outputRef:'r'}` được contract chấp nhận nhưng `body.status` undefined được bind vào explicit status column. pg chuẩn hóa undefined thành NULL, không dùng column DEFAULT; NOT NULL violation đi tới 500 boundary.
- Evidence: probe parse real schema được SUCCEEDED, gọi real service bằng raw body và capture INSERT parameter status undefined. Không chạy PG; lỗi NOT NULL suy ra từ migration và driver behavior.
- Owner: P2/HTTP runtime. Fix: parse contract schema tại boundary/service thống nhất, dùng parsed data; áp dụng tương tự các runtime reports còn cast để tránh mất defaults/validation.
- Verify: omitted status lưu SUCCEEDED; invalid status/missing fields/null/out-of-range lease epoch 422 với 0 writes; valid failed checkpoint vẫn đúng.

## RCR-05 — MEDIUM/P2: sessionRef checkpoint bị bỏ khi save/claim

- Files: [saveStep:660](../../services/orchestrator/src/modules/runtime/runtime.ts:660), [claim checkpoint projection:1817](../../services/orchestrator/src/modules/runtime/runtime.ts:1817), [SDK fallback:294](../../packages/worker-sdk/src/connector-session.ts:294).
- Expected: optional sessionRef trên SaveStep/CheckpointRef được giữ qua save→claim; SDK có thể dùng prior checkpoint sessionRef sau restart như interface công bố.
- Actual: service body signature/INSERT bỏ sessionRef; claim SELECT/projection cũng không trả nó. SDK gửi field nhưng platform bỏ silently, làm fallback này không có reference khi worker được redeliver. Không khẳng định mọi provider session đều hỏng: output artifact có thể chứa dữ liệu riêng, nhưng checkpoint.sessionRef path không hoạt động.
- Evidence: real saveStep với sessionRef riêng → field không xuất hiện trong SQL/bound params; claim source không select/project sessionRef. Consumer dùng trường tại SDK và schema có optional field.
- Owner: P2/runtime + P4/SDK/session owner. Fix: persist/project sessionRef đúng metadata/security binding hoặc chốt consumer contract khác trước thay đổi; không xóa field trong spec để che mismatch.
- Verify: save checkpoint với sessionRef→worker restart/new claim→reference giữ nguyên; tenant/lease fences, metadata encryption, null/omitted compatibility; multi-turn consumer path thật.

## Verification đã chạy và giới hạn

- Cwd `D:\Git\dugate\du-rework\services\orchestrator`: `pnpm exec tsc --noEmit -p tsconfig.json` exit 0, không output.
- Cùng cwd: `pnpm exec jest --runInBand --runTestsByPath tests/aweb02-bff-foundation.test.ts tests/aweb04-bff-profiles.test.ts tests/br12-isolation-offline.test.ts tests/runtime-facade.test.ts` exit 0: 3 suite PASS, 54 tests PASS; 1 suite/14 tests SKIP. Runtime facade dùng DU_LIVE_INFRA guard nên skipped; không live proof. Test duration 8.568s. BFF fixtures có warning bundle Admin Web thiếu; không browser build acceptance.
- Cwd root `D:\Git\dugate`: `node du-rework/coordination/reports/orchestrator-app-core-review-2026-10-05.probe.cjs` exit 0. [Harness](orchestrator-app-core-review-2026-10-05.probe.cjs) load TS source trực tiếp, alias source packages contracts/egress/observability để không nhầm dist cũ; transpilation không thay typecheck. Exit 0 có nghĩa probe xác nhận 6 defects đã mô tả, không có nghĩa product pass.
- Probe dùng scripted queries, loopback HTTP child và không PG/Redis/S3/Vault/provider/production. Không sửa source sản phẩm, không chạy live, không tick plan/gate, không commit/push. [Checks capture](orchestrator-app-core-review-2026-10-05.checks.txt) và raw JSON ghi evidence đúng scope.

Ưu tiên fix: RCR-01 process availability, RCR-02 lease fencing, RCR-03 replay và RCR-06 binary download; tiếp theo RCR-04/05 checkpoint contract. Coordinator hiện hành cấp packet owner/lease, independent regression rồi reviewer verdict trên candidate mới; không chờ backlog RPK vốn DEFERRED mới sửa lỗi đang ảnh hưởng baseline.
