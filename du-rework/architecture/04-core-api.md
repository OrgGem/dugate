# 04 — Đặc tả chức năng sáu core API

Đọc [quy ước public API](03-public-api.md) trước. Tất cả submit trả chung Operation 202; ví dụ `data` bên dưới là phần nằm trong ResultEnvelope khi GET result thành công, không phải response tức thì của POST. Đây là mẫu contract mục tiêu dựa trên business types hiện tại, chưa chứng nhận integration.

Canonical: `/api/v1/businesses/document-core/actions/{action}`. Facade: `/api/v1/docs/{action}`. Mẫu JSON dùng camelCase; facade cũ map snake_case. `input.action` của transform map sang `variant` nội bộ. `artifacts` top-level phải được adapter chuyển thành artifact IDs có quyền cho worker; bridge này còn cần contract test.

## 1. Ingest — nhập và tiền xử lý

| Field | Kiểu / điều kiện | Ý nghĩa |
|---|---|---|
| `mode` | string, bắt buộc | parse / ocr / digitize / split |
| `pages` | string, tùy chọn | Trang 1-based, ví dụ `1-3,5`; không vượt page count |
| `language` | string, tùy chọn | Ngôn ngữ tài liệu; cần thống nhất BCP-47 và mapping OCR provider |
| `artifacts` | top-level array, bắt buộc cho public ingest | File nguồn role `source`; split cần PDF |

| Mode | Thực hiện | `data` mục tiêu / giới hạn |
|---|---|---|
| parse | Native parse tài liệu số | text/markdown + metadata parser; không tự bịa layout/bounding boxes |
| ocr | OCR ảnh/scan qua slot `ocr` | Nội dung nhận dạng + provenance; cần provider capability |
| digitize | Nhận dạng biểu mẫu/viết tay | formFields + metadata; cần vision/OCR phù hợp và corpus kiểm chứng |
| split | Chọn/tách trang PDF | splitArtifacts với artifactId, fileName, pageCount, pageRange; phải là PDF mở được |

```json
{"input": {"mode": "parse", "language": "vi"}, "artifacts": [{"artifactId": "11111111-1111-4111-8111-111111111111", "role": "source"}], "output": {"format": "json"}}
```

`data` minh họa:

```json
{"text": "Hóa đơn INV-001...", "markdown": "# Hóa đơn INV-001", "metadata": {"pageCount": 1, "detectedFormat": "pdf", "parser": "native-pdf", "provenance": "native_parse"}}
```

Lỗi cần test: scan không có OCR binding; MIME giả; file encrypted/hỏng; page range sai; resource limit. Không trả success với rỗng/placeholder vì parser chưa hỗ trợ. Output lớn được externalize sang artifact theo schema đã freeze.

## 2. Extract — trích xuất dữ liệu

`type` bắt buộc; nguồn là `input.text` không rỗng hoặc source artifacts. `fields: string[]` chọn trường ở custom; `schema: object` là JSON Schema hữu hạn, không network `$ref`. Khuyến nghị dùng schema rõ ràng cho custom; chỉ `fields` thì worker phải tạo output schema xác định trước inference.

| Type | Output `data` | Yêu cầu |
|---|---|---|
| invoice | supplier, buyer, invoiceNumber, invoiceDate, lineItems, subtotal, total, currency; VAT nếu có | Validate số/tiền/ngày; không tự coi dữ liệu model là số liệu đã hạch toán |
| contract | parties, title/effectiveDate/expiryDate/value/currency/penaltyClauses/governingLaw nếu có | Thiếu thông tin phải có warning hoặc lỗi theo schema, không bịa |
| receipt | merchantName, date?, items, totalAmount, paymentMethod? | Phân biệt hóa đơn và biên lai |
| table | tables[] gồm title?, headers[], rows[][] | Rows khớp columns theo policy |
| custom | Object/array đúng schema khách cung cấp | Output schema validation bắt buộc |

```json
{"input": {"type": "custom", "text": "Mã đơn hàng PO-123. Tổng tiền 500000 VND.", "schema": {"type": "object", "properties": {"orderId": {"type": "string"}, "total": {"type": "number"}}, "required": ["orderId", "total"], "additionalProperties": false}}, "output": {"format": "json"}}
```

```json
{"orderId": "PO-123", "total": 500000}
```

Không bao gồm `id-card` chỉ vì tài liệu project gốc có nhắc. Malformed JSON từ provider phải fail hoặc repair trong budget rồi validate lại. Missing required fields không được thay bằng số 0 để vượt schema.

## 3. Analyze — phân tích và đánh giá

`task` bắt buộc; nguồn text/artifacts. `categories: string[]` bắt buộc khi classify; `criteria: string[]` cho compliance/quality; `referenceData: object|string` là dữ liệu đối chiếu khi dùng. Khuyến nghị client luôn gửi arrays thay vì chuỗi phân cách.

| Task | Output `data` | Giải thích |
|---|---|---|
| classify | category, confidence, reasoning, secondaryCategories? | Category thuộc taxonomy; confidence là tín hiệu model, không phải xác suất đã hiệu chuẩn |
| sentiment | sentiment, score, explanation | positive/negative/neutral/mixed; score từ -1 đến 1 |
| compliance | status PASS/FAIL, score, violations[] | Violation gồm rule, severity, excerpt/recommendation nếu có |
| quality | overallScore, grammarScore, clarityScore, logicScore, suggestions[] | Thang điểm phải được freeze; đề xuất 0–100 |
| risk | riskLevel, riskScore, risks[] | Mức LOW/MEDIUM/HIGH/CRITICAL; đề xuất score 0–100 |

```json
{"input": {"task": "classify", "text": "Hợp đồng cung cấp dịch vụ giữa bên A và bên B.", "categories": ["contract", "invoice", "report"]}}
```

```json
{"category": "contract", "confidence": 0.94, "reasoning": "Tài liệu quy định các bên và nghĩa vụ cung cấp dịch vụ."}
```

Không đưa `fact-check` hay `summarize-eval` vào v1 nếu chưa đăng ký schema. Compliance/risk là nhận định hỗ trợ review, không tự biến thành quyết định phê duyệt hoặc xác nhận pháp lý. Thiếu tiêu chí phải reject, không để model tự chọn chuẩn đánh giá.

## 4. Transform — chuyển đổi nội dung

Public discriminator `input.action` bắt buộc; nội bộ gọi `variant`. Nguồn text/artifacts; `output.format` giới hạn theo converter/variant. Mapping sang `outputFormat` nội bộ phải thống nhất, không nhận hai giá trị mâu thuẫn.

| Action | Input bổ sung | Output / giới hạn |
|---|---|---|
| convert | Output format được hỗ trợ | transformedText, outputFormat; không cam kết DOCX/PDF roundtrip layout |
| translate | targetLanguage bắt buộc; tone tùy chọn | Nội dung dịch; chunking phải tránh mất phần cuối |
| rewrite | style, tone | style academic/executive/simplified/bullet_points; bảo toàn thông tin cần thiết |
| redact | redactPatterns[] | Nhóm pattern được hỗ trợ như EMAIL/PHONE; không hứa phát hiện mọi PII |
| template | template bắt buộc; nguồn biến theo schema | Điền template hữu hạn, không chạy script; mapping biến cần freeze |

```json
{"input": {"action": "translate", "text": "The contract starts on 1 October 2026.", "targetLanguage": "vi", "tone": "formal"}, "output": {"format": "text"}}
```

```json
{"transformedText": "Hợp đồng có hiệu lực từ ngày 1 tháng 10 năm 2026.", "outputFormat": "text", "metadata": {"targetLanguage": "vi", "method": "llm_translation"}}
```

Tone dự kiến formal/casual/business/academic. Template data binding hiện chưa có public contract hoàn chỉnh: không công bố ví dụ mail-merge tùy ý như API đã sẵn sàng. Redact trên text không đồng nghĩa xóa PII khỏi binary gốc, metadata hoặc layer ẩn của PDF.

## 5. Generate — tạo nội dung từ tài liệu

`task` bắt buộc; nguồn text/artifacts. `format` là layout paragraph/bullets/numbered/table, khác `output.format` là serialization. `maxWords` integer dương có giới hạn profile; `tone`, `audience` tùy chọn; `questions: string[]` không rỗng cho qa.

| Task | Output `data` |
|---|---|
| summary | summaryText, wordCount, keyPoints? |
| outline | outlineItems[]: level, title, summary? |
| report | title, executiveSummary, sections[], recommendations[] |
| email | subject, salutation, body, signoff |
| minutes | meetingTopic?, attendees?, decisions[], actionItems[]: assignee, task, deadline? |
| qa | answers[]: question, answer, evidenceQuote?, confidence |

```json
{"input": {"task": "summary", "text": "Dự án triển khai tháng 10. Đội A phụ trách API, đội B phụ trách vận hành.", "format": "bullets", "maxWords": 100, "audience": "project manager"}}
```

```json
{"summaryText": "- Triển khai tháng 10.\n- Đội A phụ trách API; đội B phụ trách vận hành.", "wordCount": 18, "keyPoints": ["Triển khai tháng 10", "Phân công API và vận hành"]}
```

Quy tắc đếm từ cần freeze, số trong ví dụ chỉ minh họa. QA thiếu evidence phải thể hiện không đủ dữ liệu, không tự thêm tri thức ngoài tài liệu như fact chắc chắn. Email chỉ tạo nháp, không tự gửi email. Biên bản không tự tạo task trong hệ thống bên ngoài.

## 6. Compare — so sánh tài liệu

`mode` bắt buộc. `source` và `target` bắt buộc, mỗi phía đúng một `text` hoặc `artifactId`; `focus` tùy chọn cho semantic/version. Nếu dùng artifact trong side, vẫn phải khai báo top-level artifact với role source/target để platform validate/grant nhất quán; quy tắc ánh xạ này cần freeze.

| Mode | Cách xử lý | Output |
|---|---|---|
| diff | So sánh văn bản xác định | Changes/hunks có vị trí nếu parser hỗ trợ; schema hunks cần freeze |
| semantic | LLM so sánh ý nghĩa | Danh sách SemanticChange: changeType, sourceExcerpt?, targetExcerpt?, legalSignificance, commentary |
| version | Tổng hợp thay đổi | versionSummary, additions[], modifications[], deletions[] |

```json
{"input": {"mode": "version", "source": {"text": "Thanh toán trong 30 ngày."}, "target": {"text": "Thanh toán trong 45 ngày."}, "focus": "payment terms"}}
```

```json
{"versionSummary": "Gia hạn thời hạn thanh toán.", "additions": [], "modifications": ["Thời hạn thanh toán thay đổi từ 30 thành 45 ngày."], "deletions": []}
```

Không đồng nhất semantic similarity với byte equality. Location/page references chỉ có khi nguồn cung cấp. Không dùng thứ tự file upload để đoán source/target.

## Yêu cầu nghiệm thu áp dụng cả 28 biến thể

Mỗi variant cần valid/invalid input, required capability, profile lock, output schema, fixture có expected result và giới hạn kích thước. Local parser/diff dùng deterministic tests; LLM dùng mock cho protocol và corpus thật cho chất lượng. File quá dài phải chunk có coverage/provenance hoặc reject rõ ràng; cắt đầu tài liệu rồi trả success là không đạt.

Chi tiết BRD/fixture matrix của lane business: [field dictionary](../businesses/document-core/docs/field-dictionary.md), [28 variants](../businesses/document-core/docs/variant-matrix.md). Khi khác nhau giữa BRD, manifest và shared contract, phải giải quyết ở contract gate; không mặc định tài liệu nào mô tả nhiều hơn là đã hỗ trợ nhiều hơn.
