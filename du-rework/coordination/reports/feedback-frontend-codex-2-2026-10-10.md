# Đánh giá độc lập: Orchestrator Admin Web

**Ngày:** 2026-10-10  
**Góc nhìn:** nhân viên hỗ trợ và quản trị hệ thống du-rework

## Phạm vi và cách đánh giá

Đã đọc các màn Overview, Operations, Profiles, Businesses, Workflows, phần Audit nhúng trong Overview, cùng router, app shell, tenant context và API types của `apps/admin-web`. Với vấn đề phạm vi tenant trên Overview, đã đối chiếu BFF và route đọc operations để xác nhận tác động của query hiện tại. Đây là đánh giá tĩnh từ mã nguồn; không chạy UI, gọi môi trường đang hoạt động hay chạy test, nên các nhận xét mô tả hành vi có thể suy ra từ code, không khẳng định kết quả runtime.

## Nhận xét tổng quan

Admin Web đã có các màn hình hữu ích cho công việc thường ngày: điều hướng theo nhóm, chọn tenant dùng chung, xem trạng thái và chi tiết operation, cũng như thao tác trên workflow và cấu hình. Tuy nhiên, các điểm yếu đáng chú ý tập trung ở độ tin cậy của thông tin vận hành: một số con số không đúng phạm vi/thời gian người dùng chọn, một số luồng có thể báo thành công giả, và việc tìm lại audit hay dữ liệu cũ còn phụ thuộc vào trang dữ liệu đang tải.

## Điểm yếu quan sát được

### 1. Mức cao — Workflow test có thể hiển thị thành công dù request thất bại

`handleExecuteTest` gửi action `workflow.test`. Khi server trả lỗi hoặc request ném exception, cả hai nhánh đều đặt trạng thái `SIMULATED_SUCCESS`, tạo operation ID giả và dựng danh sách node tĩnh. Khi server trả thành công, giao diện vẫn tự tạo operation ID nếu response thiếu ID và lấy `stagesCompleted` từ catalog workflow, không phải trạng thái hoàn tất do server xác nhận. Vì vậy operator có thể hiểu nhầm workflow đã chạy hoặc đã qua các stage, rồi dùng kết quả đó để hỗ trợ khách hàng.

Tham chiếu: [workflows-screen.tsx](../../orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx#L376), đặc biệt các nhánh success/error/exception ở dòng 386–414.

### 2. Mức cao — Overview có thể không theo tenant đang chọn

Overview gọi `listOperations` với limit và sort nhưng không gửi tenant đang chọn ([overview-screen.tsx](../../orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx#L324)). Trong khi đó, phần mô tả ghi rằng dữ liệu đã được giới hạn theo active global tenant (dòng 402). BFF chỉ thêm `tenant` vào upstream nếu có scope khác rỗng ([operations.ts](../../orchestrator/services/orchestrator/src/app/admin/bff/operations.ts#L170)); route operations chuyển scope rỗng của platform principal thành `null`, tức truy vấn không lọc tenant ([public.ts](../../orchestrator/services/orchestrator/src/http/routes/public.ts#L439)). Với platform admin, các metrics/biểu đồ operations trên Overview do đó có thể tổng hợp nhiều tenant dù selector đang hiển thị một tenant. Đây là sai lệch phạm vi hiển thị; đối chiếu này không cho thấy tenant operator vượt qua hàng rào phân quyền server.

### 3. Mức trung bình — Metrics và biểu đồ Overview dựa trên tối đa 100 operations mới nhất

Overview chỉ lấy 100 operations mới nhất ([overview-screen.tsx](../../orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx#L324)). Dashboard tính telemetry và các time bucket trực tiếp từ danh sách này ([operations-monitor-dashboard.tsx](../../orchestrator/apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx#L55)); bộ chọn timeframe lại bao gồm 60 phút, 24 giờ, 7 ngày, 4 tuần và 6 tháng (dòng 64–69). Telemetry cũng đếm toàn bộ phần tử đầu vào ([overview-metrics.ts](../../orchestrator/apps/admin-web/src/features/overview/overview-metrics.ts#L229)). Ở hệ thống có lưu lượng cao, 100 bản ghi có thể chỉ đại diện một lát thời gian ngắn, khiến tổng số, tỷ lệ thành công và biểu đồ không phản ánh trọn khoảng người dùng chọn.

### 4. Mức trung bình — Audit chưa có màn tra cứu độc lập và chỉ tìm trong một trang gần nhất

Router có route cho Overview, Operations, Profiles và các màn khác nhưng không có route Audit; menu shell cũng không có mục Audit ([router.tsx](../../orchestrator/apps/admin-web/src/router.tsx#L40), [app-shell.tsx](../../orchestrator/apps/admin-web/src/app-shell/app-shell.tsx#L15)). Audit chỉ được tải với `limit: '50'` trên Overview ([overview-screen.tsx](../../orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx#L297)). Bộ lọc severity và ô tìm kiếm chạy trên `items` của trang đã tải, không tìm tiếp trên server ([overview-screen.tsx](../../orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx#L595)); giao diện chỉ thông báo số kết quả so với tổng và page limit ở dòng 768–770. Khi xử lý sự cố cũ, operator khó xác định sự kiện có tồn tại ngoài 50 bản ghi này hay không.

### 5. Mức trung bình — Bộ lọc ngày Operations không truy vấn lịch sử; kết quả bulk cancel khó kiểm toán

Code ghi rõ bộ lọc thời gian chỉ áp dụng cho trang đã tải ([operations-screen.tsx](../../orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx#L64), #L178–193); giao diện cũng nhắc điều đó ở dòng 270. Người dùng phải tự duyệt từng trang để tìm dữ liệu cũ, và một trang không có kết quả sau lọc không đồng nghĩa khoảng thời gian đó không có operation.

Bulk cancel dừng tại request lỗi đầu tiên nhưng sau đó luôn xóa selection; nếu một số request trước đã thành công thì không có tóm tắt theo từng operation ([operations-screen.tsx](../../orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx#L141)). Điều này làm operator phải tự kiểm tra lại trạng thái từng dòng để biết phần nào đã được xử lý.

### 6. Mức trung bình — Tenant selector có thể tự đổi tenant đã lưu khi danh sách dài

Tenant context chỉ yêu cầu 100 tenant và đọc `items`, không theo cursor ([tenant-context.tsx](../../orchestrator/apps/admin-web/src/lib/tenant-context.tsx#L29)). Nếu tenant lưu trong local storage không có trong trang đầu, code xem lựa chọn hiện tại là không hợp lệ rồi tự chọn tenant default/đầu tiên và ghi đè lựa chọn đã lưu ở dòng 37–53. Nếu lần tải đầu thất bại, selector vẫn có thể ở trạng thái danh sách rỗng và hiển thị “No tenants available” ([global-tenant-selector.tsx](../../orchestrator/apps/admin-web/src/components/ui/global-tenant-selector.tsx#L21)); lỗi tải không được phân biệt với tenant list thực sự rỗng.

### 7. Mức trung bình — Businesses không có đường duyệt vượt quá 50 kết quả

Businesses tải `limit: '50'` ([businesses-screen.tsx](../../orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx#L39)), giao diện chỉ render `items` nhận được (dòng 177–219), và `BusinessPage` không có cursor trang tiếp theo ([types.ts](../../orchestrator/apps/admin-web/src/lib/api/types.ts#L370)). Khi registry vượt 50 mục, màn hình hiện tại không cung cấp tìm kiếm hoặc phân trang để tra business phía sau.

### 8. Mức thấp — Thông báo trạng thái Profiles tự mâu thuẫn

Các cờ `policyShipped` và `canTest` đang được đặt `true` ([profiles-screen.tsx](../../orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx#L311)), nên nút Test Endpoint không bị khóa ở dòng 759. Nhưng banner cùng màn hình nói dispatcher hiện trả `404 ACTION_NOT_FOUND` và action đang bị tắt (dòng 557–561). Đây là dấu hiệu copy hoặc trạng thái gating đã lỗi thời; operator không thể dựa vào banner để biết action có thực sự dùng được không. Màn hình cũng nói rõ chưa có effective config preview do read wire chưa cung cấp trường `effective` (dòng 1112–1120), nên so sánh cấu hình đã hợp nhất còn thiếu.

## Những điểm đang hỗ trợ vận hành tốt

- App shell gom các màn chính theo Workspace, Configuration và Administration; selector tenant được dùng chung thay vì phải chọn tenant riêng từng màn ([app-shell.tsx](../../orchestrator/apps/admin-web/src/app-shell/app-shell.tsx#L15)).
- Operations có chi tiết operation và selection cho cancel; giới hạn của lọc ngày được nói rõ trong code/UI thay vì bị che giấu ([operations-screen.tsx](../../orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx#L64), #L141).
- Nhiều màn có trạng thái loading, empty, denied/error và thao tác retry; đây là nền tảng tốt để support phân biệt dữ liệu trống với một số lỗi đọc.

## Tính năng nên bổ sung

1. **Support Case Explorer:** một ô tra cứu chung theo operation ID, correlation ID, tenant, artifact hoặc request ID; gom operation, task attempts, audit, callback và lỗi liên quan vào một trang có link chia sẻ nội bộ. Hiển thị payload đã redaction và cho phép copy correlation ID để chuyển tiếp sự cố.
2. **Audit Explorer riêng:** lọc server-side theo thời gian, actor, severity, kind, resource và tenant; cursor pagination, export, tổng số rõ ràng, cùng liên kết từ event sang operation/resource liên quan. Trang cần giữ nguyên scope tenant đang chọn và hiển thị phạm vi đó cạnh kết quả.
3. **Workflow Run Console đáng tin cậy:** tách “validate/dry run” khỏi “start execution”; chỉ hiển thị operation ID do server trả về, poll trạng thái thực tế, timeline theo từng node và lỗi/attempt. Sinh input form theo kiểu dữ liệu và validation của schema; vẽ graph từ cạnh/nhánh thực trong schema thay vì nối tuyến tính theo thứ tự node.
4. **Operations Recovery Workspace:** tìm kiếm thời gian và trạng thái phía server, xem backlog/tuổi queue, lease hoặc task stalled và worker health; với retry/cancel hàng loạt, preview danh sách tác động và báo thành công/thất bại theo từng ID, giữ lại các mục chưa xử lý.
5. **Configuration Change Center:** diff revision Business/Profile/Workflow, effective preview theo tenant, xem nơi cấu hình được dùng và tác động trước khi publish/activate; hỗ trợ rollout có kiểm tra, lịch sử người thao tác và rollback. Nếu một capability chưa được backend hỗ trợ, màn hình nên khóa action và nêu trạng thái thật nhất quán.

## Kết luận

Frontend hiện đủ cho một số thao tác cơ bản nhưng chưa phải nguồn tin đáng tin cậy duy nhất cho triage: workflow test có thể báo giả thành công, còn Overview có thể trình bày sai scope và độ bao phủ thời gian. Ưu tiên sửa độ trung thực của trạng thái và số liệu trước; sau đó đầu tư tìm kiếm server-side, audit độc lập và công cụ recovery để giảm thời gian hỗ trợ phải dò nhiều màn hoặc kiểm tra thủ công.
