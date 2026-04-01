# 📚 Document Understanding (DU) API — Tài Liệu Tích Hợp & Vận Hành

Tài liệu này cung cấp hướng dẫn toàn diện về hệ thống API Document Understanding (DU), bao gồm cách tích hợp dành cho nhà phát triển (Client/Developer) và hướng dẫn cấu hình dành cho quản trị viên (Admin).

---

## Phần 1: Hướng Dẫn Tích Hợp Cho Client (Developer Guide)

Hệ thống DU API được thiết kế theo kiến trúc tối giản số lượng endpoint nhưng bao trùm tối đa các nghiệp vụ thông qua việc thay đổi **tham số hành động**.

### 1. Thông Tin Chung

- **Base URL:** `https://api.dugate.vn/api/v1`
- **Xác thực:** Sử dụng API Key truyền qua Header `x-api-key: dg_xxxxxxxxxxxx`.
- **Định dạng Request:** `multipart/form-data` (hỗ trợ upload file).

> [!TIP]
> Việc giảm thiểu số lượng Endpoint giúp đơn giản hoá Logic gọi API từ phía Client SDK, bằng cách thay đổi giá trị của một biến (VD: `type`, `task`, `action`) ứng với một Document Service.

### 2. Luồng Xử Lý Bất Đồng Bộ (Async Pattern)
Các tác vụ xử lý tài liệu thường mất nhiều thời gian. Do đó, DU API sử dụng pattern bất đồng bộ (Polling hoặc Webhook).

**Bước 1: Gửi yêu cầu bài toán**
```bash
curl -X POST https://api.dugate.vn/api/v1/extract \
  -H "x-api-key: dg_xxx" \
  -F "file=@invoice.pdf" \
  -F "type=invoice"
```
**Phản hồi (202 Accepted):**
```json
{
  "name": "operations/op-abc123",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "created_at": "2026-03-31T14:00:00Z"
  }
}
```

**Bước 2: Kiểm tra trạng thái (Polling)**
```bash
curl -X GET https://api.dugate.vn/api/v1/operations/op-abc123 \
  -H "x-api-key: dg_xxx"
```
**Phản hồi (Khi hoàn thành):**
```json
{
  "name": "operations/op-abc123",
  "done": true,
  "result": { ... kết quả xử lý ... }
}
```

### 3. Danh Sách Các Chức Năng (Use Cases)

Dưới đây là 6 tính năng cốt lõi của hệ thống:

#### 3.1. Nhập & Tiền Xử Lý Tài Liệu (`POST /ingest`)
Tiền xử lý tài liệu thô trước khi đưa vào các bước chuyên sâu.
- **`mode=parse`**: Đọc cấu trúc PDF/DOCX (giữ nguyên bảng biểu, list).
- **`mode=ocr`**: Nhận diện ký tự từ ảnh chụp/scan (hỗ trợ nhiều ngôn ngữ qua `language`).
- **`mode=digitize`**: Số hóa tài liệu viết tay (áp dụng cho các form điền tay).
- **`mode=split`**: Tách trang tài liệu gốc (VD: `pages=1-5`).

#### 3.2. Trích Xuất Dữ Liệu (`POST /extract`)
Lấy thông tin có cấu trúc (JSON) từ các loại giấy tờ.
- **`type=invoice`**: Trích xuất hóa đơn (nhà cung cấp, mã HĐ, tổng tiền, thuế, line items).
- **`type=contract`**: Trích xuất hợp đồng (bên A/B, điều khoản, giá trị).
- **`type=id-card`**: Trích xuất CCCD/Passport.
- **`type=receipt`**: Trích xuất biên lai/phiếu thu.
- **`type=table`**: Bóc tách tất cả bảng biểu trong file thành mảng JSON/CSV.
- **`type=custom`**: Trích xuất theo cấu trúc động bằng cách truyền JSON schema thông qua tham biến `schema` hoặc chuỗi `fields`.

#### 3.3. Phân Tích & Đánh Giá (`POST /analyze`)
Hiểu sâu văn bản và đối chiếu với các quy định/tiêu chí kinh doanh tĩnh hoặc động định.
- **`task=classify`**: Phân loại tài liệu (VD: hợp đồng, hóa đơn, báo cáo).
- **`task=sentiment`**: Phân tích thái độ/cảm xúc (Dành cho review của khách hàng).
- **`task=compliance`**: Kiểm tra tính tuân thủ pháp lý/nội quy dựa trên tham số `criteria`.
- **`task=fact-check`**: Kiểm chứng chéo thông tin. *(Cần truyền JSON dữ liệu mẫu làm mốc đối soát vào `reference_data`)*.
- **`task=quality`**: Chấm điểm chất lượng văn phong (đúng ngữ pháp, logic).
- **`task=risk`**: Phát hiện rủi ro (VD: điều khoản bất hợp lý/thiệt hại trong hợp đồng).
- **`task=summarize-eval`**: Đánh giá kết hợp tóm lược.

#### 3.4. Chuyển Đổi Nội Dung (`POST /transform`)
Biến đổi định dạng hoặc nội hàm content của file.
- **`action=convert`**: Đổi định dạng (VD: DOCX -> Markdown/HTML).
- **`action=translate`**: Dịch thuật tài liệu (`target_language=vi`, hỗ trợ các `tone` khác nhau).
- **`action=rewrite`**: Viết lại nội dung theo phong cách khác (`style=academic, formal, casual`).
- **`action=redact`**: Tự động bôi đen/che thông tin nhạy cảm (PII: số thẻ, CCCD, địa chỉ, số ĐT).
- **`action=template`**: Điền JSON data vào một form mẫu chỉ định.

#### 3.5. Tạo Nội Dung Phái Sinh (`POST /generate`)
Sinh văn bản phái sinh từ tài liệu gốc.
- **`task=summary`**: Tóm tắt nội dung (format: paragraph, bullets, numbered, table, mind_map).
- **`task=qa`**: Hỏi đáp/Truy vấn tùy ý ngay trên tài liệu (`questions="..."`).
- **`task=outline`**: Trích xuất tự động dàn ý/danh mục đầu mục.
- **`task=report`**: Tạo báo cáo chuyên sâu dựa trên data bảng biểu thô.
- **`task=email`**: Tự động nháp email phản hồi hoặc follow-up action.
- **`task=minutes`**: Xuất biên bản cuộc thảo luận từ Transcript Audio.

#### 3.6. So Sánh Tài Liệu (`POST /compare`)
So sánh sự khác biệt giữa `source_file` và `target_file`.
- **`mode=diff`**: So sánh text từng dòng mức ký tự (syntax tương tự git diff).
- **`mode=semantic`**: So sánh ngữ nghĩa (Tập trung vào nội dung thay đổi thay vì câu chữ). Có thể chỉ định vùng chú ý với tham số `focus`.
- **`mode=version`**: Chuyên trị việc tạo changelog giữa 2 phiên bản hợp đồng hay policy.

---

## Phần 2: Hướng Dẫn Thiết Lập Cho Admin (Quản Trị Viên)

Hệ thống DU được thiết kế theo cơ chế **Profile-Endpoint Configuration**, cho phép Admin kiểm soát mạnh mẽ hành vi của API đối với từng Client (Khách hàng/Đối tác) mà không cần can thiệp mã nguồn.

### 1. Quản Lý Client Profile
Mỗi client khi đăng ký sử dụng hệ thống sẽ được cấp một **Profile**. Profile gắn với 1 hoặc nhiều API Key và lưu trữ cấu hình mặc định.

**Quy trình Onboarding 1 Client mới:**
1. Đăng nhập vào Admin Dashboard.
2. Tại mục **Clients/Profiles**, chọn "Tạo Profile Mới".
3. Nhập tên Client và cấp phát API Key tương ứng.
4. Điều hướng tới trang **Overrides** để tùy chỉnh từng Module dịch vụ nhỏ riêng biệt cho Client đó.

### 2. Thiết Lập Custom Rules & Overrides (ProfileEndpoint)
Các thiết lập phân quyền và thay đổi Prompt (Override) được setup theo từng Endpoint. Những tham số định dạng từ Admin **hoàn toàn ẩn đối với Client**, đảm bảo an toàn nghiệp vụ và tránh lộ Business Logic ra bên ngoài.

Khi Client gửi Request, hệ thống (`Parameter Merger`) sẽ gộp tham số request với tham số Override từ Admin. Admin được quyền thiết lập các Parameters độc quyền sau:
- **`business_rules`**: (*Dùng cho /analyze, /extract*) - Quy tắc nghiệp vụ bắt buộc.
  > Ví dụ trong `/analyze?task=compliance`: *"Phải kiểm tra theo đúng Luật Doanh Nghiệp 2020. Tự động trả về ERROR nếu không có con dấu hợp lệ."*
- **`glossary`**: (*Dùng cho /transform*) - Bộ từ điển dịch thuật thuật ngữ chuyên ngành công ty (Glossary).
- **`redact_patterns`**: (*Dùng cho /transform*) - Mã Regex dùng cho việc bôi đen tự động các dữ liệu mật.
- **`focus_areas`**: (*Dùng cho /generate*) - Định hướng Agent khi tạo văn bản theo ý tổ chức.
- **`model_override`**: Ép buộc dùng LLM cụ thể (VD: đổi `gpt-4o` bản cao cấp sang `claude-3-haiku` cho các client đăng ký gói rẻ).
- **`max_tokens`**: Giới hạn độ dài văn bản đầu ra nhằm tránh tốn kém chi phí thừa.

### 3. Tích Hợp Kết Nối Ngoại Bộ (External API Connectors)
Khi các AI Backend mặc định của hệ thống không đủ so với yêu cầu Custom siêu sâu của Client, Admin có thể định nghĩa **Kết Nối Ngoại (External Connection)**.
1. Vào mục tab **External API Connections**.
2. Thêm mới cấu hình, dán cURL của hệ thống đích (VD: API OCR nội hạt hay Local LLM riêng của đối tác).
3. Đặt Prompt hướng dẫn cụ thể (`system_prompt` & `user_prompt`) vào Payload Request Body.
4. Gán Connector này làm Backend cho Endpoint của Profile Client. Kể từ lúc này, mọi Request của Client thay vì gọi nội bộ, sẽ đi qua API tuỳ biến này với các Rule & System Prompt ngầm.

---

### 🌟 4. Các Kịch Bản Sử Dụng Điển Hình (Real-World Use Cases)

Dưới đây là các ví dụ thực tế cho thấy sức mạnh của việc kết hợp tham số giữa Client và thiết lập ngầm từ Admin.

#### Use Case 1: Trích Xuất & Kiểm Tra Rủi Ro Tín Dụng

**Bài toán:** Client "Ngân Hàng V" muốn dùng API `/extract?type=contract` nhưng... chỉ muốn trích xuất  *thời hạn* và *lãi suất*, format JSON trả về phải là một cấu trúc nội bộ, đồng thời tự động kiểm tra *rủi ro lãi trần* cùng lúc xử lý.

**Hành động của Admin (Tại Overrides Dashboard):**
1. Mở Profile "Ngân Hàng V".
2. Vào Endpoint `/extract`, chuyển Trạng thái thành **Enabled**.
3. Điền vào **System Prompt / Business Rules Override**:
   > *"Bạn là chuyên viên tài chính. Chỉ bóc tách thời hạn vay và phần trăm lãi suất. Phải kiểm tra nếu rủi ro lãi suất cao hơn 20% / năm, thì thêm cờ 'WARNING' vào 'is_risky'. Chuẩn JSON format bắt buộc: { duration_months: number, interest_rate: number, is_risky: boolean }."*
4. Bấm Lưu.

**Hành động của Client Bank V:** 
```bash
curl -X POST https://api.dugate.vn/api/v1/extract \
  -H "x-api-key: dg_bank_v_xxx" \
  -F "file=@hop_dong_tin_dung.pdf" \
  -F "type=contract"
```
*Kết quả:* Client sẽ nhận được chính xác cấu trúc JSON và hệ thống tự động kiểm tra rủi ro như Admin đã gài cắm, không cần vất vả lập trình lại bất kỳ luồng Logic LLM nào.

---

#### Use Case 2: So Sánh 2 Phiên Bản Tài Liệu Ngữ Nghĩa

**Bài toán:** Phòng Pháp chế muốn tìm ra sửa đổi thực sự của đối tác trên bản Hợp đồng (Bản v2) so với bản gốc của công ty (Bản v1). Họ không muốn nhận về lỗi "thừa khoảng trắng" hay "xuống dòng" vô nghĩa, mà cần tìm những câu từ bị thay đổi **ý nghĩa pháp lý**.

**Hành động của Admin (Không Bắt Buộc):**
Có thể gài cắm vào **Business Rules** cho `/compare`:
> *"Chỉ tập trung vào các điều khoản thanh toán, trách nhiệm bồi thường và chấm dứt hợp đồng. Bỏ qua các sai sót chính tả nhỏ."*

**Hành động của Client Pháp Chế:**
```bash
curl -X POST https://api.dugate.vn/api/v1/compare \
  -H "x-api-key: dg_legal_xxx" \
  -F "source_file=@contract_v1.pdf" \
  -F "target_file=@contract_v2.docx" \
  -F "mode=semantic" \
  -F "focus=Trách nhiệm bồi thường"
```
*Kết quả:* Hệ thống sẽ trả về một JSON Diff trong đó chỉ ra đoạn văn bị sửa nghĩa. *(Ví dụ: "Bản V2 đã sửa mức đền bù từ 100% xuống còn 50% trong trường hợp đơn phương hủy hợp đồng.")*

---

#### Use Case 3: Đối Chiếu Nội Dung File Với Quy Định (Compliance)

**Bài toán:** Phòng Nhân sự nhận hàng ngàn Hồ sơ ứng tuyển và muốn tự động loại những CV/Bằng cấp không đáp ứng tiêu chuẩn.

**Hành động của Admin (Tại Overrides Dashboard):**
1. Mở Profile "HR Department".
2. Vào Endpoint `/analyze`, cấu hình **Business Rules**:
   > *"Kiểm tra CV và Bằng cấp. Ứng viên bắt buộc phải có chứng chỉ IELTS từ 6.5 trở lên, hoặc TOEIC trên 700, tốt nghiệp bằng Khá trở lên từ các trường Đại học công lập. Trả về WARNING nếu có khoảng thời gian trống (Gap year) dài hơn 6 tháng."*

**Hành động của Client HR:**
```bash
curl -X POST https://api.dugate.vn/api/v1/analyze \
  -H "x-api-key: dg_hr_xxx" \
  -F "file=@cv_nguyen_van_a.pdf" \
  -F "task=compliance"
```
*Kết quả:* JSON trả về sẽ có thuộc tính `"verdict": "FAIL"`, cùng mảng `"issues"` liệt kê rõ lý do rớt *(Ví dụ: "Chứng chỉ TOEIC 600 không đạt mốc 700 yêu cầu")*.
