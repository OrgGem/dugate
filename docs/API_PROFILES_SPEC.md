# DUGate API Specification — Core Profiles & Workflow Profiles

> Tài liệu đặc tả (spec) đầy đủ cho **DUGate — Document Understanding API Gateway**.
> Phạm vi: kiến trúc tổng quan, **6 core profiles** (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) và **3 workflow profiles** (`disbursement`, `lc-checker`, `doc-compare`), bao gồm toàn bộ request/response mẫu.

---

## 1. Tổng quan kiến trúc

```
Client → POST /api/v1/docs/{service} (multipart/form-data)
       → Runner (lib/endpoints/runner.ts)
           • Xác thực: x-api-key → apiKeyId (hoặc session NextAuth/OIDC)
           • Resolve sub-case theo discriminator (mode/type/task/action/process)
           • Load ProfileEndpoint theo (apiKeyId, endpointSlug)
           • Merge parameters: Profile (DB) + Client (form), enforce isLocked
       → submitPipelineJob (lưu file, tạo Operation, enqueue BullMQ)
       → Worker: Pipeline Engine (tuần tự) hoặc Workflow Engine (DAG)
       → Client poll GET /api/v1/operations/{id} (Long-Running Operation)
```

### 1.1 Định danh endpoint (endpoint slug)

| Loại | Slug | Ví dụ |
|---|---|---|
| Core (có sub-case) | `{service}:{subCase}` | `extract:invoice`, `analyze:fact-check` |
| Core (mặc định) | `{service}` | `ingest`, `compare` |
| Workflow | `workflows:{process}` | `workflows:disbursement` |

### 1.2 Luồng xử lý & trạng thái Operation

- Async: trả về `202 Accepted` + header `Operation-Location`.
- Sync: thêm query `?sync=true` → chờ worker xong, trả `200` kèm result.
- Trạng thái: `PENDING` → `RUNNING` → `SUCCEEDED` | `FAILED` | `WAITING_USER_INPUT` (HITL).
- Webhook: field `webhook_url` (form) — gửi `{operation_id, state, done}` (thử lại tối đa 3 lần).
- Idempotency: header `idempotency-key` — trả lại operation cũ nếu trùng key.

### 1.3 Cơ chế Profile (ProfileEndpoint)

Mỗi API key có thể được cấu hình riêng trên từng endpoint:

- `parameters` — JSON `{ "<tên biến>": { "value": ..., "isLocked": bool } }`.
  Client gửi form field trùng tên biến bị `isLocked: true` → lỗi `400 Forbidden Field`.
- `connectionsOverride` — danh sách connector thay thế pipeline mặc định.
- `jobPriority` — `HIGH | MEDIUM | LOW` → BullMQ priority (1/10/20).
- `_workflowPrompts` (chỉ workflow) — override prompt từng bước DAG:
  ```json
  { "_workflowPrompts": { "value": { "classify": "...", "report": "..." }, "isLocked": false } }
  ```
  Thứ tự ưu tiên prompt: **Code Prompt > Profile Override > DB Connector Default**.

### 1.4 Định dạng request chung

- `Content-Type: multipart/form-data` — file qua `files[]` (nhiều), `file`/`source_file`/`target_file` (đơn), hoặc `file_urls` (JSON array `[{url, filename?, mime_type?}]`).
- Header: `x-api-key: dg_...` (bắt buộc với client), `idempotency-key`, `x-correlation-id`.
- Field discriminator (bắt buộc): `mode` | `type` | `task` | `action` | `process` tùy service.

### 1.5 Định dạng response chung

**202 Accepted (async):**
```json
{
  "name": "operations/{id}",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "pipeline": ["ext-doc-layout"],
    "current_step": 0,
    "progress_percent": 0,
    "progress_message": "Initializing pipeline...",
    "create_time": "2026-08-21T10:00:00.000Z",
    "update_time": "2026-08-21T10:00:00.000Z",
    "pipeline_steps": []
  }
}
```

**200 OK (sync hoặc poll khi done):**
```json
{
  "name": "operations/{id}",
  "done": true,
  "metadata": {
    "state": "SUCCEEDED",
    "pipeline": ["ext-doc-layout"],
    "current_step": 0,
    "progress_percent": 100,
    "progress_message": null,
    "create_time": "2026-08-21T10:00:00.000Z",
    "update_time": "2026-08-21T10:00:01.500Z",
    "pipeline_steps": []
  },
  "result": {
    "output_format": "json",
    "content": "markdown hoặc JSON string từ AI",
    "extracted_data": { "...": "JSON đã parse" },
    "pipeline_steps": [],
    "usage": {
      "input_tokens": 1200,
      "output_tokens": 800,
      "pages_processed": 3,
      "model_used": "gemini-2.0-flash",
      "cost_usd": 0.0042,
      "breakdown": []
    },
    "download_url": "/api/v1/operations/{id}/download"
  }
}
```

**Lỗi (RFC 7807):**
```json
{
  "type": "https://dugate.vn/errors/{slug}",
  "title": "Invalid Parameter",
  "status": 400,
  "detail": "'mode' must be one of: parse, ocr, digitize, split. Got: 'xyz'."
}
```
Mã lỗi phổ biến: `400` (param/schema), `401` (sai key), `403` (endpoint disabled / locked field), `404` (connector/workflow), `413` (quá dung lượng), `422` (connector disabled), `402` (hết hạn mức chi tiêu), `503` (storage/queue đầy).

---

## 2. Core Profiles

> Base URL: `http://localhost:2023/api/v1/docs`

### 2.1 ingest — Document Ingestion

`POST /api/v1/docs/ingest` — discriminator: `mode`

| mode | Mô tả | Connector | Tham số |
|---|---|---|---|
| `parse` | Đọc cấu trúc file số (PDF/DOCX native), giữ header/footer/bảng | `ext-doc-layout` | `output_format` (md/json/html/csv, default json), `language` (vi/en/ja/zh) |
| `ocr` | OCR bản scan/ảnh chụp | `ext-doc-layout` | `language` |
| `digitize` | Số hóa form viết tay, checkbox | `ext-vision-reader` | — |
| `split` | Cắt/tách trang PDF | `ext-pdf-tools` | `pages` ("1-5") |

**Request mẫu (ingest:parse):**
```bash
curl -X POST http://localhost:2023/api/v1/docs/ingest \
  -H "x-api-key: dg_live_xxx" \
  -F "mode=parse" \
  -F "output_format=md" \
  -F "language=vi" \
  -F "files[]=@contract.pdf"
```

**Response mẫu (poll thành công):**
```json
{
  "done": true,
  "metadata": { "state": "SUCCEEDED", "pipeline": ["ext-doc-layout"], "progress_percent": 100 },
  "result": {
    "output_format": "md",
    "content": "# HỢP ĐỒNG...\n\n## Điều 1...",
    "extracted_data": null,
    "usage": { "input_tokens": 2400, "output_tokens": 1100, "pages_processed": 5, "cost_usd": 0.0031 }
  }
}
```

### 2.2 extract — Data Extraction

`POST /api/v1/docs/extract` — discriminator: `type`

| type | Mô tả | Preset fields (tự động inject) |
|---|---|---|
| `invoice` | Hóa đơn VAT/invoice | `vendor_name, vendor_address, invoice_number, invoice_date, due_date, line_items[]{description, quantity, unit_price, amount}, subtotal, tax_amount, total_amount, currency, payment_method, bank_account` |
| `contract` | Hợp đồng | `parties[]{name, role, address}, effective_date, expiry_date, contract_value, payment_terms, terms[], obligations[], penalties[], signatures[]{name, title, date}, governing_law` |
| `id-card` | CCCD/Passport | `full_name, id_number, date_of_birth, gender, nationality, place_of_origin, place_of_residence, issue_date, expiry_date, issued_by` |
| `receipt` | Biên lai | `merchant_name, merchant_address, receipt_number, receipt_date, items[]{name, quantity, price}, subtotal, tax, total, payment_method` |
| `table` | Tách toàn bộ bảng | — |
| `custom` | Schema động | `fields` ("a,b,c") hoặc `schema` (JSON Schema string) |

**Request mẫu (extract:custom):**
```bash
curl -X POST http://localhost:2023/api/v1/docs/extract \
  -H "x-api-key: dg_live_xxx" \
  -F "type=custom" \
  -F 'fields=ten_khach_hang,so_dien_thoai,dia_chi_giao_hang' \
  -F "files[]=@purchase-order.pdf"
```

**Response mẫu (extract:invoice — `extracted_data`):**
```json
{
  "vendor_name": "Công ty TNHH Mock Technology Solutions",
  "invoice_number": "INV-2026-04-0042",
  "invoice_date": "2026-04-01",
  "due_date": "2026-05-01",
  "line_items": [
    { "description": "Dịch vụ phát triển phần mềm", "quantity": 1, "unit_price": 50000000, "amount": 50000000 }
  ],
  "subtotal": 73500000,
  "tax_amount": 7350000,
  "total_amount": 80850000,
  "currency": "VND",
  "payment_method": "Chuyển khoản ngân hàng",
  "bank_account": "0123456789 - Vietcombank"
}
```

### 2.3 analyze — Document Analysis

`POST /api/v1/docs/analyze` — discriminator: `task`

| task | Mô tả | Connector | Tham số |
|---|---|---|---|
| `classify` | Phân loại taxonomy | `ext-classifier` | `categories` |
| `sentiment` | Cảm xúc (tích cực/tiêu cực/trung tính) | `ext-sentiment` | — |
| `compliance` | Kiểm tra tuân thủ theo tiêu chí | `ext-compliance` | `criteria` |
| `fact-check` | Đối soát với nguồn sự thật | `ext-data-extractor` → `ext-fact-verifier` | `reference_data` (JSON string), `extract_fields` |
| `quality` | Chấm điểm văn phong | `ext-quality-eval` | `criteria` |
| `risk` | Đánh giá rủi ro | `ext-quality-eval` | — |
| `summarize-eval` | Tóm lược + đánh giá chuyên gia | `ext-content-gen` | — |

**Request mẫu (analyze:compliance):**
```bash
curl -X POST http://localhost:2023/api/v1/docs/analyze \
  -H "x-api-key: dg_live_xxx" \
  -F "task=compliance" \
  -F 'criteria=Phải có chữ ký hai bên; phải có mộc đỏ; phải ghi rõ ngày hiệu lực' \
  -F "files[]=@contract.pdf"
```

**Response mẫu (analyze:compliance — `extracted_data`):**
```json
{
  "verdict": "FAIL",
  "score": 60,
  "summary": "Thiếu chữ ký bên B và mộc đỏ.",
  "checks": [
    { "rule": "Phải có chữ ký hai bên", "status": "FAIL", "explanation": "Chỉ tìm thấy chữ ký bên A tại trang 3" },
    { "rule": "Phải có mộc đỏ", "status": "FAIL", "explanation": "Không phát hiện mộc đỏ" },
    { "rule": "Phải ghi rõ ngày hiệu lực", "status": "PASS", "explanation": "Điều 8.1 ghi ngày 01/01/2026" }
  ],
  "discrepancies": []
}
```

### 2.4 transform — Document Transformation

`POST /api/v1/docs/transform` — discriminator: `action`

| action | Mô tả | Connector | Tham số |
|---|---|---|---|
| `convert` | Đổi định dạng (DOCX→MD/HTML) | `ext-doc-layout` | `output_format` |
| `translate` | Dịch thuật | `ext-translator` | `target_language`, `tone` |
| `rewrite` | Viết lại (paraphrase) | `ext-rewriter` | `style` (academic/executive/simplified/bullet_points), `tone` |
| `redact` | Che PII | `ext-redactor` | `redact_patterns` |
| `template` | Mail merge theo template | `ext-redactor` | `template` |

**Request mẫu (transform:translate):**
```bash
curl -X POST http://localhost:2023/api/v1/docs/transform \
  -H "x-api-key: dg_live_xxx" \
  -F "action=translate" \
  -F "target_language=vi" \
  -F "tone=business" \
  -F "files[]=@policy-en.pdf"
```

**Response mẫu (transform:redact — `content`):**
```json
{
  "content": "Khách hàng: [REDACTED]. SĐT: [REDACTED]. CCCD: [REDACTED].",
  "extracted_data": null
}
```

### 2.5 generate — Content Generation

`POST /api/v1/docs/generate` — discriminator: `task`

| task | Mô tả | Connector | Tham số |
|---|---|---|---|
| `summary` | Tóm tắt nén cao | `ext-content-gen` | `format` (paragraph/bullets/numbered/table/mind_map), `max_words`, `audience` |
| `outline` | Trích mục lục H1/H2/H3 | `ext-content-gen` | `format` |
| `report` | Báo cáo phân tích chuyên gia | `ext-content-gen` | — |
| `email` | Nháp email phản hồi | `ext-content-gen` | `tone` |
| `minutes` | Biên bản họp + Action Items | `ext-content-gen` | `format` |
| `qa` | Hỏi đáp trên tài liệu (RAG-like) | `ext-qa-engine` | `questions` |

**Request mẫu (generate:qa):**
```bash
curl -X POST http://localhost:2023/api/v1/docs/generate \
  -H "x-api-key: dg_live_xxx" \
  -F "task=qa" \
  -F 'questions=["Tổng hạn mức tín dụng là bao nhiêu?","Ai chịu trách nhiệm bồi thường khi hàng hỏng?"]' \
  -F "files[]=@credit-agreement.pdf"
```

**Response mẫu (generate:summary — `content`):**
```json
{
  "content": "## Tóm tắt\n\nHợp đồng quy định hạn mức tín dụng 50 tỷ VND, lãi suất 9.5%/năm...",
  "extracted_data": null
}
```

### 2.6 compare — Document Comparison

`POST /api/v1/docs/compare` — discriminator: `mode` — yêu cầu **2 file** (`source_file` + `target_file` hoặc `files[]` 2 phần tử).

| mode | Mô tả | Connector | Tham số |
|---|---|---|---|
| `diff` | So sánh text từng dòng (git-diff style) | `ext-comparator` | `output_format` |
| `semantic` | So sánh ngữ nghĩa/pháp lý | `ext-comparator` | `focus` |
| `version` | Sinh changelog tóm lược | `ext-comparator` | `output_format` |

**Request mẫu (compare:semantic):**
```bash
curl -X POST http://localhost:2023/api/v1/docs/compare \
  -H "x-api-key: dg_live_xxx" \
  -F "mode=semantic" \
  -F "focus=liên đới trách nhiệm hai bên" \
  -F "source_file=@policy-v1.pdf" \
  -F "target_file=@policy-v2.pdf"
```

**Response mẫu (compare:diff — `content`):**
```json
{
  "content": "## Thay đổi\n\n[DEL] Điều 3.2: phụ cấp thưởng ngoài 5 triệu\n[NEW] Điều 3.2: quyền lợi phép năm 15 ngày",
  "extracted_data": null
}
```

---

## 3. Workflow Profiles

> Base URL: `http://localhost:2023/api/v1/docs/workflows` — discriminator: `process`
> Tất cả workflow đều là **async** (`202` + poll), hỗ trợ checkpoint/resume, HITL (`WAITING_USER_INPUT`), prompt override theo từng bước.

### 3.1 workflows:disbursement — Đối chiếu giải ngân

**DAG 4 bước:**
```
Step 1: Classify từng file (ext-classifier)          [song song]
Step 2: Extract từng file (ext-data-extractor)       [song song]
        → PAUSE (WAITING_USER_INPUT) chờ người duyệt
Step 3: Cross-check Nghị quyết (ext-fact-verifier)   [tuần tự]
Step 4: Soạn Tờ trình (ext-content-gen)              [tuần tự]
```

**Request mẫu:**
```bash
curl -X POST http://localhost:2023/api/v1/docs/workflows \
  -H "x-api-key: dg_live_xxx" \
  -F "process=disbursement" \
  -F 'resolution_data={"so_nq":"01/NQ-HĐQT","han_muc":5000000000,"lai_suat":9.5}' \
  -F "files[]=@hop-dong-tin-dung.pdf" \
  -F "files[]=@hoa-don.pdf" \
  -F "files[]=@de-nghi-giai-ngan.pdf"
```

**Trạng thái trung gian (poll → WAITING_USER_INPUT, sau bước 2):**
```json
{
  "done": false,
  "metadata": {
    "state": "WAITING_USER_INPUT",
    "workflow": "disbursement",
    "current_step": 2,
    "progress_percent": 55,
    "progress_message": "Vui lòng kiểm tra và phê duyệt kết quả OCR trước khi tiếp tục.",
    "pipeline_steps": [
      {
        "step": 1,
        "stepName": "OCR & Bóc tách (3 file)",
        "processor": "ext-data-extractor",
        "sub_results": [
          { "file_name": "hop-dong-tin-dung.pdf", "logical_docs": ["Hợp đồng tín dụng"], "status": "success" }
        ],
        "extracted_data": [
          { "file_name": "hop-dong-tin-dung.pdf", "documents": [ { "label": "Hợp đồng tín dụng", "fields": { "Số hợp đồng": "HD-2026-001", "Số tiền": "5.000.000.000" } } ] }
        ]
      }
    ]
  }
}
```

**Response mẫu (poll thành công — `result`):**
```json
{
  "result": {
    "output_format": "json",
    "content": "# TỜ TRÌNH THẨM ĐỊNH HỒ SƠ GIẢI NGÂN\n\n**Kính gửi:** Ban Giám đốc...\n\n## 2. KẾT QUẢ ĐỐI CHIẾU\n- Kết luận: PASS (95/100)...",
    "extracted_data": {
      "verdict": "PASS",
      "score": 95,
      "summary": "Hồ sơ hợp lệ, đủ điều kiện giải ngân.",
      "checks": [
        { "rule": "Số tiền giải ngân không vượt hạn mức", "status": "PASS", "document_value": "4.5 tỷ", "reference_value": "5 tỷ", "explanation": "Khớp" }
      ],
      "discrepancies": []
    },
    "usage": { "input_tokens": 8500, "output_tokens": 3200, "cost_usd": 0.018 }
  }
}
```

### 3.2 workflows:lc-checker — Kiểm tra Bộ chứng từ LC (UCP 600 / ISBP 821)

**DAG 3 bước:**
```
Step 1: OCR từng chứng từ (ext-doc-layout)           [song song]
Step 2: Compliance check hybrid (OCR text + PDF gốc đính kèm) (ext-fact-verifier)  [tuần tự]
Step 3: Báo cáo kiểm tra LC (ext-content-gen)        [tuần tự]
```

**Request mẫu:**
```bash
curl -X POST http://localhost:2023/api/v1/docs/workflows \
  -H "x-api-key: dg_live_xxx" \
  -F "process=lc-checker" \
  -F "files[]=@lc.pdf" \
  -F "files[]=@invoice.pdf" \
  -F "files[]=@bill-of-lading.pdf" \
  -F "files[]=@certificate-of-origin.pdf" \
  -F "files[]=@insurance-cert.pdf"
```

**Response mẫu (poll thành công — `extracted_data`):**
```json
{
  "verdict": "DISCREPANT",
  "total_discrepancies": 2,
  "major_discrepancies": 1,
  "minor_discrepancies": 1,
  "advisory_count": 1,
  "documents_present": ["lc.pdf", "invoice.pdf", "bill-of-lading.pdf", "certificate-of-origin.pdf", "insurance-cert.pdf"],
  "documents_missing": ["packing-list.pdf"],
  "discrepancies": [
    {
      "rule": "TR-3: Invoice description matches LC",
      "severity": "MAJOR",
      "document": "invoice.pdf",
      "issue": "Mô tả hàng hóa không khớp L/C (thiếu 'CIF Hai Phong')",
      "ref": "UCP 600 Art. 18(c)"
    }
  ],
  "summary": "Bộ chứng từ có 1 discrepancy nghiêm trọng về mô tả hàng hóa.",
  "recommendation": "RESERVE_FOR_REVIEW"
}
```

### 3.3 workflows:doc-compare — So sánh Văn bản Nâng cao

**DAG 4 bước:** yêu cầu **đúng 2 file**.
```
Step 1: OCR từng văn bản (ext-doc-layout)            [song song]
Step 2: Trích xuất Mục lục 2 văn bản (ext-doc-compare)  [tuần tự]
Step 3: So sánh từng mục (ext-doc-compare)           [tuần tự]
Step 4: Báo cáo so sánh (ext-content-gen)            [tuần tự]
```

**Request mẫu:**
```bash
curl -X POST http://localhost:2023/api/v1/docs/workflows \
  -H "x-api-key: dg_live_xxx" \
  -F "process=doc-compare" \
  -F "source_file=@quy-dinh-v1.pdf" \
  -F "target_file=@quy-dinh-v2.pdf"
```

**Response mẫu (poll thành công — `extracted_data`):**
```json
{
  "doc1_name": "quy-dinh-v1.pdf",
  "doc2_name": "quy-dinh-v2.pdf",
  "summary": "Văn bản mới thêm 1 mục, sửa 2 mục, xóa 1 mục.",
  "total_sections_doc1": 10,
  "total_sections_doc2": 10,
  "matched_count": 8,
  "added_count": 1,
  "removed_count": 1,
  "modified_count": 2,
  "unchanged_count": 6,
  "sections": [
    {
      "section_id": "2.2",
      "type": "modified",
      "doc1_section": { "number": "2.2", "title": "Thẩm định hồ sơ", "content_summary": "2 bước thẩm định" },
      "doc2_section": { "number": "2.2", "title": "Thẩm định hồ sơ", "content_summary": "3 bước thẩm định (thêm thẩm định rủi ro)" },
      "changes": ["Thêm bước 2.2.3 Thẩm định rủi ro"],
      "significance": "high"
    },
    { "section_id": "5", "type": "added", "doc2_section": { "number": "5", "title": "Biểu mẫu mới BM-03" }, "changes": [], "significance": "medium" }
  ]
}
```

**Response `content`:** báo cáo Markdown hoàn chỉnh (Tổng quan → Thống kê → Chi tiết thay đổi quan trọng → Mục thêm/xóa → Bảng tổng hợp → Kết luận & khuyến nghị).

---

## 4. So sánh nhanh các Profile

| Đặc điểm | Core (6 service) | Workflow (3 process) |
|---|---|---|
| Route | `/api/v1/docs/{service}` | `/api/v1/docs/workflows` |
| Discriminator | `mode`/`type`/`task`/`action` | `process` |
| Pipeline | Tuyến tính, ≤ 5 connector | DAG, song song + checkpoint |
| Trả về | `202` + poll, hoặc `200` nếu `?sync=true` | Luôn `202` + poll |
| HITL (duyệt thủ công) | Không | Có (`disbursement`) |
| Prompt override | Theo step connector (`ExternalApiOverride`) | Theo bước DAG (`_workflowPrompts`) |
| Số file tối thiểu | 1 (compare: 2) | 1 (doc-compare: 2) |
| Ví dụ slug | `extract:invoice` | `workflows:lc-checker` |

---

## 5. Danh sách Connector tham chiếu

| Slug | Vai trò | Dùng bởi |
|---|---|---|
| `ext-doc-layout` | Parse layout / OCR | ingest:parse, ingest:ocr, transform:convert, workflow OCR steps |
| `ext-vision-reader` | Digitize viết tay | ingest:digitize |
| `ext-pdf-tools` | Split/merge PDF | ingest:split |
| `ext-data-extractor` | Trích xuất JSON có cấu trúc | extract:*, analyze:fact-check (step 1), disbursement (step 2) |
| `ext-classifier` | Phân loại tài liệu | analyze:classify, disbursement (step 1) |
| `ext-sentiment` | Phân tích cảm xúc | analyze:sentiment |
| `ext-compliance` | Kiểm tra tuân thủ | analyze:compliance |
| `ext-fact-verifier` | Đối soát sự thật / cross-check | analyze:fact-check (step 2), disbursement (step 3), lc-checker (step 2) |
| `ext-quality-eval` | Chấm điểm / rủi ro | analyze:quality, analyze:risk |
| `ext-translator` | Dịch thuật | transform:translate |
| `ext-rewriter` | Viết lại nội dung | transform:rewrite |
| `ext-redactor` | Che PII / template | transform:redact, transform:template |
| `ext-content-gen` | Sinh nội dung / báo cáo | generate:*, analyze:summarize-eval, workflow report steps |
| `ext-qa-engine` | Hỏi đáp tài liệu | generate:qa |
| `ext-comparator` | So sánh văn bản | compare:diff, compare:semantic, compare:version |
| `ext-doc-compare` | Phân tích mục lục + so sánh mục | doc-compare (step 2, 3) |
| `ext-prompt-wizard` / `sys-assistant` | Hỗ trợ prompt wizard / chat | Nội bộ |

> Ghi chú: môi trường dev dùng `mock-service` (port 3099) mô phỏng toàn bộ connector với `x-api-key: DUMMY_SECRET_KEY`, hỗ trợ `?scenario=success|error|timeout` để test.

---

## 6. Checklist tích hợp nhanh

1. Gọi API bằng `x-api-key` hợp lệ; nếu field bị lock bởi profile → bỏ qua, không gửi.
2. Luôn kèm discriminator đúng (vd `mode=parse`, `process=disbursement`).
3. Async: lưu `operation_id` từ response `202`, poll `GET /api/v1/operations/{id}` (hoặc dùng `webhook_url`).
4. Workflow `disbursement`: xử lý trạng thái `WAITING_USER_INPUT` — chờ phê duyệt rồi mới tiếp tục (resume).
5. Kiểm tra `usage.cost_usd` và `metadata.state` trước khi dùng `result.content` / `result.extracted_data`.
