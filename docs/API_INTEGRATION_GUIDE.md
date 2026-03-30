# Hướng dẫn Tích hợp Dugate API (API Integration Guide)

Tài liệu này cung cấp đặc tả kỹ thuật toàn diện dành cho lập trình viên để tích hợp Hệ thống phân giải AI cốt lõi của **Dugate Document AI Suite** vào các sản phẩm phần mềm (CRM, ERP, HRM, v.v.).

---

## 1. Tổng quan & Xác thực (Authentication)

- **Base URL**: `https://api.dugate.vn/api/v1` (Hoàng hoặc cấu hình riêng theo server của doanh nghiệp).
- **Authentication**: Xác thực qua Header bắt buộc: `x-api-key: <YOUR_API_KEY>`.
- **Giao thức tiến trình**: Đặc thù của các mô hình Generative AI (LLMs) đòi hỏi thời gian xử lý lâu (10s - 60s). Dugate API thiết kế theo chuẩn **AIP-151 (Long Running Operations)**. Mọi luồng xử lý đều diễn ra bất đồng bộ (Asynchronous): Giao task ➔ Nhận ID ➔ Polling theo dõi trạng thái ➔ Tải kết quả.
- **Header Chống lặp (Idempotency)**: Gửi kèm Header `Idempotency-Key: <UUID>` để hệ thống không trừ tiền và tái thực thi nếu bạn lỡ cấu hình phần mềm gửi lại (retry) cùng một request khi rớt mạng.

---

## 2. Chi tiết Đặc tả API (API Reference)

### 2.1. Liệt kê danh mục Processor
Hệ thống API Dugate vận hành thông qua một đường ống xử lý (Pipeline) linh hoạt. Các tác vụ AI cốt lõi trong đường ống này được gọi là các **Processor**.

**Endpoint**: `GET /api/v1/processors`

**Mô tả**: Lấy danh sách toàn bộ các Processor (công cụ AI) khả dụng trên hệ thống mà API Key của bạn được phép truy cập.

**Response (200 OK):**
```json
{
  "processors": [
    {
      "slug": "prebuilt-layout",
      "displayName": "Chuyển đổi văn bản (PDF/DOCX → Markdown)",
      "category": "extract",
      "description": "Chuyển đổi tài liệu PDF hoặc DOCX sang Markdown giữ nguyên cấu trúc bảng biểu, heading...",
      "acceptedMimes": "application/pdf,application/vnd.openxml...",
      "outputFormats": "md,html",
      "variablesSchema": null,
      "canBeFirstStep": true,
      "canBeChainStep": false
    }
    // ... các processor khác
  ]
}
```

---

### 2.2. Giao việc cho Pipeline (Submit Document)
**Endpoint**: `POST /api/v1/documents/process`

**Mô tả**: Endpoint chính định nghĩa đầu vào của tài liệu và cấu trúc tuần tự các bước AI sẽ xử lý nó.

> [!TIP]
> **Recipe Endpoints (Shortcut):** Thay vì tự định nghĩa cấu trúc JSON `pipeline` phức tạp qua endpoint này, Dugate cung cấp sẵn các API rút gọn theo từng nhóm nghiệp vụ. Các API này nhận dữ liệu Form-Data truyền thống và tự động liên kết thành pipeline ở background:
> - `POST /api/v1/transform` (Chuyển đổi PDF/DOCX sang Markdown/HTML/JSON)
> - `POST /api/v1/extract` (Bóc tách dữ liệu JSON theo cấu trúc/mẫu chỉ định)
> - `POST /api/v1/compare` (So sánh 2 tài liệu tìm điểm khác biệt)
> - `POST /api/v1/generate` (Khởi tạo tài liệu mới từ một bộ dữ liệu JSON đầu vào/Template)
> - `POST /api/v1/fact-check` (Kiểm tra chéo và đối soát tuân thủ chứng từ)

**Content-Type**: `multipart/form-data`

**Body Payload**:
- `file` (File, tuỳ chọn): Tệp cần xử lý (PDF, JPG, DOCX).
- `sourceFile` (File, tuỳ chọn): Tệp gốc (Dành cho việc so sánh 2 văn bản).
- `targetFile` (File, tuỳ chọn): Tệp mục tiêu (Trích xuất các khác biệt).
- `pipeline` (Stringified JSON, bắt buộc): Mảng biểu thị các khối Processor sẽ chạy.

**Cấu trúc Array của trường `pipeline`:**
```json
[
  {
    "processor": "slug-cua-processor",
    "variables": {
      "key": "value"
    }
  }
]
```
*(Chi tiết các variables, xem phần Use Cases phía dưới).*

**Response (202 Accepted):**
```json
{
  "id": "op_123456789abc",
  "state": "RUNNING",
  "message": "Operation started successfully. Call GET /api/v1/operations/{id} to poll progress."
}
```

---

### 2.3. Theo dõi cấu trúc luồng (Polling Operation)
**Endpoint**: `GET /api/v1/operations/{id}`

**Mô tả**: Sử dụng `id` trả về từ việc Submit để kiểm tra tiến trình hiện tại. Nên thực hiện gọi polling với tần suất 2-5 giây/lần cho đến khi `done: true`.

**Response khi đang chạy (200 OK):**
```json
{
  "id": "op_123456789abc",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "pipeline": ["prebuilt-layout", "prebuilt-summarize"],
    "current_step": 0,
    "progress_percent": 35,
    "progress_message": "Đang chạy prebuilt-layout: Bóc tách bố cục (1/2)",
    "create_time": "2023-11-20T10:00:00Z",
    "update_time": "2023-11-20T10:00:15Z"
  }
}
```

**Response khi hoàn tất (200 OK):**
```json
{
  "id": "op_123456789abc",
  "done": true,
  "metadata": {
    "state": "SUCCEEDED",
    "pipeline": ["prebuilt-layout", "prebuilt-summarize"],
    "current_step": 2,
    "progress_percent": 100,
    "progress_message": "Hoàn tất luồng xử lý",
    "create_time": "2023-11-20T10:00:00Z",
    "update_time": "2023-11-20T10:00:30Z"
  },
  "result": {
    "output_format": "md",
    "content": "# Bản tóm tắt \n Hệ thống này vận hành rất...",
    "extracted_data": null,
    "pipeline_steps": [
       // Chứa mảng các kết quả của riêng từng bước trung gian (nếu cần thiết debug)
    ],
    "usage": {
      "input_tokens": 15400,
      "output_tokens": 850,
      "pages_processed": 5,
      "model_used": "gemini-1.5-pro",
      "cost_usd": 0.05,
      "breakdown": [
        { "processor": "prebuilt-layout", "input_tokens": 5000, "output_tokens": 4000, "cost_usd": 0.015 },
        { "processor": "prebuilt-summarize", "input_tokens": 10400, "output_tokens": 850, "cost_usd": 0.035 }
      ]
    },
    "download_url": "/api/v1/operations/op_123456789abc/download"
  }
}
```

---

### 2.4. Tải file kết quả thô
**Endpoint**: `GET /api/v1/operations/{id}/download`

**Mô tả**: Streaming cấu trúc text kết quả thay vì render vào JSON (phù hợp tải Markdown hoặc HTML về máy). Sẽ trả về tệp nhị phân stream gốc.

---

### 2.5. Hủy tiến trình
**Endpoint**: `POST /api/v1/operations/{id}/cancel`

**Mô tả**: Hủy ngang quá trình nếu trạng thái đang là `RUNNING`. Sẽ cập nhật bảng ghi sang `CANCELLED`. Lưu ý vẫn bị tính phí đối với các tokens đã thực hiện xong trước khi Server nhận lệnh Cancel.

---
---

## 3. Các Use-case Tích hợp Cụ thể (Hướng dẫn lập trình JSON Payload)

Trong mọi lệnh gọi POST tới `/documents/process`, cốt lõi nằm ở việc bạn truyền file nhị phân kèm với cấu trúc `pipeline` JSON payload. Dưới đây là các cấu trúc cho từng nghiệp vụ.

### Use case 1: Chỉ số hóa File Vật lý (OCR PDF → Markdown)
Trích xuất bố cục nguyên bản (Headings, Tables, Lists) thành Markdown để đưa vào hệ thống Search hoặc RAG nội bộ. Bỏ qua các header footer dư thừa.

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-layout"
  }
]
```
Kết quả nhận lại trong field `result.content` là chuỗi Markdown chuẩn hóa.

---

### Use case 2: Bóc dữ liệu Hóa đơn (Data Extraction sang JSON)
Đẩy file Hóa đơn điện tử hoặc File Scan Hóa đơn đỏ. API sẽ trả về dữ liệu có cấu trúc.

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-invoice"
  }
]
```
Cấu trúc output trong vòng Polling tại field `result.extracted_data`:
```json
{
  "invoice_no": "HD-12345",
  "date": "2023-10-15",
  "seller_name": "Công ty ABC",
  "seller_tax_code": "01010101",
  "buyer_name": "Công ty XYZ",
  "subtotal": 1000000,
  "vat_amount": 100000,
  "total_amount": 1100000,
  "currency": "VND",
  "items": [
    { "description": "Laptop", "quantity": 1, "unit_price": 1000000, "amount": 1000000 }
  ]
}
```

---

### Use case 3: Bóc tách CCCD/ID Card (Image → JSON)
Lấy thông tin căn cước để eKYC người dùng. Hỗ trợ JPG/PNG.

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-id-card"
  }
]
```

---

### Use case 4: Dịch file PDF ngoại ngữ (Giữ đúng cấu trúc dàn trang)
Dịch Hợp đồng tiếng Nhật sang tiếng Việt thể thức trịnh trọng, giữ nguyên các bảng biểu và hình ảnh.

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-layout" 
  },
  { 
    "processor": "prebuilt-translate",
    "variables": {
      "target_language": "Tiếng Việt",
      "tone": "formal"
    }
  }
]
```

---

### Use case 5: Tóm tắt Văn kiện/Báo cáo dài (Chaining Steps)
Một biên bản tóm tắt 50 trang được giới hạn lại 300 từ ngữ để hiển thị trên thông báo điện thoại.
*Lưu ý luồng đi: PDF ➔ OCR ra Markdown ➔ Gửi Markdown cho LLM tóm tắt.*

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-layout" 
  },
  { 
    "processor": "prebuilt-summarize",
    "variables": {
      "max_words": 300
    }
  }
]
```
Kết quả văn bản tóm tắt nằm trong `result.content`.

---

### Use case 6: Che phủ thông tin cá nhân (PII Redaction)
Đẩy file CV xin việc, tự động làm mờ Tên, Email, SĐT của ứng viên gửi cho nội bộ chống chèo kéo ứng viên.

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-layout"
  },
  { 
    "processor": "prebuilt-redact",
    "variables": {
      "pii_types": ["tên người", "email", "số điện thoại"]
    }
  }
]
```
Văn bản trả về trong `result.content` sẽ bị thay thế thành dạng: "Ứng viên [TÊN NGƯỜI] với email [EMAIL]..."

---

### Use case 7: Phân loại nhóm Văn bản (Document Classification)
Nhận một file không rõ nguồn gốc và để AI auto-dán nhãn (tự động phân luồng mail phòng ban).

Payload JSON `pipeline`:
```json
[
  { 
    "processor": "prebuilt-layout"
  },
  { 
    "processor": "prebuilt-classify",
    "variables": {
      "labels": ["Hợp đồng", "Báo cáo nội bộ", "CV Xin việc", "Hóa đơn VAT", "Khác"]
    }
  }
]
```
Kết quả trong `result.extracted_data`:
```json
{
  "document_type": "Hợp đồng",
  "confidence": 0.95,
  "language": "Vietnamese",
  "key_topics": ["Thỏa thuận", "Bảo mật", "Lương bổng"]
}
```

---

### Use case 8: So sánh 2 phiên bản của Hợp Đồng (Semantic Versioning)
Phát hiện sự thay đổi thầm lặng trong hợp đồng sau khi đối tác chỉnh sửa và gửi lại file PDF. Đánh giá mức độ nghiêm trọng (Significance).

**Cấu trúc Request Form:**
- `sourceFile`: *File Bản gốc của Công ty.pdf*
- `targetFile`: *File Bản Đối tác gửi lại.pdf*
- `pipeline`: 
```json
[
  { 
    "processor": "prebuilt-compare"
  }
]
```
Output `result.extracted_data` trả về JSON liệt kê rõ ràng các điểm sửa đổi:
```json
{
  "similarity_score": 0.98,
  "total_changes": 2,
  "differences": [
    {
      "type": "modified",
      "section": "Điều 4: Phạt vi phạm",
      "original_text": "Phạt 10% giá trị hợp đồng nếu chậm tiến độ",
      "changed_text": "Phạt 2% giá trị hợp đồng nếu chậm tiến độ",
      "significance": "high",
      "explanation": "Đối tác đã hạ mức phạt xuống rất thấp, cần Cảnh báo"
    }
  ]
}
```

---

### Use case 9: Kiểm tra chéo dữ liệu & Tuân thủ (Fact-checking & Cross-referencing)
Kiểm tra nội dung file dữ liệu (PDF/DOCX/Ánh) đối chiếu với một tập dữ liệu tham chiếu gốc (JSON hoặc Text) theo các quy tắc nghiệp vụ/tuân thủ cụ thể. Nghiệp vụ này ứng dụng cao trong: Đối soát hóa đơn với PO mua hàng, KYC chứng từ nhân thân, kiểm định lại hợp đồng theo điều khoản chuẩn của công ty.

> [!TIP]
> **Recipe Endpoints (Tích hợp nhanh):**
> Bên cạnh cách dùng `POST /api/v1/documents/process`, hệ thống cung cấp sẵn các API chuyên dùng nhận trực tiếp Form-Data gồm các tham số `file`, `reference_text`, và `check_prompt`:
> - `POST /api/v1/fact-check`: Bất đồng bộ, thích hợp xử lý file lớn - trả về operation UUID dùng để Polling.
> - `POST /api/v1/fact-check/sync`: Đồng bộ, trả kết quả ngay lập tức (phù hợp file nhỏ sinh lời sớm trong < 120s vòng đời HTTP Request).

**Cấu trúc Request Form (`pipeline` gốc):**
- `file`: *File Hóa đơn/Hợp đồng (PDF/DOCX)*
- `pipeline`: 
```json
[
  { 
    "processor": "prebuilt-fact-check",
    "variables": {
      "reference_text": "{\"po_number\": \"PO-123\", \"total_amount\": 5000000, \"vendor_name\": \"Công ty ABC\", \"vat_rate\": \"10%\"}",
      "check_prompt": "1) Tổng số tiền hóa đơn khớp chính xác với PO. 2) Tên vendor khớp với chứng từ PO. 3) VAT áp dụng đúng 10%."
    }
  }
]
```

Output nhận lại tại `result.extracted_data` (hoặc response nhận ngay trực tiếp nếu dùng endpoint `/fact-check/sync`), cấu trúc JSON báo cáo như sau:
```json
{
  "verdict": "FAIL",
  "score": 66,
  "summary": "Tài liệu sai lệch với dữ liệu tham chiếu ở tổng giá trị hóa đơn.",
  "checks": [
    {
      "rule": "Tổng số tiền hóa đơn khớp chính xác với PO",
      "status": "FAIL",
      "document_value": "5,500,000",
      "reference_value": "5,000,000",
      "explanation": "Số tiền bị đội lên 500k so với thỏa thuận mua hàng"
    },
    {
       "rule": "VAT áp dụng đúng 10%",
       "status": "PASS",
       "document_value": "10%",
       "reference_value": "10%",
       "explanation": "Mức thuếVAT khớp nhau"
    }
  ],
  "discrepancies": [
    "Số tiền trên hóa đơn (5,500,000) chênh lệch cao hơn quy định trên PO gốc (5,000,000)"
  ]
}
```

---

## 4. Đặc thù Quản trị (Dành riêng cho Quản trị viên)

### Dynamic GenAI (Zero-Config Processor)
Nếu bạn có API Key quyền Admin, bạn có quyền pass thẳng 1 prompt bất kì mà không cần tạo cấu trúc template cố định trên Server. Rất phù hợp với nội bộ test các prompt mới.
```json
[
  {
    "processor": "dynamic-genai",
    "variables": {
      "prompt": "Hãy phân tích rủi ro phong thủy từ tài liệu kiến trúc này và trả ra cho tôi JSON chứa { risk_level, advice }.",
      "response_schema": {
        "type": "object",
        "properties": {
          "risk_level": { "type": "string" },
          "advice": { "type": "string" }
        }
      }
    }
  }
]
```
*Việc này sẽ bỏ qua ranh giới an toàn của System Prompt và đáp ứng đúng logic truyền động truyền thống.*
