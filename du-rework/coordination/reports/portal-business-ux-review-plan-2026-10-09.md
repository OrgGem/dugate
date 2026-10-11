# Portal mới: review nghiệp vụ và kế hoạch cải tiến — 2026-10-09

## Phạm vi

Review source tại `orchestrator/apps/admin-web/src`, client/BFF/action dispatcher liên quan; đối chiếu `docs/portal-request-management.md`, `docs/admin-ui-development-contract.md` và `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` (UBW/AP).

Đây là review tĩnh trên working tree, chưa chạy browser hoặc kiểm tra pixel/contrast/responsive thực tế, chưa chạy test. Không cấp UI_APPROVED. Vị trí dòng là tại thời điểm đọc; working tree có thay đổi chưa commit. Chỉ viết báo cáo/plan đề xuất, không thay source hay trạng thái task, không dispatch.

## Nhận định

Portal đã có nền: navigation nhóm màn, tenant selector, BFF cùng origin, session/CSRF, operation detail/download/cancel/retry, profile revision, connector lookup/test, workflow catalog, usage và audit. Nên giữ các khả năng này.

Vấn đề chính: UI đang tổ chức theo tài nguyên kỹ thuật, trong khi người dùng cần hoàn thành công việc xuyên màn. Hành trình cần rõ là **chọn tenant → chọn dịch vụ/quy trình → cấu hình và kiểm tra → chạy yêu cầu → xem/duyệt kết quả → xử lý ngoại lệ → theo dõi chi phí**. Trước khi bổ sung biểu đồ hoặc builder, phải bảo đảm trạng thái và số liệu hiện tại đáng tin.

## Findings từ code

| ID | Ưu tiên | Evidence | Ảnh hưởng nghiệp vụ / hướng sửa |
|---|---|---|---|
| PUX-01 | P0 | `features/workflows/workflows-screen.tsx:376–414` | Test lỗi API hoặc exception đều thành SIMULATED_SUCCESS, còn nhánh thành công tự tạo operationId nếu thiếu và điền stagesCompleted từ catalog. Dispatcher chỉ thấy workflow.provision/retire, không thấy workflow.test. Người dùng có thể hiểu workflow đã chạy dù chưa có execution. Hiển thị lỗi thật; tắt Run nếu thiếu capability; ACCEPTED chỉ là đã tiếp nhận, chỉ báo hoàn tất khi operation thực sự terminal. Demo phải là chế độ riêng có nhãn, không là fallback lỗi. |
| PUX-02 | P0 | `features/overview/overview-screen.tsx:299–306`; `overview-metrics.ts:240` và `computeWorkerTelemetry` | Overview lấy tối đa 100 operations rồi tính tổng/tỷ lệ/biểu đồ nhiều tháng tại browser; đổi timeframe không truy vấn toàn bộ khoảng đó. Worker count là số business rows, queue/version có fallback suy đoán. Các trạng thái chưa terminal đều tính running; success rate dùng toàn bộ mẫu làm mẫu số. Đổi nhãn thành thống kê mẫu ngay; tiếp theo dùng aggregate API thật và tách registry metadata khỏi worker heartbeat. |
| PUX-03 | P0 | `features/usage/usage-screen.tsx:87–118`; `features/workflows/workflows-screen.tsx:238–268`; `lib/tenant-context.tsx:29–57` | Usage giữ last-good data không gắn tenant/query và không chống response đến sai thứ tự. Chuyển A→B có thể hiện số A dưới nhãn B, hoặc response A về muộn ghi đè B. Workflows cũng thiếu request fencing khi đổi tenant; chỉ giữ selection theo slug. Selector chỉ tải 100 tenant rồi tự chọn fallback. Không kết luận vượt quyền server; đây là lỗi scope hiển thị có thể dẫn đến thao tác nhầm. Key mọi request/draft/detail bằng scope, loại stale response, clear dữ liệu khi đổi scope, phân trang/search tenant. |
| PUX-04 | P1 | `features/operations/operations-screen.tsx:79–86, 177–193, 223, 272` | Date filter chỉ lọc trang đã tải, không tìm toàn bộ dữ liệu; state dropdown thiếu QUEUED/WAITING_INPUT/PENDING_INGESTION. Các case cần can thiệp khó tìm. Đưa filter về server, thêm nhóm trạng thái nghiệp vụ và saved views; count/cursor phải dùng cùng bộ filter. |
| PUX-05 | P1 | `features/operations/operations-screen.tsx:60, 104, 141–165`; `router.tsx:44` | Timer chỉ tăng elapsed, không refresh state. Detail là state local, không có route operation riêng; bulk cancel không có confirmation như single cancel, dừng ở lỗi đầu rồi clear selection và load lại (load xóa detailProblem). Khó chia sẻ case, theo dõi tiến trình hoặc biết hàng nào đã hủy. Thêm deep link, refresh có data age, confirm bulk và outcome từng hàng được giữ lại. |
| PUX-06 | P1 | `features/operations/operations-screen.tsx:613–679` | Timeline nối task theo thứ tự mảng thành chuỗi ngang, chưa có evidence dependency edges trong rendering. Task song song/retry có thể bị hiểu là các bước tuần tự. Trước khi có event/dependency DTO, hiển thị task list với timestamp/attempt; chỉ vẽ DAG từ quan hệ thật, không suy ra phần trăm tiến độ từ vị trí task. |
| PUX-07 | P1 | `features/profiles/profiles-screen.tsx:535–550, 748–758, 1110–1118`; `workflows-screen.tsx:902–951` | Profile chứa task ID, wire/dispatcher/API path và thông báo backend chưa shipped trong màn nghiệp vụ; effective preview chưa có. Workflow chủ yếu preset hoặc JSON import. Người cấu hình chưa được dẫn qua validate → test → xem thay đổi → publish. Giữ thông tin kỹ thuật ở Advanced/diagnostics; bổ sung wizard và validation theo trường, effective config/impact/diff từ backend. |
| PUX-08 | P2 | `app-shell/app-shell.tsx:16–21, 105–119`; `routes/bootstrap-home.tsx:35–48` | Menu hiển thị mọi nhóm tài nguyên; health hạ tầng chiếm banner toàn cục; trang vào mặc định là bootstrap kỹ thuật; text Anh/Việt trộn giữa các màn. Đưa công việc cần xử lý lên trang đầu, menu theo capability, thu gọn health thành chỉ báo có drilldown, thống nhất ngôn ngữ và timezone. |

P0 ở đây là ưu tiên sửa để người vận hành có thể tin kết quả UI, không phải xếp loại lỗ hổng bảo mật.

## UI đề xuất theo công việc

### 1. Trang đầu: Hộp việc cần xử lý

- Các nhóm: chờ duyệt/bổ sung, thất bại có thể xử lý, gần quá hạn, đang xử lý, hoàn tất gần đây. Mỗi số mở đúng danh sách với cùng tenant/filter/time window.
- Mỗi hàng: mã yêu cầu + tên hồ sơ/tài liệu đã redaction, quy trình/profile, trạng thái dễ hiểu, thời gian chờ, deadline, nguyên nhân và hành động tiếp theo.
- Operator thấy công việc trong scope của mình; người cấu hình thấy draft/chưa publish; platform admin thấy health/worker ở khu vực vận hành riêng.
- Ban đầu dùng saved filters cho exception queue. Assignee, SLA nghiệp vụ, ghi chú và escalation cần model/API/audit riêng, không giả lập bằng local state.

### 2. Yêu cầu: một trang detail có thể chia sẻ

URL đích `/admin/operations/:id`; tenant context phải được xác thực theo resource, không tự tin query string. Bộ lọc list lưu trong URL để Back giữ nguyên ngữ cảnh.

Layout đề xuất:

| Vùng | Nội dung |
|---|---|
| Header cố định | Tên/mã, tenant, trạng thái, profile/workflow revision, thời gian cập nhật, hành động chính theo quyền/trạng thái |
| Tổng quan | Nguồn, tổng thời gian/queue/execution/wait nếu có dữ liệu thật, deadline, retry chain, lỗi và gợi ý xử lý |
| Tài liệu & kết quả | Danh sách file, preview an toàn, bảng field trích xuất, Markdown/JSON theo loại output, tải artifact |
| Tiến trình | Event timeline + task/attempt; dependency graph chỉ khi backend trả edges; phân biệt đang chạy/chờ provider/chờ người dùng |
| Lịch sử | Ai submit/cancel/retry/resume, timestamp, lý do, correlation ID copy được, audit liên quan |

Nên bổ sung result viewer qua renderer registry theo output schema. Chỉ hiển thị nguồn trang/đoạn hoặc confidence khi business trả provenance/confidence thật; không tự gán độ tin cậy cho mọi model. Không render HTML/Markdown/file không tin cậy mà thiếu sanitize/sandbox và artifact authorization.

### 3. Tạo và chạy thử yêu cầu

Wizard: chọn dịch vụ hoặc workflow đã publish → profile/revision → upload/tài liệu mẫu + input schema → kiểm tra điều kiện → xác nhận chạy → chuyển tới operation thật.

- Validation cấu trúc không gọi provider tách khỏi chạy thử có thực thi. Run test hiển thị tenant, target revision, loại dữ liệu, giới hạn và cảnh báo chi phí khi có provider call.
- Khi backend trả 202, hiển thị “Đã tiếp nhận” cùng operation ID thật. Không bịa tiến trình, stage hoặc estimated cost. Không có pricing thì ghi chưa có giá, không ghi 0.
- Kết quả run liên kết ngược tới cấu hình đã pin; từ lỗi có thể mở đúng connector/profile cần kiểm tra.
- Reuse runtime/profile admission hiện có; không thêm một test executor riêng chỉ để phục vụ UI.

### 4. Workflow và Profile: cấu hình có dẫn dắt

Wizard workflow đầu tiên nên là **step list**, gồm chọn action từ catalog → nối output/input → cấu hình connector slot → validate → test → publish revision. Advanced JSON vẫn có cho kỹ thuật. Chưa đầu tư canvas drag-and-drop trước khi contract node/mapping/executor được chốt trong UBW-04.

- Preset là bản nháp khởi đầu; kiểm tra dependency có thật và yêu cầu mapping connector trước khi dùng. Không ngầm coi business ID là connector instance hợp lệ.
- Profile chia nhóm: thông tin cơ bản, input/định dạng, từng bước & connector, prompt/parameters, output/callback, bảo mật/giới hạn. Advanced đóng mặc định.
- Hiển thị **Draft / Published revision / Effective active revision** riêng; summary “thay đổi này áp dụng cho yêu cầu mới”, còn operation cũ giữ snapshot.
- Trước publish: validation theo field, diff có nghĩa nghiệp vụ, effective config đã redaction và impact tới binding/API key. Rollback chọn revision có lý do, không chỉ “revision trừ 1”.
- Dirty-draft guard khi chuyển route/tenant; 409 giữ draft và cho so sánh với revision mới. Không persist secret vào browser storage.

### 5. Kết nối và triển khai nghiệp vụ

- Connector cards hiển thị tên/khả năng, active revision, credential configured/expiry nếu backend có, last probe timestamp và kết quả. Không coi probe chưa chạy là healthy.
- Luồng tạo: chọn adapter → endpoint → secret reference → mapping → test → review → activate. cURL import là Advanced, có preview/redaction trước lưu.
- Trước disable/retire/rotate: hiển thị profile/workflow nào phụ thuộc và hành vi với operation đang chạy. Đây cần dependency API, không suy đoán từ danh sách hiện tại.
- Workers tách khỏi Businesses: business/version là catalog; instance health phải dựa heartbeat/lastSeen/digest/capacity. Desired state và observed acknowledgement khác nhau.

### 6. Chi phí và chất lượng

- Usage filter theo tenant, khoảng thời gian, business/profile/workflow, connector/model; drilldown tới operation gây phí/lỗi.
- Hiển thị currency, pricing version và trạng thái reconciled/partial khi có; lỗi load là unavailable, không phải 0. Export dùng cùng filter/authorization/redaction.
- Thống nhất định nghĩa metric: success rate trên terminal executions với denominator rõ; pending không tự trở thành failure; tách cancelled, timeout và business validation failure. Báo elapsed/queue/wait theo timestamp thật; dùng p50/p95 khi aggregation hỗ trợ.
- So sánh hai revision bằng cùng test fixtures là tính năng giai đoạn sau; kết quả đánh giá nghiệp vụ cần expected outputs/rubric do business owner định nghĩa.

## Information architecture đề xuất

| Nhóm | Màn |
|---|---|
| Công việc | Tổng quan công việc, Yêu cầu, Cần duyệt/bổ sung (saved view ban đầu), Chạy thử |
| Cấu hình nghiệp vụ | Workflow, Profile, Dịch vụ & phiên bản |
| Vận hành | Connectors, Workers, Usage/chi phí, Audit |
| Quản trị | API keys, Identity, Secrets, Security, Settings |
| Trợ giúp | Hướng dẫn theo hành trình, API Reference |

Mỗi role chỉ thấy nhóm phù hợp, nhưng backend vẫn enforce quyền. Tenant, environment và timezone đặt ở header, luôn nhìn thấy khi mở dialog hành động. Platform-wide view phải có nhãn rõ và chỉ dành cho quyền phù hợp; không để tên tenant ở sidebar khiến người dùng tưởng mọi pane đều scope tenant đó.

## Plan bàn giao

Plan này là **review delta** của UBW/AP hiện hành, không tạo dispatcher hoặc canonical backlog cạnh tranh. Coordinator ánh xạ PUX vào `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`, xác minh live lease trước giao. Không coi trạng thái AP cũ là acceptance cho mọi hunk hiện có trong cùng file.

| Mốc | Packet | Nội dung | Owner đề xuất | Acceptance chính |
|---|---|---|---|---|
| M0 | PUX-00 | Snapshot code/build, role/action matrix, scope model, wireframe ba journey; ánh xạ UBW/AP | Analyst + UI designer | Chốt persona, scope, DTO/capability và metric definitions; có loading/empty/403/409/stale |
| M1 | PUX-01 | Sửa workflow test false success; capability gate, real operation link | UI + BFF/runtime owner | 403/404/500/offline không thành success; 202 chưa hiện completed; operation ID từ server |
| M1 | PUX-02 | Sửa scope/races/tenant pagination; query freshness | UI foundation + BFF owner | A chậm/B nhanh không hiện dữ liệu A dưới nhãn B; đổi tenant khi đang edit/mutate được xử lý rõ; >100 tenants tìm được |
| M1 | PUX-03 | Sửa metric labels/fallback và health unknown; chuẩn bị aggregate DTO | Overview + telemetry owner | Sample được ghi rõ; không đếm business thành worker; no-data khác zero; failed refresh không đánh dấu fresh |
| M2 | PUX-04 | Operations server filters, URL/deep links, refresh, bulk result | Operations UI + BFF/query owner | Tìm bản ghi ngoài trang đầu; Back/reload giữ filter; bulk partial failure giữ từng outcome; live state cập nhật, không chỉ elapsed |
| M2 | PUX-05 | Request workspace, result viewer, exception saved views | UI + artifact/business owner | Một hành trình từ tìm yêu cầu → đọc kết quả/lỗi → hành động → audit; tenant fences và file preview an toàn |
| M3 | PUX-06 / UBW-04..06 | Workflow/profile wizard, effective config, validate/diff/test/publish | Profile/workflow/runtime owners | Draft→validate→real run→publish→reload, exact revisions, 409 giữ draft, input/output mapping thực chạy |
| M3 | PUX-07 / UBW-02..03 | Connector impact + worker telemetry, setup journey | Connector/registry/UI owners | Health từ probe/heartbeat; disable/drain có impact và acknowledgement; business mới không tự active |
| M4 | PUX-08 | Human review, assignments/SLA, cost drilldown, revision evaluation | Business + platform owners | Chốt storage/auth/audit/schema trước UI; accept theo từng business use case |
| Mỗi mốc | PUX-VFY / UBW-07..08 | Browser và functional verification độc lập, UX review | Tester + reviewer khác implementation owner | Cùng SHA/image, raw evidence, pass/fail/skip; UI_APPROVED cho đúng journey/build |

M1 là prerequisite để tin UI. M2 tạo giá trị vận hành trực tiếp. M3 phụ thuộc backend contracts, không thể hoàn thành bằng frontend đơn thuần. M4 chọn theo nhu cầu nghiệp vụ thực tế; chưa cần làm tất cả ngay.

## Ba hành trình nghiệm thu ưu tiên

1. **Operator xử lý lỗi:** chọn tenant → lọc toàn bộ yêu cầu lỗi hôm nay → mở deep link → đọc nguyên nhân + tài liệu → retry/cancel đúng quyền → thấy operation mới/trạng thái thật → audit có actor. Lỗi từng hàng trong bulk không bị mất.
2. **Người cấu hình đưa workflow vào dùng:** tạo draft từ preset → mapping các bước/connector hợp lệ → validate → run test có artifact thật → xem result → diff → publish → reload vẫn đúng revision; operation trước publish không đổi snapshot.
3. **Reviewer bổ sung/duyệt dữ liệu:** mở WAITING_INPUT → xem source/output và input schema → gửi dữ liệu qua resume với expected state/wait ID → nhận conflict nếu người khác đã xử lý → theo dõi terminal result. Bước này chỉ mở khi BFF và quyền/audit đã đủ.

Ngoài happy path phải kiểm: hai tenant và response đảo thứ tự, viewer/operator/admin, session hết hạn, lỗi 403/409/422/5xx, lost response sau mutation, keyboard/focus/dialog, màn 320/768/1440px, text dài, dữ liệu trống, timezone và screen reader status. Việc review này chưa chạy các kiểm chứng đó.

## Kết quả mong muốn

Portal giúp người dùng trả lời nhanh: **đang có việc gì cần làm, vì sao yêu cầu dừng/lỗi, thao tác nào được phép, thay đổi cấu hình ảnh hưởng ai, kết quả thực tế và chi phí là gì**. Đo bằng thời gian tìm/xử lý case, số bước hoàn thành journey, lỗi thao tác và task completion trong usability test; lấy baseline trước khi đặt mục tiêu cải thiện phần trăm.
