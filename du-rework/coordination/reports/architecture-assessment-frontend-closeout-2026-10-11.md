# Kiểm định kiến trúc và đóng phạm vi Admin Workspace — 2026-10-11

## Kết luận điều hành

**Đánh giá: ĐÃ TRIỂN KHAI VÀ CÓ BẰNG CHỨNG OFFLINE CHO PHẦN LỚN PHẠM VI AWEB; CHƯA ĐỦ ĐIỀU KIỆN NGHIỆM THU SẢN PHẨM HOẶC TUYÊN BỐ SẴN SÀNG PRODUCTION.**

Các lỗi cốt lõi về số liệu Overview, tính trung thực của Workflow, Audit thiếu màn hình riêng, thao tác bulk cancel mất trạng thái lỗi, lọc ngày chưa lên server và Trace/Audit bỏ qua deep-link đã được xử lý trong source. Hầu hết có test offline và một số đã được verifier độc lập kiểm tra. Tuy nhiên, chưa có kiểm thử browser trên build cuối, chưa chứng minh hành vi với PostgreSQL thật hoặc image đã triển khai, và việc kiểm tra typecheck trên đúng working tree sau task AWEB-20-UI chưa được xác nhận. Vì vậy, trạng thái phù hợp là **IMPLEMENTED / OFFLINE-VERIFIED THEO TỪNG PHẠM VI**, còn **ACCEPTED** cần reviewer UI độc lập trên đúng build và kiểm chứng tích hợp phù hợp.

Ngoài các GAP của Admin Workspace, kiểm định bảo mật độc lập ngày 2026-10-11 xác nhận bốn lỗi mức High/P1 ở orchestrator. Hai lỗi có thể ảnh hưởng cách ly tenant và xử lý dữ liệu thật. Do đó, wave kế tiếp nên là **Security Remediation**, trước khi mở rộng thêm Business Services. Đây là kết luận ưu tiên kiến trúc; báo cáo không tick gate hay đổi trạng thái của plan.

## Phạm vi và cách đọc bằng chứng

Đối chiếu plan tại coordination/PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md, source hiện tại trong orchestrator/apps/admin-web và các receipt/verifier có sẵn, gồm báo cáo độc lập về AWEB-16/17/18/19/20a/20b/21, kiểm thử contract operations, và security review ngày 2026-10-11. Hai feedback Qwen-B và Qwen-C vốn được plan ghi nhận là chưa tổng hợp cũng đã được xem xét; thiếu sót về phạm vi nghiên cứu đó được đóng, nhưng các đề xuất hỗ trợ còn lại được giữ thành backlog.

Theo COORDINATOR-CONTRACT, lượt này chỉ đọc source/bằng chứng và ghi coordination report. Không chạy build/test, không sửa source/test, không thay đổi plan hay gate, không chạy git add/commit/push. Khi receipt ở các revision khác nhau mâu thuẫn nhau, báo cáo phân biệt rõ owner smoke với kiểm chứng độc lập và không gộp chúng thành một trạng thái xanh chung.

## Trạng thái các GAP chính

| GAP / hạng mục | Đánh giá hiện tại | Bằng chứng và giới hạn |
|---|---|---|
| Overview báo tổng operation từ 100 dòng gần nhất | **ĐÃ ĐÓNG Ở MỨC IMPLEMENTATION.** UI lấy total, success/failure, thời lượng p50/p95 từ endpoint aggregation có scope thời gian và tenant; danh sách gần đây vẫn là sample và được trình bày như danh sách gần đây. | orchestrator/services/orchestrator/src/modules/admin-read/operations-metrics.ts dùng một câu SQL và một snapshot MVCC cho count/percentile; overview-screen.tsx kiểm tra scope trả về và tách lỗi metrics. Receipt AWEB-16b cùng verifier xác nhận wiring và tenant predicate. Chưa có lượt query trên PostgreSQL thật. Cờ stale backend biểu thị query mất hơn 30 giây, còn UI cũng có stale state cho lần refresh lỗi; ý nghĩa freshness cần được làm rõ để nhân viên không nhầm stale snapshot với truy vấn chậm. |
| Worker telemetry giả lập từ business | **ĐÃ ĐÓNG TRONG DELIVERY TRƯỚC.** Overview hiện đọc worker_instances đã lưu, phân biệt inventory rỗng và lỗi đọc, không dựng worker xanh từ business. | receipt-aweb-11c-worker-instances-2026-10-10.md; source overview-screen.tsx dùng parseWorkerInstanceList. |
| Workflow test giả thành công, operation ID không có thật, link API keys chết | **ĐÃ ĐÓNG Ở MỨC SOURCE VÀ TEST OFFLINE.** Local simulation được ghi rõ là simulation; backend rejection/exception hiện FAILED; không tự sinh operation ID. Link API keys đã trỏ tới Profiles. | workflows-screen.tsx có nhánh backend/simulation tách biệt và chỉ nhận ID backend khi có; receipt AWEB-17 và verifier workflow simulation độc lập. Chưa có browser acceptance. |
| Thiếu Audit Console, server-side filters, tenant scope, cursor và CSV an toàn | **ĐÃ ĐÓNG CHO PHẠM VI AWEB-18.** Có route/nav /audit, filter severity/action/actor/resource/from/to, keyset cursor, tenant scope hiển thị và export trang hiện tại theo allowlist; dữ liệu tùy ý/message bị loại và ô CSV được trung hòa công thức. | features/audit/audit-screen.tsx và state.ts; receipt AWEB-18, audit-event-links 5/5 và deep-link boundary suite. CSV chỉ xuất trang đang hiển thị, không phải export toàn bộ kết quả lọc. API không có correlation-ID filter; UI giữ lại correlation ID từ URL và hướng người dùng sang Trace thay vì giả vờ đã lọc. |
| Không có Trace / Support Incident Workspace | **ĐÃ ĐÓNG PHẦN SCAFFOLD VÀ TỔNG HỢP HIỆN CÓ; CÒN GAP DỮ LIỆU BACKEND.** Có route/nav, lookup operationId/correlationId/taskId, timeline từ operation/task snapshot, usage aggregate và audit; payload preview được mask; có deep-link tới Operations/Audit. | features/trace/trace-screen.tsx và state.ts; receipt AWEB-19. API chưa hỗ trợ tìm server-side theo correlationId, task lookup bị giới hạn ở 500 operations gần đây, timeline không có đầy đủ state transition history hay webhook/outbox delivery. Vì vậy đây là workspace tra cứu hữu ích, chưa phải trace lifecycle đầy đủ. |
| Operations from/to chỉ lọc trong page đã tải | **ĐÃ ĐÓNG Ở SOURCE; KIỂM CHỨNG HẬU SỬA CHƯA ĐỘC LẬP.** from/to được chuyển thành biên ISO UTC inclusive và gửi qua query builder tới server; cursor cũ bị loại trước request khi tenant/filter population đổi, request đang chờ bị vô hiệu hóa. | operations-screen.tsx và features/operations/state.ts; backend parser/predicate trong list-query.ts; receipt AWEB-20a, receipt AWEB-20-UI. Verifier AWEB-20 trước đó tìm thấy request mang cursor tenant cũ trước khi effect reset; bản sửa mới đưa stale check vào load trước API call và owner receipt báo 82/82 cùng Vite build pass. Verifier chưa chạy lại trên đúng bản sửa mới nhất. |
| Bulk cancel dừng sau lỗi đầu và bỏ selection | **ĐÃ ĐÓNG VỀ LUỒNG PER-ITEM OFFLINE.** Tiếp tục qua target còn lại, chỉ bỏ selection thành công, giữ failed item và idempotency key, báo số thành công/thất bại/skipped cùng lỗi. | operations-screen.tsx cancelSelected; receipt AWEB-20b và harness 17/17, verifier kiểm tra selection/details. Việc giữ idempotency key được source-review nhưng harness không khẳng định trực tiếp; chưa có browser kiểm tra thao tác thực. |
| Link Trace/Audit tạo URL nhưng màn không hydrate | **ĐÃ ĐÓNG CHO TRACE VÀ AUDIT.** Trace đọc operationId/correlationId/taskId/tenantId; Audit ánh xạ operationId sang resource và đọc tenant/filter/time params, đồng thời bảo vệ tenant context. | useSearchParams trong trace-screen.tsx và audit-screen.tsx; receipt AWEB-21, test biên 8/8 và verifier/probe độc lập. Chưa có React Router/browser mounted test. **Còn một lệch link:** buildTraceLinks tạo /operations?id=..., nhưng Operations chưa hydrate id từ query string; cần đưa vào backlog deep-link riêng. |
| Contract list operations chưa đồng bộ from/to | **ĐÃ ĐÓNG BẰNG EVIDENCE CONTRACT.** Schema 8 tham số gồm from/to; conformance 19/19 và báo cáo contract suite 570/570. | receipt-orchestrator-operations-conformance-2026-10-10.md cùng verifier follow-up. Đây là bằng chứng ở snapshot của các lần chạy đó, không thay thế kiểm tra build/typecheck cuối hiện tại. |
| Workflow gắn Business và chọn schema theo business trong profile | **ĐÃ IMPLEMENT Ở MỨC SOURCE VÀ FOCUSED OFFLINE TEST; CHƯA ACCEPTED TÍCH HỢP.** Migration additive, business/version ownership và profile-workflow bindings đã có. | receipt-aweb-14-workflow-business-2026-10-10.md ghi 11/11 test, typecheck và không có DB/browser/independent review. Đây là nền tảng cho wave Business Services, không phải bằng chứng đã hoàn tất business lifecycle cockpit. |

## Readiness theo lớp

### Đã đạt ở lớp thiết kế và source

- Màn hình chính đã mở rộng từ portal cấu hình sang luồng hỗ trợ: Overview metrics, Operations recovery, Audit và Trace.
- Scope tenant được thể hiện rõ ở Audit; Overview kiểm tra response scope; cursor Operations tính theo tenant và các filter định hình population.
- Các chỗ dễ tạo niềm tin sai đã được sửa: sample không tự nhận là system total, simulation được ghi nhãn, backend failure không biến thành thành công, thao tác bulk báo kết quả một phần.
- Test offline tập trung bao phủ state/query, CSV safety, audit links, URL hydration và kết quả bulk. Một số GAP có kiểm thử độc lập chứ không chỉ dựa vào receipt của owner.

### Chưa đạt để tuyên bố nghiệm thu

- Không có bằng chứng browser/Playwright trên **cùng một build cuối** cho route/nav, tenant switching, cursor reset, deep-link hydration, export CSV và retry thao tác bulk.
- Không có bằng chứng PostgreSQL thật xác nhận semantics/hiệu năng percentile, tenant predicate và route authorization của metrics; các test mock/source không chứng minh migration hay dữ liệu live.
- Không có digest của deployed image để nối source được review với artifact đang chạy.
- Kết quả build/typecheck lịch sử bị lệch theo revision: một số receipt cũ ghi build hoặc typecheck fail ở Profiles/client types; các receipt sau ghi typecheck pass, còn AWEB-20-UI chỉ chạy Node tests và Vite build. Vite bundle build không thay thế TypeScript typecheck. Vì vậy typecheck/package build hiện tại phải được xác nhận lại bởi executor/reviewer trên exact source revision; coordinator không chạy thay.
- Bundle chính ở lần Vite gần nhất khoảng 1 MB và có advisory chunk lớn hơn 500 kB. Đây chưa phải blocker chức năng, nhưng ảnh hưởng thời gian tải trên máy vận hành yếu.
- AWEB-19 chưa thể đóng GAP tương quan và event history khi backend chưa cấp correlation query, transition history, webhook/outbox events.
- Plan giữ trạng thái lịch sử trong các mục đầu và tự chú thích tại §9 rằng §3 đã cũ. Không được đọc bảng cũ như trạng thái cuối, cũng không nên tick gate thay cho reviewer.

## Backlog hỗ trợ còn lại từ feedback frontend

Các mục dưới đây không phủ định việc đóng AWEB-17..21; chúng là usability/support gaps nằm ngoài acceptance hẹp của các packet:

1. Deep-link Operations theo id và lưu bộ lọc/page state trên URL để chia sẻ ca điều tra.
2. Nút copy operation/task/correlation/resource ID, cùng hiển thị error array có cấu trúc ở panel incident.
3. Hiển thị hạn rotation secret từ intervalDays/rotatedAt và hỗ trợ cảnh báo sắp đến hạn.
4. Hủy request khi đổi filter/rời màn, bảo vệ response cũ nhất quán ở toàn bộ màn hình, và làm rõ nút auto-refresh.
5. Chuẩn hóa cách ghi múi giờ giữa server UTC và browser local; hiển thị thời gian có nhãn múi giờ.
6. Kiểm tra lại tenant được nhớ trên máy hỗ trợ dùng chung, xác nhận nhất quán trước destructive actions và thêm recovery action cho global error boundary.
7. Tách các screen lớn thành phần nhỏ hơn khi tiếp tục phát triển để tránh chi phí sửa đổi và kiểm thử tăng dần.

Nên xếp các mục 1–4 vào wave UX support sau khi xử lý security P1 và có UI acceptance cho wave hiện tại. Các mục timezone, tenant-on-shared-workstation và destructive confirmation nên được xem cùng security/product policy, không chỉ giải quyết bằng microcopy.

## Wave tiếp theo: ưu tiên Security Remediation

### Lý do ưu tiên

Independent review orchestrator-security-review-2026-10-11.md và verify-orchestrator-security-INDEPENDENT-DSH2-2026-10-11.md xác nhận bốn finding High/P1 trên revision được kiểm tra; verifier khớp 10/10 source hashes và tái hiện process crash ở SEC-04. Chưa có xác nhận image/deployment. Ba finding liên quan tenant fence, credential egress và encryption real-data; mức rủi ro cao hơn giá trị của việc mở thêm business console. Bản thân frontend không thể bù authorization lỗi ở legacy backend.

### Đề xuất chia wave security

| Ưu tiên | Finding | Đầu ra cần có để xem xét đóng |
|---|---|---|
| P1.1 | SEC-01 — legacy admin session operator/viewer mất tenant principal và legacy read path dùng platform credential cùng tenant filter do request điều khiển | Mang identity/role/tenant principal xuyên suốt BFF tới data authorization, hoặc đóng legacy data routes cho role không đủ quyền. Test âm chứng minh operator tenant A không đọc được tenant B và viewer không vượt scope bằng query; xác minh cả audit/overview/operations legacy route. |
| P1.2 | SEC-04 — upstream trả 204 làm Node process thoát từ ClientRequest callback | Xử lý response status không body hợp lệ theo Fetch Response, bắt lỗi trong promise boundary; test 204/205/304 và status/error stream phải xác nhận caller nhận typed result/rejection, process tiếp tục sống. |
| P1.3 | SEC-03 — bootstrap real-data ghi plaintext vào object storage, bỏ qua encrypted writer/policy | Dùng encrypted write path và policy flag thống nhất với mọi ingestion entrypoint; test fake storage kiểm tra ciphertext/envelope và fail-closed khi key/policy thiếu. Xác minh đường migrate/read legacy object riêng. |
| P1.4 | SEC-02 — mode warn vẫn gửi credential tới origin chưa allowlist | Hoàn tất inventory origin hợp lệ, staged rollout và telemetry; sau đó mặc định enforce và fail trước network call cho origin chưa duyệt. Test assertion header credential không được gắn khi bị từ chối. Không bật enforcement mù khi chưa rà soát cấu hình tenant. |

Acceptance của security wave cần verifier độc lập trên exact source hash và regression test offline; sau đó cần xác nhận deployment/image digest trước khi dùng dữ liệu thật hoặc tuyên bố cách ly tenant production. Với SEC-02 cần chứng minh danh sách origin được duyệt và rollout; với SEC-01 cần test tenant-boundary end-to-end. Không coi UI ẩn control là hàng rào bảo mật.

## Wave sau security: Business Services

Sau khi P1 được khắc phục và kiểm chứng, mở Business Services thành một wave riêng, nối Business → version → worker → profile → workflow thành cùng một góc nhìn vận hành:

1. **Business catalog có tìm kiếm và keyset pagination**, kèm hiển thị rõ cap/total; bỏ phụ thuộc danh sách cố định 50 business.
2. **Business detail cockpit** tổng hợp version, trạng thái enablement, worker_instances thực, profile bindings và workflow schema bindings; empty/unavailable/error phải phân biệt.
3. **Version change impact preview** liệt kê workflow/profile/worker dependencies trước activate/deactivate/retire, có kết quả rõ ràng và audit reference. Chỉ gọi là dry-run nếu backend thật sự tính và trả kết quả dry-run.
4. **Lifecycle action có kiểm soát**: preview affected resources, xác nhận thao tác có tác động rộng, per-item outcome cho bulk changes và link tới audit events.
5. **Business-to-incident deep links** mở Trace theo operation/task/correlation nếu API hỗ trợ, và mở Audit đã scope đúng tenant/business/version.

Wave này tái sử dụng migration AWEB-14 và persisted worker inventory AWEB-11C; không nên thêm trạng thái frontend giả hoặc nhân bản business/version data sang client-owned registry. Trước khi dispatch, cần chốt contract backend cho pagination, dependency preview và quyền theo tenant.

## Quyết định điều phối đề xuất

- Giữ Admin Workspace là **IMPLEMENTED / OFFLINE-VERIFIED PER RECEIPT, NOT ACCEPTED** cho đến khi có typecheck/package build trên đúng tree và independent UI verdict trên đúng build.
- Dispatch Security Remediation trước Business Services; giữ mỗi finding một lease rõ, kèm raw output, source hash và owner/verifier riêng.
- Sau security, mở Business Services với contract backend trước, sau đó mới làm cockpit và lifecycle UI.
- Giữ các gap backend của Trace, Operations URL deep-link và support UX trong backlog có owner, không đánh dấu như đã đóng bởi các receipt hiện tại.
- Plan/gate không được thay đổi trong lượt đánh giá này.

