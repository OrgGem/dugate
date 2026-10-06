# Receipt — SHIPPING-CHECKLIST-878

Ngày kiểm: 2026-10-05. Phạm vi là ứng dụng DUGate ở repository root `D:\Git\dugate`; không sửa product source hoặc test, không commit/stage/tick.

**Kết quả chung: FAIL — chưa đủ bằng chứng để ký shipping checklist.** Một lỗi offline được tái hiện trong DAG disbursement; các hành vi cần app/DB/Redis/worker thật không chạy vì không có live test target cô lập. Có thêm một code-path concern về API authentication cần xử lý trước khi ký.

## 1. Sáu public endpoint

**FAIL — yêu cầu response/useCase/no-name-leak chưa được chứng minh.** Sáu route wrapper hiện có và mỗi wrapper truyền đúng slug tương ứng (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) vào `runEndpoint`. Nhưng sáu E2E fixture hiện gọi `POST /api/v1/{slug}` qua `tests/e2e/utils.ts`; route tree hiện nằm ở `/api/v1/docs/{slug}` và `middleware.ts`/`next.config.mjs` không có rewrite cho đường dẫn ngắn. Chưa chạy HTTP nên chưa kết luận endpoint trả 404, nhưng fixture hiện không nhắm vào route tree đã thấy. Các fixture cũng kiểm status, `name`, state và `output_format`; không có assertion cho đúng `useCase` hoặc cấm tên nội bộ lọt vào response.

**Blocker chính xác:** không có app listener ở `2023`, không có worker/Redis/mock service; thiếu `DATABASE_URL` cô lập. Cần chốt canonical path, rồi chạy đủ sáu request và kiểm response contract + sentinel cho tên nội bộ.

## 2. Disbursement workflow DAG

**FAIL — lỗi offline được tái hiện.** Jest `schema-disbursement.test.ts` xanh 4/4 nhưng chỉ xác nhận schema/flow. Tôi chạy schema fixture hiện có trong working tree qua `runSchemaDag` thật với connector seam xác định. Interpreter tạo đủ năm result node `classify → extract → human_review → crosscheck → report` và gọi đủ bốn connector leaf; tuy nhiên `classify.output` là `classify.fixture` trong khi binding `extract.logical_docs` nhận `undefined`, làm assertion kết thúc với exit code **1**. Schema khai báo `$classify.output`; resolver chỉ coi `content`, `extractedData`, `files`, `data` là top-level field và sau đó tra `.output` trên chính giá trị output, nên binding bị rơi. Raw harness, log và exit code ở `coordination/reports/raw/shipping-checklist-878-2026-10-05/`.

Đây là lỗi control-flow/data-binding trên schema-driven fixture, không phải bằng chứng connector thật chạy. Code-driven workflow `lib/pipelines/workflows/disbursement.ts` cần thêm kiểm tra bằng worker thật; bộ test root hiện không có fixture thực thi nhánh đó.

## 3. BullMQ worker poll và xử lý job

**FAIL — live-only, chưa chạy.** Fixture gần nhất là `tests/e2e/profile-openai-flow.e2e.test.ts`; nó chờ operation hoàn tất và kiểm job state `completed` trong cả pipeline queue lẫn workflow-step queue. Nó cần app, PostgreSQL, Redis, worker và mock service. Không có Redis listener ở `6379`, app không nghe `2023`, mock không nghe `3099`; tôi không chạy fixture vào PostgreSQL đang lắng nghe ở `5432` vì không có URL/DB test được xác nhận là disposable. Không có offline unit test root nào trực tiếp chạy BullMQ poller.

## 4. Idempotency và duplicate jobs

**FAIL — server-side dedupe chưa được chứng minh.** Offline suite `du-operation-adapter.test.ts` xanh 24/24 và `ui-integration.test.ts` xanh 38/38; chúng chứng minh key phía client được tạo ổn định và gửi trong request mock. Chúng không gửi hai request thật có cùng idempotency key rồi đếm operation/job. E2E profile hiện có cũng không replay cùng request. Production source có lookup theo key và xử lý unique-violation race, nhưng chưa có kết quả chạy trên DB/Redis chứng minh một operation và một queue job duy nhất.

## 5. Webhook và polling trạng thái

**FAIL — phần server chưa được kiểm thử bằng fixture.** Source có lưu `webhookUrl` và worker gửi webhook khi thành công/thất bại; polling client tests xanh chỉ chạy trên response giả. Không có test root nào kiểm webhook request thật, `webhookSentAt`, persistence, hoặc trạng thái DB qua `GET /api/v1/operations/:id`. Các E2E endpoint có polling nhưng cần app/DB/Redis/worker và chưa chạy.

## 6. API key và NextAuth

**FAIL — chưa có runtime auth test; có code-path concern bảo mật.** `middleware.ts` pass-through toàn bộ `/api/v1/` và ghi chú runner sẽ xác thực key. Trong `runEndpoint`, key thiếu/không khớp chỉ dẫn tới log warning; nhánh đó không trả 401/403 trước `submitPipelineJob`. Submission nhận `apiKeyId` optional, có thể ghi `apiKeyId: null`, rồi tiếp tục queue job. Đây là đường đi có khả năng cho phép request không có key/session tới bước tạo job; chưa chạy request trên DB thật nên ghi nhận là code-path finding cần chặn trước shipping, không khẳng định đã quan sát một response runtime.

Không có fixture root kiểm valid/invalid/missing API key xuyên cả sáu endpoint hoặc login/session NextAuth. E2E key fixture cần DB và app nên chưa chạy. **Không ký auth gate pass.**

## 7. RBAC ADMIN / USER / VIEWER

**FAIL cho request-level gate; PASS giới hạn ở helper.** Đã gọi code thật `canMutate`/`isAdmin`: ADMIN `(true,true)`, USER `(true,false)`, VIEWER `(false,false)`, exit code **0**. Đây chỉ là pure role predicate; không gọi NextAuth session hay API guard. `schema-route.test.ts` có ADMIN fixture và xanh 6/6, nhưng không có negative route test cho USER/VIEWER trên protected endpoints. Vì thế không xác nhận được toàn bộ RBAC route matrix.

## Kết quả chạy offline

Lệnh Jest chọn 15 unit suite trong working tree và bỏ `tests/e2e/`. Kết quả: **14/15 suite pass; 151 assertion pass, 0 assertion fail; 1 suite fail khi khởi tạo; exit code 1**. `tests/pipelines/external-api.test.ts` không chạy assertion vì import `mammoth` ném `TypeError: Cannot read properties of undefined (reading 'bind')` tại `node_modules/mammoth/lib/docx/files.js:53:47` trên Node `v22.16.0`. Đây là lỗi suite/import environment, không quy kết cho checklist code. Raw output và JSON kết quả được giữ ở thư mục evidence.

Các suite offline liên quan chạy xanh gồm: disbursement schema 4, schema route 6, interpreter 9, adapter 24, UI integration 38, HITL persistence 3 và real-exec 6. Kết quả client/mock không thay thế live test.

## Offline-provable và live-only

Offline đã chứng minh được: schema fixture có năm node; resolver hiện làm mất binding `classify.output → extract.logical_docs`; các unit/client suites nêu trên; pure RBAC helper matrix. Chưa offline-prove được public HTTP response/useCase, API key/NextAuth boundary, duplicate DB/job behavior, BullMQ poll/worker, webhook delivery/persistence, polling từ DB thật, hoặc thực thi connector thật trong disbursement.

Live window an toàn cần app + PostgreSQL disposable + Redis + worker + mock service, và API/auth fixtures có teardown. Hiện không có `.env`/`.env.local`, `DATABASE_URL`, `REDIS_URL`, `NEXTAUTH_SECRET` đều unset; listener count là `2023=0`, `2025=0`, `3099=0`, `5432=2`, `6379=0`. E2E setup chèn API key vào DB cấu hình và có request tạo job; vì vậy không dùng listener PostgreSQL chưa định danh làm test target.

## Working tree và SHA-256

Test và inventory phản ánh working tree tại thời điểm chạy, không phải HEAD. HEAD là `b088eececcb5f3df0b4edbe073a29401dafda624`; snapshot ban đầu có 2,548 status entries và 109 test files untracked trong toàn monorepo. Không sửa hoặc stage test/source trong project DUGate root.

Inventory riêng DUGate root gồm 536 source files trước và sau; changed/added/removed đều **0**. SHA-256 của manifest trước và sau giống nhau: `365303AB3F17707D5F902A3EEF2F1744264A7824F4A890F381974711FF61F03F`.

Toàn workspace đồng thời chứa thư mục `du-rework` do worker khác dùng. Trong lúc kiểm, inventory workspace-wide ghi nhận drift ngoài project root: `du-rework/services/orchestrator/src/http/routes/public.ts` đổi hash `94E6A6C94A52B5599D30FAFEDB2BE8CC9455FB483F59AB63D0DEE842E3FC4DFA` → `EF1F74714AA2F4B972AD6DB0BB4AAB62F6E0401FE9CFF2C943043989A7EEA97F`; thêm `du-rework/tools/repo-migration/verify-inventory.cjs`, `du-rework/services/orchestrator/src/modules/connectors/probe-authorization.ts`, và raw `.cjs` dưới reports. Đây không thuộc test command hoặc source root của checklist; không thể khẳng định workspace-wide không drift. Chi tiết hash có trong `source-drift-summary.txt`.

Raw artifacts: `offline-jest.log`, `offline-jest-results.json`, `offline-jest.exit.txt`, `disbursement-dag-run.log`, `disbursement-dag-run.exit.txt`, `disbursement-dag-harness.txt`, `rbac-helper-run.log`, `rbac-helper-run.exit.txt`, `commands-and-preconditions.txt`, cùng manifest/status snapshots trong `coordination/reports/raw/shipping-checklist-878-2026-10-05/`.

