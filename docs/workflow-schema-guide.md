# Workflow Schema Guide — DUGate Schema-Driven Workflow Builder

> **Mục đích**: Tài liệu này hướng dẫn AI Agent (hoặc Developer) cách tạo file WorkflowSchema JSON/XML từ một BRD (Business Requirements Document) để import vào DUGate và chạy như một business workflow tự động.

---

## 1. Tổng quan kiến trúc

DUGate có một **Workflow Builder engine** cho phép định nghĩa business workflow dưới dạng **schema JSON** (canonical) hoặc **XML**, lưu trữ trong DB, và thực thi bởi worker.

`
[BRD] --► AI Agent --► WorkflowSchema.json --► Import UI/API --► DB (appSettings) --► Worker chạy
`

### Luồng import

1. Bạn tạo file .json hoặc .xml theo spec dưới đây.
2. Import qua **UI**: /workflow-builder → nút "Import Schema" → chọn file.
3. Hoặc import qua **API**: POST /api/internal/workflow-schemas với body { schema: <object> } hoặc { xml: "<string>" }.
4. API validate schema, nếu OK thì lưu vào bảng ppSettings với key wb_schema:<slug>.
5. Khi worker nhận job pipeline:workflows:<slug>, nó tra WORKFLOW_REGISTRY trước, nếu không thấy thì fallback vào loadSchema(slug) → chạy schema-driven.

### Các ràng buộc quan trọng

| Rule | Mô tả |
|------|-------|
| slug | Bắt buộc, unique, không dấu cách, dùng làm key lưu trữ. |
| low | Phải là mảng không rỗng, mỗi phần tử là id của một node trong 
odes. |
| 
odes | Phải có, mỗi node có id unique. |
| connector slug | Node connector phải có connector là slug của ExternalApiConnection có trong hệ thống. |
| Node types | Chỉ chấp nhận 10 loại (xem bảng dưới). |
| $binding | Các binding reference phải trỏ đến node/input/files có thật. |

---

## 2. Cấu trúc schema (WorkflowSchema) — field-by-field

### 2.1 Top-level

`	ypescript
interface WorkflowSchema {
  slug: string;              // [REQUIRED] Unique ID, lowercase, không dấu cách
  name: string;              // [REQUIRED] Tên hiển thị (có thể tiếng Việt)
  version?: number;          // Optional, mặc định 1 khi import
  description?: string;      // Mô tả workflow làm gì
  input_schema?: InputSchema; // Khai báo biến đầu vào → UI sẽ tự render form
  nodes: WorkflowNode[];     // Danh sách tất cả node (10 loại)
  flow: string[];            // Thứ tự thực thi: mảng các node id
  output?: {                 // Khai báo output cuối cùng
    from: string;            // node id lấy content chính
    extra_data_from?: string;// node id lấy extractedData bổ sung
  };
}
`

### 2.2 InputSchema (khai báo biến đầu vào)

Dùng để khai báo business variables mà workflow cần (số tiền, ngày tháng, dữ liệu tham chiếu…). UI sẽ tự động sinh form nhập liệu từ các property này.

`	ypescript
interface InputSchema {
  type: 'object';           // luôn là 'object'
  properties: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
    label?: string;          // Nhãn hiển thị (tiếng Việt)
    required?: boolean;      // true = bắt buộc nhập
    widget?: 'textarea' | 'number' | 'select'; // gợi ý widget hiển thị
    description?: string;    // Mô tả / hướng dẫn nhập liệu
    default?: unknown;       // Giá trị mặc định
  }>;
}
`

Ví dụ input_schema:
`json
{
  "type": "object",
  "properties": {
    "resolution_data": {
      "type": "object", "required": true, "widget": "textarea",
      "label": "Nghị quyết tham chiếu",
      "description": "Số NQ, hạn mức, lãi suất, điều kiện."
    },
    "limit_amount": {
      "type": "number", "required": true, "widget": "number",
      "label": "Hạn mức (VND)", "default": 5000000000
    }
  }
}
`

### 2.3 Output declaration

`json
{
  "output": {
    "from": "report",
    "extra_data_from": "crosscheck"
  }
}
`

---

## 3. 10 loại Node — chi tiết từng loại

### 3.1 connector — Gọi ExternalApiConnection

Gọi một API connector đã đăng ký trong hệ thống (ext-classifier, ext-data-extractor, ext-content-gen…).

`	ypescript
{
  id: string;            // [REQUIRED] unique trong schema
  type: 'connector';
  connector: string;     // [REQUIRED] slug của ExternalApiConnection
  promptOverrideKey?: string; // key trong promptOverrides để override prompt
  inputs?: Record<string, Binding>; // map tên biến → binding
  outputPath?: string;   // dot-path vào kết quả JSON của connector
}
`

**Mục đích**: Node trung tâm — gọi AI model, classifier, extractor, generator, fact-checker…

**Ví dụ**:
`json
{
  "id": "classify",
  "type": "connector",
  "connector": "ext-classifier",
  "promptOverrideKey": "classify",
  "inputs": { "file": "" }
}
`

### 3.2 parallel — Rẽ nhánh song song

Chạy nhiều nhánh đồng thời, mỗi nhánh là một mảng node riêng.

`	ypescript
{
  id: string;
  type: 'parallel';
  branches: WorkflowNode[][];  // [REQUIRED] mảng các nhánh
}
`

**Mục đích**: Xử lý đồng thời nhiều luồng (parse nhiều file, gọi nhiều API độc lập).

**Ví dụ**:
`json
{
  "id": "parse_all",
  "type": "parallel",
  "branches": [
    [{ "id": "parse_hd", "type": "file_parse", "source": ".0" }],
    [{ "id": "parse_pl", "type": "file_parse", "source": ".1" }]
  ]
}
`

### 3.3 join — Gộp kết quả các nhánh

Sau parallel, dùng join để gộp output của tất cả nhánh.

`	ypescript
{
  id: string;
  type: 'join';
  combine?: 'concat' | 'first' | 'merge'; // mặc định 'concat'
}
`

| combine | Hành vi |
|---------|---------|
| concat | Gộp tất cả output thành mảng |
| irst | Lấy output của nhánh đầu tiên |
| merge | Merge object (nếu là object) |

### 3.4 ile_parse — Parse tài liệu (docx/xlsx/pdf)

`	ypescript
{
  id: string;
  type: 'file_parse';
  source: Binding;       // [REQUIRED] binding trỏ đến file path(s)
  parser?: 'auto' | 'excel' | 'word' | 'pdf'; // mặc định 'auto'
}
`

**Ví dụ**:
`json
{ "id": "parse_contract", "type": "file_parse", "source": "", "parser": "auto" }
`

### 3.5 ile_url_download — Download file từ URL

`	ypescript
{
  id: string;
  type: 'file_url_download';
  urls: Binding;         // [REQUIRED] binding trỏ đến mảng URL entries
  auth?: {
    type: 'none' | 'bearer' | 'header' | 'query';
    token?: string; header_name?: string; header_value?: string;
    query_key?: string; query_value?: string;
  };
  allowedExtensions?: string;
}
`

**Ví dụ**:
`json
{
  "id": "download_contracts",
  "type": "file_url_download",
  "urls": ".document_urls",
  "auth": { "type": "bearer", "token": ".api_token" },
  "allowedExtensions": ".pdf,.docx,.xlsx"
}
`

### 3.6 callback — Webhook callback

`	ypescript
{
  id: string;
  type: 'callback';
  url: Binding;           // [REQUIRED] URL đích
  payload?: Binding;      // nội dung gửi
  method?: 'POST' | 'GET'; // mặc định POST
  auth?: { /* như file_url_download */ };
}
`

**Ví dụ**:
`json
{
  "id": "notify_complete",
  "type": "callback",
  "url": ".callback_url",
  "payload": ".content",
  "method": "POST"
}
`

### 3.7 rchive_compress — Nén file thành ZIP

`	ypescript
{
  id: string;
  type: 'archive_compress';
  source: Binding;       // [REQUIRED] mảng entry (file path hoặc {name, content})
  name?: string;         // tên file zip
  level?: number;        // mức nén (0-9, mặc định 6)
}
`

**Ví dụ**:
`json
{
  "id": "zip_results",
  "type": "archive_compress",
  "source": ".output",
  "name": "contracts.zip"
}
`

### 3.8 rchive_extract — Giải nén ZIP an toàn

`	ypescript
{
  id: string;
  type: 'archive_extract';
  source: Binding;       // [REQUIRED] Buffer hoặc file path
  destName?: string;
  maxTotalBytes?: number; // giới hạn dung lượng (mặc định: 100MB)
  maxEntries?: number;   // giới hạn số file (mặc định: 1000)
}
`

**Ví dụ**:
`json
{
  "id": "unzip_input",
  "type": "archive_extract",
  "source": "",
  "maxTotalBytes": 52428800,
  "maxEntries": 500
}
`

### 3.9 human — Human-in-the-Loop (HITL)

Tạm dừng workflow, chờ người dùng kiểm tra và phê duyệt.

`	ypescript
{
  id: string;
  type: 'human';
  message: string;          // [REQUIRED] thông báo (tiếng Việt)
  resumeInputs?: string[];  // node id có sẵn để review trước khi resume
}
`

**Ví dụ**:
`json
{
  "id": "human_review",
  "type": "human",
  "message": "Vui lòng kiểm tra kết quả bóc tách trước khi phê duyệt.",
  "resumeInputs": ["extract"]
}
`

### 3.10 input — Khai báo biến đầu vào

`	ypescript
{
  id: string;
  type: 'input';
  key: string;           // [REQUIRED] tên biến, truy cập qua .<key>
}
`

**Ví dụ**:
`json
{ "id": "resolution", "type": "input", "key": "resolution_data" }
`

---

## 4. Binding Syntax — Cách tham chiếu dữ liệu

### 4.1 Các dạng binding

| Cú pháp | Ý nghĩa | Ví dụ |
|---------|---------|-------|
| $input.<key> | Biến đầu vào từ form/request | $input.limit_amount |
| $<node_id> | Toàn bộ output của node | $classify |
| $<node_id>.<path> | Dot-path vào output của node | $classify.output |
| $files | Mảng đường dẫn file đã upload | $files |
| literal | Giá trị giữ nguyên | "auto" |

### 4.2 Binding cookbook

| Tình huống | Binding |
|------------|---------|
| Gửi file upload vào connector | "" |
| Chuyển kết quả classify sang extract | ".output" |
| Lấy content text từ node parse | ".content" |
| Tham chiếu biến nhập từ form | ".limit_amount" |
| Dùng kết quả download làm nguồn parse | ".output" |

### 4.3 Lưu ý

- $files là mảng string path. Hệ thống tự động JSON.stringify khi truyền vào connector.
- $input.<key> phải khớp với property trong input_schema.
- Dot-path có thể deep: $extract.data.items.0.name.
- String không bắt đầu bằng $ là literal, dùng nguyên.

---

## 5. Validation Rules

Khi import, alidateSchema() kiểm tra:

1. slug phải có (string, không rỗng).
2. low phải là mảng không rỗng.
3. 
odes phải là mảng.
4. **Không trùng** id giữa các node.
5. Mỗi id trong low phải tồn tại trong 
odes.
6. Node 	ype chỉ được là 1 trong 10 loại.
7. Node connector phải có field connector không rỗng.

> ⚠️ alidateSchema không kiểm tra connector slug tồn tại trong DB — việc đó xảy ra lúc runtime.

---

## 6. Workflow Examples

### 6.1 Linear workflow (Classify → Extract → Report)

`json
{
  "slug": "simple-doc-processing",
  "name": "Xử lý tài liệu cơ bản",
  "version": 1,
  "description": "Classify → Extract → Report trên file upload",
  "input_schema": {
    "type": "object",
    "properties": {
      "doc_type": {
        "type": "string", "required": true, "widget": "select",
        "label": "Loại tài liệu",
        "description": "Chọn loại tài liệu cần xử lý"
      }
    }
  },
  "nodes": [
    {
      "id": "classify", "type": "connector", "connector": "ext-classifier",
      "promptOverrideKey": "classify",
      "inputs": { "file": "", "doc_type": ".doc_type" }
    },
    {
      "id": "extract", "type": "connector", "connector": "ext-data-extractor",
      "promptOverrideKey": "extract",
      "inputs": { "file": "", "classification": ".output" }
    },
    {
      "id": "report", "type": "connector", "connector": "ext-content-gen",
      "promptOverrideKey": "report",
      "inputs": { "text": ".content" }
    }
  ],
  "flow": ["classify", "extract", "report"],
  "output": { "from": "report", "extra_data_from": "extract" }
}
`

### 6.2 Parallel + Join (Download → Parse song song → Gộp → Report)

`json
{
  "slug": "parallel-doc-merge",
  "name": "Gộp tài liệu song song",
  "version": 1,
  "description": "Download 2 URL → parse song song → gộp → báo cáo",
  "input_schema": {
    "type": "object",
    "properties": {
      "url1": { "type": "string", "required": true, "label": "URL tài liệu 1" },
      "url2": { "type": "string", "required": true, "label": "URL tài liệu 2" }
    }
  },
  "nodes": [
    { "id": "download1", "type": "file_url_download", "urls": ".url1", "allowedExtensions": ".pdf,.docx" },
    { "id": "download2", "type": "file_url_download", "urls": ".url2", "allowedExtensions": ".pdf,.docx" },
    {
      "id": "parse_both", "type": "parallel",
      "branches": [
        [{ "id": "parse1", "type": "file_parse", "source": ".output", "parser": "auto" }],
        [{ "id": "parse2", "type": "file_parse", "source": ".output", "parser": "auto" }]
      ]
    },
    { "id": "merge", "type": "join", "combine": "concat" },
    {
      "id": "summary", "type": "connector", "connector": "ext-content-gen",
      "promptOverrideKey": "summary", "inputs": { "text": ".output" }
    }
  ],
  "flow": ["download1", "download2", "parse_both", "merge", "summary"],
  "output": { "from": "summary" }
}
`

### 6.3 HITL workflow (Classify → Extract → Người duyệt → Crosscheck → Report)

`json
{
  "slug": "disbursement-review",
  "name": "Đối chiếu giải ngân",
  "version": 1,
  "description": "Quy trình đối chiếu giải ngân có người phê duyệt ở giữa",
  "input_schema": {
    "type": "object",
    "properties": {
      "resolution_data": {
        "type": "object", "required": true, "widget": "textarea",
        "label": "Nghị quyết tham chiếu",
        "description": "Số NQ, hạn mức, lãi suất, điều kiện giải ngân."
      },
      "limit_amount": {
        "type": "number", "required": true, "widget": "number",
        "label": "Hạn mức (VND)", "default": 5000000000
      },
      "rate": {
        "type": "number", "widget": "number",
        "label": "Lãi suất (%)", "default": 9.5
      }
    }
  },
  "nodes": [
    { "id": "classify", "type": "connector", "connector": "ext-classifier", "promptOverrideKey": "classify", "inputs": { "file": "" } },
    { "id": "extract", "type": "connector", "connector": "ext-data-extractor", "promptOverrideKey": "extract", "inputs": { "file": "", "logical_docs": ".output" } },
    { "id": "human_review", "type": "human", "message": "Vui lòng kiểm tra và phê duyệt kết quả bóc tách trước khi tiếp tục.", "resumeInputs": ["extract"] },
    { "id": "crosscheck", "type": "connector", "connector": "ext-fact-verifier", "promptOverrideKey": "crosscheck", "inputs": { "text": ".content", "reference": ".resolution_data", "limit": ".limit_amount" } },
    { "id": "report", "type": "connector", "connector": "ext-content-gen", "promptOverrideKey": "report", "inputs": { "text": ".content" } }
  ],
  "flow": ["classify", "extract", "human_review", "crosscheck", "report"],
  "output": { "from": "report", "extra_data_from": "crosscheck" }
}
`

---

## 7. XML Format (thay thế cho JSON)

### 7.1 Cấu trúc XML

`xml
<workflow slug="slug-name" name="Tên workflow" version="1" description="Mô tả">
  <input>
    <property name="var_name" type="string" required="true" label="Nhãn" widget="textarea" description="Mô tả" />
  </input>
  <nodes>
    <node id="classify" type="connector" connector="ext-classifier" promptOverrideKey="classify">
      <input key="file" value="" />
    </node>
    <node id="human_step" type="human" message="Nhập dữ liệu" resumeInputs="extract" />
    <node id="parse" type="file_parse" source="" parser="auto" />
    <node id="zip" type="archive_compress" source=".output" name="result.zip" />
  </nodes>
  <flow>
    <step id="classify" />
    <step id="human_step" />
    <step id="parse" />
  </flow>
  <output from="zip" extra_data_from="extract" />
</workflow>
`

### 7.2 Các node đặc biệt trong XML

- **parallel**:
`xml
<node id="parse_all" type="parallel">
  <branch>
    <node id="parse1" type="file_parse" source=".0" />
  </branch>
  <branch>
    <node id="parse2" type="file_parse" source=".1" />
  </branch>
</node>
`
- **join**: <node id="merge" type="join" combine="concat" />
- **callback**: <node id="cb" type="callback" url=".webhook_url" method="POST" payload=".content" />
- **archive_extract**: <node id="unzip" type="archive_extract" source="" maxTotalBytes="104857600" />
- **file_url_download**: <node id="dl" type="file_url_download" urls=".urls" allowedExtensions=".pdf" />
- **input**: <node id="resolution" type="input" key="resolution_data" />

---

## 8. API Import Reference

### Import JSON
`
POST /api/internal/workflow-schemas
Content-Type: application/json
{ "schema": { "slug": "...", "name": "...", "nodes": [...], "flow": [...] } }
`

### Import XML
`
POST /api/internal/workflow-schemas
Content-Type: application/json
{ "xml": "<workflow slug=\"...\">...</workflow>" }
`

### List
`
GET /api/internal/workflow-schemas
`

### Detail
`
GET /api/internal/workflow-schemas?slug=<slug>
`

### Delete
`
DELETE /api/internal/workflow-schemas?slug=<slug>
`

---

## 8.1 API Chạy Workflow (Trigger Run)

Sau khi schema đã import (mục 8), bạn có thể trigger chạy workflow qua endpoint public bên dưới. Worker sẽ nạp schema từ DB theo slug, validate lại, chạy DAG và ghi kết quả vào Operation.

### Trigger Run
```
POST /api/v1/docs/workflows/schema
Content-Type: multipart/form-data

Fields:
  schemaSlug : string (bắt buộc) — slug của workflow schema đã import
  input      : string (tuỳ chọn) — chuỗi JSON chứa biến đầu vào (khớp input_schema)
  files      : file[] (tuỳ chọn) — file tài liệu cho các node cần file ($files)
  apiKeyId   : string (tuỳ chọn) — ID hoặc chuỗi raw API key; mặc định dùng admin key
```

Response 202 Accepted:
```
{
  "name": "operations/<uuid>",
  "done": false,
  "metadata": { "state": "RUNNING", "workflow": "<slug>", "progress_percent": 0, "progress_message": "Initializing schema workflow..." }
}
```

Poll trạng thái: `GET /api/v1/operations/<uuid>` (lấy <uuid> từ `name`).

### Ví dụ curl

Chạy workflow với biến đầu vào (không cần file):
```
curl -X POST http://localhost:2023/api/v1/docs/workflows/schema \
  -H "x-api-key: <API_KEY>" \
  -F "schemaSlug=disbursement" \
  -F 'input={"so_nq":"01","ngay_nq":"2026-08-01"}'
```

Chạy workflow kèm file:
```
curl -X POST http://localhost:2023/api/v1/docs/workflows/schema \
  -H "x-api-key: <API_KEY>" \
  -F "schemaSlug=disbursement" \
  -F "files=@/path/to/hop-dong.pdf"
```

### Ghi chú
- Workflow có `human` node sẽ trả về state `WAITING_INPUT` và pause chờ duyệt; sau khi resume, các binding `$<node>...` của các block sau vẫn hoạt động nhờ nodeResults được lưu trong context.
- Nếu schema chưa import, API trả 404 với message hướng dẫn vào /workflow-builder.
- Nếu schema sai cấu trúc, API trả 400 kèm danh sách lỗi validate.

---

## 9. Agent Prompt Template

Dưới đây là template bạn dùng khi gửi BRD cho AI Agent:

`
Bạn là chuyên gia phân tích BRD và tạo workflow schema cho DUGate.
Dựa trên BRD sau, hãy tạo một file JSON theo format WorkflowSchema.

## Yêu cầu:
- Xác định các bước quy trình nghiệp vụ từ BRD.
- Mỗi bước là một node với type phù hợp.
- Đặt slug ngắn gọn, lowercase, không dấu cách.
- Dùng .<key> cho biến nhập từ form.
- Dùng $<node_id> để tham chiếu output node khác.
- Khai báo input_schema cho biến đầu vào.
- Nếu có bước con người → human node.
- Nếu có xử lý song song → parallel + join.
- Kết quả trả về là JSON hợp lệ (không markdown code block).
`

---

## 10. Common Pitfalls

| Lỗi | Nguyên nhân | Cách fix |
|-----|-------------|----------|
| Schema requires a slug | Thiếu slug | Thêm slug lowercase |
| Flow references missing node 'X' | flow có id X không có node | Thêm node hoặc sửa flow |
| Duplicate node id 'X' | Hai node trùng id | Đổi id unique |
| Connector node 'X' requires a 'connector' slug | Thiếu field connector | Thêm "connector": "slug" |
| Unsupported node type 'xxx' | Sai type | Kiểm tra 10 type |
| Connector lỗi "not found" | Slug không tồn tại trong DB | Kiểm tra ExternalApiConnection |
| $files không hoạt động | Dùng $file thay vì $files | Luôn dùng $files |
| Binding không resolve | Sai tên node hoặc thứ tự flow | Kiểm tra flow và id |

---

## 11. File tham khảo

| File | Vai trò |
|------|---------|
| lib/workflow-builder/types.ts | Định nghĩa types |
| lib/workflow-builder/binding.ts | Resolve binding |
| lib/workflow-builder/interpreter.ts | DAG runner + validate |
| lib/workflow-builder/real-exec.ts | Gọi connector, parser, download… |
| lib/workflow-builder/run-schema.ts | Tích hợp worker |
| lib/workflow-builder/loader.ts | Lưu/tải DB |
| lib/workflow-builder/xml-converter.ts | XML ↔ JSON |
| lib/workflow-builder/examples/schema-disbursement.ts | Ví dụ mẫu |
| pp/api/internal/workflow-schemas/route.ts | API import |
| pp/workflow-builder/page.tsx | UI import |

---

## 12. Quick-start: Tạo schema từ BRD

1. Đọc BRD, xác định **mục tiêu đầu ra**.
2. Xác định **đầu vào** (file? biến? URL?).
3. Liệt kê các **bước xử lý** theo thứ tự.
4. Với mỗi bước, chọn **loại node**:
   - Gọi AI → connector
   - Parse file → ile_parse
   - Download URL → ile_url_download
   - Webhook → callback
   - Nén/ZIP → rchive_compress
   - Giải nén → rchive_extract
   - Cần người duyệt → human
   - Song song → parallel + join
   - Khai báo biến → input
5. Đặt slug và 
ame.
6. Viết input_schema cho các biến.
7. Viết low theo thứ tự.
8. Khai báo output.from.
9. Validate bằng API.
10. Import vào DUGate.

---

> **Tài liệu thân thiện với AI Agent**: Copy toàn bộ nội dung trên vào context của agent, kèm BRD, yêu cầu agent tạo WorkflowSchema.json hợp lệ.
