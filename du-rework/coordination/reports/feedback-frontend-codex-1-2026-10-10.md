# Đánh giá độc lập frontend Orchestrator — Codex — 2026-10-10

## Phạm vi và cách đánh giá

Đánh giá mã nguồn `du-rework/orchestrator/apps/admin-web`, tập trung vào Overview, Operations, Businesses, Profiles, Workflows và đường dẫn Audit từ góc nhìn nhân viên hỗ trợ/quản trị. Đây là review tĩnh trên mã nguồn hiện có; không chạy browser, gọi API thật hoặc kiểm thử deployment.

Working tree đã có thay đổi chưa commit trong `admin-web`, gồm sửa `app-shell.tsx`, `router.tsx`, API client/types và xóa các file màn hình/route API keys. Tôi không sửa các thay đổi này. Nhận xét dưới đây mô tả snapshot trên đĩa tại thời điểm review; cần đối chiếu lại với commit/build phát hành, nhất là finding về liên kết API keys.

## Điểm đang hỗ trợ vận hành tốt

- App shell hiển thị session, tenant đang chọn, trạng thái DB/Redis/queue integrity, active leases, outbox backlog và tuổi dữ liệu; tenant lựa chọn được lưu ở local storage. Các màn có trạng thái loading, empty, denied và error riêng.
- Operations có phân trang cursor, lọc state và ID, xem task/artifact/timeline, hiển thị correlation ID, cùng hành động Stop/Retry được giới hạn theo role.
- API client dùng same-origin Admin BFF và session cookie; mutation mang CSRF token và có thể gửi idempotency key. Profiles có effective-config preview, publish/rollback và kết quả save theo từng dòng.

## Điểm yếu quan sát được

1. **Phạm vi và độ đầy đủ của số liệu Operations trên Overview không đáng tin cậy.** UI ghi dữ liệu được scope theo tenant đang chọn (`overview-screen.tsx:402`), nhưng lời gọi tại `:327` chỉ gửi `limit: 100` và không gửi tenant. BFF đọc `tenant` từ query cho platform admin và khi query vắng thì không thêm tenant filter (`orchestrator/services/orchestrator/src/app/admin/bff/operations.ts:170-186`), nên Overview của platform admin có thể tổng hợp Operations từ mọi tenant dù selector đang chọn một tenant. Ngoài ra, client-side metrics (`overview-metrics.ts:71,196,229`) chỉ dùng 100 operation mới nhất; khung sáu tháng không kéo dữ liệu sáu tháng. Khi call Operations lỗi, lỗi cũng bị bỏ qua (`overview-screen.tsx:327-332`) và không đánh dấu chu kỳ load thất bại, nên nhãn tuổi dữ liệu vẫn có thể báo fresh (`:357`). Cần scope, mẫu và độ mới nhất được thể hiện nhất quán trước khi dùng các số này để quyết định xử lý sự cố.

2. **Bảng Workers không phản ánh tình trạng worker thực.** Overview lấy Businesses (`overview-screen.tsx:337`); `computeWorkerTelemetry` tạo một hàng worker cho mỗi business và tự dựng queue name từ business/version (`overview-metrics.ts:270-301`). Dashboard gọi đây là worker services đã kết nối, hiển thị chấm xanh nhấp nháy và badge success (`operations-monitor-dashboard.tsx:461-508`), nhưng trạng thái đầu vào là business registry, không phải heartbeat hoặc consumer health. Người trực có thể kết luận nhầm worker đang sống khi chỉ biết business được đăng ký.

3. **Workflow test chuyển lỗi API thành kết quả mô phỏng thành công.** Khi `workflow.test` trả lỗi hoặc ném exception, `workflows-screen.tsx:376-410` vẫn tạo `SIMULATED_SUCCESS`, sinh `sim-op-*` và ghi các node/stage giả định. UI có badge ghi rõ trạng thái mô phỏng, nhưng phần kết quả vẫn dùng dấu kiểm và tiêu đề “Kết Quả Thực Thi”; nhân viên hỗ trợ phải đọc JSON/message để phân biệt với lần chạy thật. Lỗi backend và simulation nên là hai trạng thái riêng, và chỉ simulation được chọn rõ ràng mới sinh kết quả mô phỏng.

4. **Audit phù hợp để xem nhanh nhưng chưa đủ cho điều tra.** Không có route hoặc mục navigation Audit riêng (`router.tsx:40-50`, `app-shell.tsx:16-20`); ledger nằm trong Overview. Client chỉ yêu cầu 50 sự kiện (`overview-screen.tsx:297-301`), còn severity/search được lọc trên tập đã tải (`overview-screen.tsx:577-614`). Không có phân trang, bộ lọc thời gian/server-side hoặc trang chi tiết sự kiện. Vì vậy người hỗ trợ khó tra một thay đổi cũ hoặc lần theo actor/resource khi sự kiện nằm ngoài 50 bản ghi mới nhất.

5. **Bulk cancel có thể dừng giữa chừng nhưng xóa trạng thái chọn.** `operations-screen.tsx:141-161` dừng vòng lặp tại lỗi đầu tiên, rồi luôn gọi `setSelected(new Set())`. Những operation còn lại có thể chưa được gửi lệnh hủy, trong khi selection bị xóa; người trực phải tự tìm và chọn lại. Màn hình cũng chỉ tìm operation theo ID; correlation ID chỉ thấy sau khi mở detail (`operations-screen.tsx:238,493`). Bộ lọc ngày được ghi rõ là chỉ áp dụng cho trang đã tải (`:270`), nên không thể dùng để lọc toàn bộ lịch sử.

6. **Danh sách Businesses có thể bỏ sót registry và làm phẳng trạng thái version.** Màn hình chỉ gọi `listBusinesses({ limit: '50' })` (`businesses-screen.tsx:47`) và không có search/pagination. Bảng version nhận `row.status` nhưng hiển thị `row.isActive` thành Active/Inactive (`businesses-screen.tsx:245-256`, parser ở `businesses/state.ts:42-47`), nên các trạng thái như enabled/registered/disabled không được phân biệt trong bảng. Điều này làm khó xác định vì sao version chưa thể được kích hoạt.

7. **Liên kết API keys ở Overview không khớp router trong snapshot hiện tại.** `overview-screen.tsx:418` vẫn trỏ đến `/api-keys`, nhưng router không đăng ký route đó; app shell ghi API keys được quản lý trong Profiles (`app-shell.tsx:18-19`). Cùng lúc, working tree đánh dấu route/screen API keys đã bị xóa. Nếu đây là chủ đích chuyển màn, cần xóa hoặc thay liên kết Overview; nếu chưa phải, cần khôi phục route trước khi phát hành.

## Năm tính năng tôi muốn có để hỗ trợ vận hành

1. **Incident workspace cho Operations:** tìm theo operation ID, correlation ID, tenant, artifact/input và khoảng thời gian; mở thẳng từ Overview; kết hợp lifecycle, từng task/attempt, lỗi, artifact, worker/queue và sự kiện liên quan. Bulk action cần báo kết quả từng dòng, giữ lại các mục thất bại và cho phép retry phần còn lại.

2. **Audit console đầy đủ:** route riêng có phân trang cursor và lọc server-side theo thời gian, actor, severity, event kind, tenant, resource ID và correlation ID; trang chi tiết hiển thị trường liên quan/đã che dữ liệu nhạy cảm; hỗ trợ xuất kết quả theo quyền.

3. **Worker và queue health dựa trên heartbeat thật:** last-seen/heartbeat, worker instance và business/version, queue depth, stalled jobs, lease age, lỗi gần nhất và trạng thái consumer. Mỗi cảnh báo nên mở được queue/operation liên quan và có chỉ dẫn xử lý; không suy ra worker đang sống từ business registry.

4. **Telemetry có số liệu server-side và nguồn dữ liệu rõ ràng:** rollup theo tenant và thời gian được chọn, cùng tổng mẫu, success/failure, p50/p95 latency, thời điểm lấy mẫu và trạng thái stale. Từ biểu đồ có thể mở Operations với cùng time window/state để điều tra số liệu bất thường.

5. **Change review cho cấu hình và workflow:** so sánh hai revision Business/Profile/Workflow, xem validation và ảnh hưởng tới profile/API key/connector liên quan, chạy dry-run có kết quả trung thực, rồi publish/rollback có xác nhận và liên kết audit. Tách “kiểm tra cấu trúc” khỏi “thực thi workflow thật” để không tạo cảm giác một lần mô phỏng là pipeline đã chạy thành công.

Ưu tiên đầu tiên theo rủi ro hỗ trợ là sửa tính đúng đắn/trung thực của Overview và Workflow test, sau đó hoàn thiện tra cứu Audit và luồng xử lý operation thất bại. Đây là ý kiến sản phẩm từ review mã nguồn; các tính năng đề xuất có thể cần thêm API/BFF contract, không được giả định backend đã cung cấp dữ liệu cần thiết.
