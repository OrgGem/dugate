# Chức năng quản trị trên giao diện DUGate

Tài liệu này mô tả các thao tác quản trị có thể thực hiện trên **UI của ứng dụng tại thư mục gốc dự án** (`app/`, `components/`). Nội dung được đối chiếu với mã giao diện và các API mà giao diện gọi; không bao gồm ứng dụng riêng trong `du-rework/`.

## 1. Truy cập và phân quyền

Sau khi đăng nhập, thanh điều hướng dẫn tới **Tổng quan**, **Lịch sử Operations**, **Dashboard**, **Profiles**, **Connections**, **Workflows** và **API Docs**. Menu tài khoản ở góc phải có **Cài đặt hệ thống**, **Quản lý người dùng**, đổi giao diện sáng/tối và đăng xuất.

| Vai trò | Quyền trên UI quản trị |
| --- | --- |
| `ADMIN` | Xem dashboard và toàn bộ operations; quản lý người dùng, cấu hình hệ thống, profiles/API keys, connections và workflow schemas. |
| `USER` | Xem dashboard; xem profiles được phân công và cấu hình tham số/chuỗi xử lý của endpoint đang bật trong phạm vi đó; xem operations do mình tạo. Không có menu quản lý Connections, Workflows, người dùng hoặc cài đặt hệ thống. |
| `VIEWER` | Xem các trang chung như Tổng quan, API Docs và lịch sử operations của mình. Không có menu Dashboard và Profiles; không được xóa operations. |

Lưu ý: menu có thể ẩn một chức năng theo vai trò, nhưng quyền thực tế còn được kiểm tra ở API. Ví dụ `USER` không thể tạo/xoay API key hoặc thay đổi các thuộc tính lõi của endpoint; `VIEWER` không thể thực hiện thao tác ghi dù một số nút hành động còn hiện trên trang chi tiết operation.

## 2. Dashboard giám sát — `/dashboard`

**Đường vào:** thanh điều hướng → **Dashboard**. Dành cho `ADMIN` và `USER`.

- Chọn khoảng thời gian **24 giờ**, **7 ngày** hoặc **30 ngày**; bấm **Làm mới** để tải lại dữ liệu.
- Xem bốn chỉ số: **Tổng Requests**, **Tỷ lệ thành công**, **Tokens tiêu thụ** và **Chi phí ước tính**.
- Xem biểu đồ lưu lượng theo giờ/ngày, tách yêu cầu **thành công**, **thất bại**, **đang xử lý**; biểu đồ tỷ trọng theo pipeline.
- Xem bảng lưu lượng theo profile: tên profile, số operations, tỷ trọng. Có liên kết sang **Quản lý Profiles** và **Xem danh sách Operations**.

Số liệu lấy theo khoảng thời gian đang chọn. Chi phí trên màn hình là **ước tính** theo dữ liệu sử dụng/model pricing, không phải hóa đơn thanh toán.

## 3. Lịch sử và chi tiết Operations — `/history`, `/operations/{id}`

**Đường vào:** thanh điều hướng → **Lịch sử Operations**. `ADMIN` thấy toàn bộ operations; tài khoản khác chỉ thấy operations do mình tạo. Danh sách UI tải tối đa **100 bản ghi mới nhất**; ô tìm kiếm và các tab trạng thái lọc trên tập bản ghi đã tải.

### Danh sách operations

- Tìm theo **Operation ID** hoặc tên bước **Pipeline**.
- Lọc theo **Tất cả**, **Đang chạy**, **Chờ duyệt**, **Hoàn tất**, **Thất bại**, **Đã hủy**. Mỗi tab hiển thị số lượng tương ứng trong danh sách hiện có.
- Xem ID, trạng thái, các bước pipeline, phần trăm tiến độ và thời điểm tạo; bấm **Làm mới** để cập nhật.
- Sao chép Operation ID, mở trang chi tiết; với tác vụ chờ duyệt có lối tắt tới màn hình tiếp tục.
- Với tác vụ đang chạy hoặc chờ nhập liệu, bấm **Hủy tác vụ** và xác nhận. `ADMIN`/`USER` có thể xóa bản ghi bằng nút **Xóa** sau hộp thoại xác nhận; `USER` chỉ thao tác trên bản ghi của mình.

### Trang chi tiết operation

- Xem trạng thái/tiến độ, thời gian tạo và cập nhật, số bước, mô hình AI, token, số trang và chi phí ước tính khi có dữ liệu.
- Theo dõi tiến trình pipeline; xem nội dung đầu ra ở các tab **Văn bản hoàn chỉnh**, **Dữ liệu trích xuất (JSON)** và **Chi tiết từng bước** khi loại dữ liệu đó tồn tại. Xem bảng token/chi phí theo processor nếu operation trả về usage chi tiết.
- **Làm mới**, sao chép ID hoặc nội dung tab hiện tại, **Tải kết quả** khi có file/nội dung đầu ra.
- Khi trạng thái là `WAITING_USER_INPUT`, mở **Tiếp tục / Nhập liệu**, kiểm tra hoặc sửa JSON dữ liệu rồi **Gửi và Resume Pipeline**.
- Khi tác vụ đang chạy hoặc chờ nhập liệu, có thể **Hủy tác vụ**.

## 4. Profiles và API keys — `/profiles`

**Đường vào:** thanh điều hướng → **Profiles**. `ADMIN` quản lý mọi profile; `USER` chỉ thấy các profile được phân công. Profile gắn với client/API key và tập cấu hình endpoint riêng.

### Quản lý profile (`ADMIN`)

1. Bấm dấu **+** trong danh sách Profiles, nhập **Tên ứng dụng / Client**, chọn **Tạo Access Key**. UI hiển thị key thô và nút sao chép **một lần sau khi tạo**; hãy lưu lại trước khi rời thông báo.
2. Chọn profile để xem tên, vùng **Static API Key** (không hiển thị lại key thô) và **Ghi chú (Admin Note)**; sửa ghi chú rồi bấm **Lưu Ghi Chú**.
3. Bấm **Rotate Key** để cấp key mới, xác nhận hộp thoại; key cũ có thể ngừng dùng ngay. Key mới cũng chỉ được hiển thị để sao chép tại thời điểm cấp.
4. Bấm **Xóa Profile** rồi xác nhận để xóa profile; UI không hiện nút xóa cho **Global Profile**.

### Cấu hình endpoint theo profile

- Xem danh sách endpoint theo nhóm dịch vụ, tên hiển thị, route, mô tả và subcase. Bộ lọc **Tất cả / Enabled only** giúp thu hẹp danh sách.
- `ADMIN` bật/tắt từng endpoint bằng công tắc, hoặc dùng **Bật tất cả / Tắt tất cả** cho profile sau khi xác nhận.
- Mở thẻ endpoint để chỉnh **Job Priority** (`LOW`, `MEDIUM`, `HIGH`), **Allowed File Extensions**, và xác thực khi tải file từ URL (`none`, Bearer token, header hoặc query parameter).
- Mục **Parameters Configuration** cho phép thêm/sửa/xóa tham số, chọn giá trị theo schema, khóa tham số để client không ghi đè, hoặc chuyển sang **Raw JSON**. `USER` được chỉnh tham số của endpoint đã bật trong profile được phân công.
- Mục **API Integration (cURL)** tạo ví dụ gọi endpoint; có nút sao chép lệnh.
- Với endpoint thông thường, mục **Pipeline Processors** cho phép nối thêm connector, đổi thứ tự, xóa bước, quay về chuỗi mặc định; cấu hình lấy session ID từ response và đưa vào request bước tiếp theo. Có thể ghi đè prompt theo từng bước, xem prompt mặc định và dùng **AI Wizard** để đề xuất prompt mới từ vấn đề nhập vào. AI Wizard cần một connection đang bật với slug `ext-prompt-wizard`. Sau khi áp dụng đề xuất vẫn phải bấm **Lưu Toàn bộ Thiết lập**.
- Với endpoint workflow dùng mã xử lý sẵn, UI thay phần chuỗi connector bằng **Workflow Prompt Management**: xem prompt gốc/biến đầu vào, bật hoặc tắt override và sửa prompt theo bước. Bấm **Lưu Toàn bộ Thiết lập** để áp dụng.
- Nút **Test** của endpoint đang bật mở biểu mẫu nhập tham số, tải file hoặc nhập remote URLs; có thể chạy thử, xem kết quả/nội dung/JSON lỗi, usage và sao chép dữ liệu hoặc cURL thử nghiệm.

Các cấu hình bật/tắt, độ ưu tiên, xác thực URL và giới hạn đuôi file là quyền `ADMIN`. Khi `USER` lưu cấu hình, API chỉ nhận **parameters** và **connections override** cho endpoint đã bật và đã tồn tại trong profile được phân công.

## 5. External API Connections — `/api-connections`

**Đường vào:** thanh điều hướng → **Connections**. Chỉ `ADMIN` truy cập trang quản lý và ghi thay đổi.

- Xem danh sách connection, chọn một connection để sửa hoặc tạo connection mới. Có thể **Import cURL**: dán lệnh cURL để tự điền URL, headers, authentication và dữ liệu form trước khi rà soát/lưu.
- Nhóm **Identity**: tên, slug tự sinh, mô tả, trạng thái `ENABLED`/`DISABLED`.
- Nhóm **Endpoint**: URL và HTTP method (`POST` hoặc `PUT`).
- Nhóm **Authentication**: `API Key Header`, `Bearer Token` hoặc `None`; nhập tên header và secret/token khi cần. Secret đã lưu được che trên giao diện.
- Nhóm **Request Format**: tên field prompt/file trong multipart form, default prompt, các static form fields.
- Nhóm **Response Mapping & Limits**: đường dẫn dot-path tới nội dung trả về, extra headers và timeout tính bằng giây.
- Nhóm **Session ID Chaining**: đường dẫn lấy session ID từ response và tên field để gửi session ID ở request kế tiếp.
- Bấm **Tạo Connection** hoặc **Lưu thay đổi**. Connection đã lưu có thể **Test Connection** bằng prompt và nhiều file; UI hiển thị HTTP status, độ trễ, nội dung đã map, preview response và lỗi nếu có.
- Bấm **Xóa** rồi xác nhận. Theo hộp thoại UI, thao tác này cũng xóa processor liên kết và các override của client liên quan.

## 6. Workflow Builder — `/workflow-builder`

**Đường vào:** thanh điều hướng → **Workflows**. Chỉ `ADMIN`.

- Tìm schema theo tên/slug; chuyển giữa dạng **danh sách** và **lưới**. Mỗi mục cho biết slug, tên, mô tả, phiên bản.
- **Import Schema** từ file `.json` hoặc `.xml`; có thể xóa schema sau khi xác nhận. UI hiện tại là giao diện **import, xem, cấu hình override và chạy**; không có trình kéo thả để tự tạo sơ đồ workflow.
- Mở **Xem chi tiết** để xem input variables, nodes, thứ tự flow, nguồn output và pipeline mappings của các connector node.
- Tại từng pipeline mapping, có thể lưu override riêng cho **prompt**, **static form fields (JSON)**, **extra headers (JSON)**, **response content path** và **timeout**.
- Bấm **Chạy thử**, nhập các trường được sinh từ input schema và đính kèm nhiều file nếu cần. Chọn **DU Gateway Operations** hoặc **Legacy Runner** trước khi gửi. Với đường chạy Operations, UI theo dõi operation và điều hướng tới trang chi tiết; nếu workflow dừng chờ duyệt, biểu mẫu HITL cho phép sửa JSON và tiếp tục.

## 7. Cài đặt hệ thống — `/settings`

**Đường vào:** menu tài khoản → **Cài đặt hệ thống**. Chỉ `ADMIN`.

### Giao diện

Chọn **Sáng**, **Tối**, **Hệ thống**, **VPB Sáng** hoặc **VPB Tối**. Menu tài khoản cũng có nút đổi theme nhanh.

### Lưu trữ file và dọn dữ liệu

- Cấu hình S3 compatible: endpoint URL, bucket, access key, secret key, region và **Cache TTL (hours)**; bấm **Lưu & Test Connection**.
- Xem backend hiện tại (**S3 Active** hoặc **Local Disk**), số file cache, dung lượng cache, số operation có output file và số output hết hạn có thể dọn.
- **Clear Expired** dọn file cache hết hạn; **Clear All** dọn file cache không còn được tham chiếu (có hộp thoại xác nhận); **Clean Expired Outputs** dọn output của operation hết hạn khi nút này xuất hiện.

### AI provider và prompts mặc định

- Chọn **Google Gemini** hoặc **OpenAI Compatible**, nhập API key tương ứng; với OpenAI compatible có thể đổi **Base URL** cho dịch vụ tương thích hoặc host nội bộ. Tùy chọn **Anthropic Claude** hiện mang nhãn *sắp hỗ trợ* trên UI.
- Nhập model hoặc chọn gợi ý, rồi bấm **Lưu Cấu hình Nền tảng AI**. Nút **Kiểm tra kết nối AI** cho biết cấu hình hiện tại gọi được provider hay không.
- Sửa prompt mặc định cho **mô tả ảnh DOCX**, **chuyển đổi PDF**, **chuyển đổi DOCX**, **so sánh tài liệu** và **tạo tài liệu**. Có mẫu prompt tiếng Anh/tiếng Việt để điền nhanh; bấm **Lưu Prompts Hướng dẫn** để lưu.

## 8. Quản lý người dùng — `/settings/users`

**Đường vào:** menu tài khoản → **Quản lý người dùng**. Chỉ `ADMIN`.

- Xem bảng username, vai trò, ngày tạo; tìm theo username. Tài khoản đăng nhập qua OIDC có nhãn **SSO**.
- **Tạo người dùng**: nhập username, mật khẩu, chọn vai trò `VIEWER`, `USER` hoặc `ADMIN`, chọn các profiles được phân công và bấm **Tạo**.
- **Chỉnh sửa**: đổi username/vai trò, thay mật khẩu (để trống thì giữ nguyên), cập nhật profile được phân công rồi bấm **Cập nhật**. Với tài khoản SSO, UI không cho đặt mật khẩu vì xác thực do nhà cung cấp bên ngoài quản lý.
- **Xóa** tài khoản qua bước **Xác nhận**; UI không hiện nút xóa cho chính tài khoản đang đăng nhập.

Profile assignment giới hạn những profile `USER` được thấy/quản lý; nếu không chọn profile thì `USER` không có profile để quản lý. `ADMIN` mặc định có quyền với toàn bộ profiles.

## 9. Tài liệu API trên UI — `/api-docs`

Thanh điều hướng → **API Docs** mở Swagger UI từ `/api/swagger` để tra cứu endpoint, tham số và schema. Đây là màn hình tham khảo/tương tác API, không phải nơi lưu cấu hình quản trị.

## Ghi chú phạm vi

Trang **Tổng quan** (`/`) và các trang `/docs/ingest`, `/docs/extract`, `/docs/analyze`, `/docs/transform`, `/docs/generate`, `/docs/compare` giới thiệu hoặc sử dụng nghiệp vụ xử lý tài liệu. Các màn hình thử nghiệm nghiệp vụ khác như `/doc-pipeline`, `/doc-compare`, `/lc-checker` cũng nằm ngoài nhóm cấu hình quản trị được mô tả ở đây.

**Nguồn đối chiếu chính:** `components/HeaderNav.tsx`, `components/DashboardView.tsx`, `components/ConversionHistory.tsx`, `components/SettingsForm.tsx`, các trang tương ứng trong `app/` và API quản trị trong `app/api/internal/`, `app/api/settings/`, `app/api/users/`, `app/api/operations/`.
