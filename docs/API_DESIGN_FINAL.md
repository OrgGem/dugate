# DUGATE DOCUMENT AI — API SPECIFICATION v3 (Hybrid)

> **Status**: Final Design  
> **Architecture**: Hybrid Processor-Pipeline  
> **Base URL**: `/api/v1`  
> **Auth**: Header `x-api-key`  
> **Error Format**: RFC 9457 (Problem Details)  
> **Pagination**: Cursor-based (AIP-158)  
> **References**: Google AIP, Azure Document Intelligence, AWS Textract, OpenAI Batch API  

---

## 1. DESIGN PRINCIPLES

### 1.1 Hybrid Processor-Pipeline

Kết hợp 2 mô hình:
- **Processor**: Đóng gói prompt + schema + LLM config phía server. Client
  chỉ tham chiếu `processor_id` + `variables`, KHÔNG gửi prompt tự do.
- **Pipeline**: Cho phép chain nhiều Processors trong 1 request. Output bước
  trước tự động truyền làm input bước sau. 1 request = 1 Operation.

```
┌─────────────────────────────────────────────────────────────────┐
│                       Client Request                            │
│                                                                 │
│  POST /api/v1/documents:process                                 │
│  {                                                              │
│    file: report.pdf,                                            │
│    pipeline: [                                                  │
│      { processor: "prebuilt-layout" },                          │
│      { processor: "prebuilt-translate", variables: {lang:"vi"}} │
│    ]                                                            │
│  }                                                              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Dugate API Gateway                         │
│             x-api-key validation → Rate Limit                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Pipeline Engine                              │
│                                                                 │
│   Step 1: prebuilt-layout                                       │
│   ┌──────────────────────────────────────────────┐              │
│   │ PDF → Pandoc/Gemini → Markdown               │              │
│   └─────────────────────┬────────────────────────┘              │
│                         │ output (markdown)                     │
│                         ▼                                       │
│   Step 2: prebuilt-translate                                    │
│   ┌──────────────────────────────────────────────┐              │
│   │ Markdown EN → Gemini + Prompt → Markdown VI  │              │
│   └─────────────────────┬────────────────────────┘              │
│                         │ final result                          │
│                         ▼                                       │
│   Save to DB (Operation) + Notify webhook                       │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Tại sao Hybrid?

| Tiêu chí                | Processor-Only | Pipeline-Only | Hybrid ✅      |
|--------------------------|----------------|---------------|----------------|
| Bảo mật (chống Injection)| ✅ Tốt nhất    | ⚠️ Rủi ro     | ✅ Tốt nhất    |
| Chain nhiều bước / 1 call| ❌ Không       | ✅ Có         | ✅ Có          |
| Round-trip network       | N call / N bước| 1 call        | 1 call         |
| Billing theo SKU         | ✅ Dễ          | ❌ Khó        | ✅ Dễ          |
| Native Next.js routing   | ⚠️ Cần rewrite| ✅ Tự nhiên   | ✅ Tự nhiên    |
| Độ phức tạp Backend      | Thấp           | Cao           | Trung bình     |

### 1.3 Long-Running Operations (Google AIP-151)

Mọi tác vụ trả về **Operation** object. Client polling qua
`GET /operations/{id}`. Khi `done = true`, kết quả nằm ngay trong
Operation resource — không cần endpoint `/result` riêng.

### 1.4 Idempotency (AIP-155)

Mọi `POST` nhận header `Idempotency-Key` (UUID) để retry an toàn.

### 1.5 Error Format (RFC 9457)

```json
{
  "type": "https://dugate.vn/errors/invalid-processor",
  "title": "Processor Not Found",
  "status": 404,
  "detail": "Processor 'xyz' does not exist or is not authorized.",
  "instance": "/api/v1/documents:process"
}
```

---

## 2. ENDPOINT MAP

```
/api/v1
│
├── POST   /documents:process              ★ Core — Submit pipeline
│
├── /operations                            Long-Running Operations
│   ├── GET    /                           List (history, pagination)
│   ├── GET    /{id}                       Status + Result (when done)
│   ├── POST   /{id}:cancel               Cancel running
│   ├── DELETE /{id}                       Delete + cleanup files
│   └── GET    /{id}:download              Download output files
│
├── /processors                            Processor Registry
│   ├── GET    /                           List available processors
│   └── GET    /{id}                       Processor detail + variables schema
│
└── /billing                               Cost Management
    ├── GET    /balance                    Account balance
    └── GET    /usage                      Usage breakdown
```

**Tổng: 10 endpoints.**

---

## 3. ENDPOINT SPECIFICATIONS

### 3.1 ★ Core — Document Processing

#### `POST /api/v1/documents:process`

> **Endpoint trung tâm duy nhất.** Nhận file + pipeline (1 hoặc nhiều bước).
> Luôn trả về Operation (async).

**Headers:**

| Header             | Required | Description                     |
|--------------------|----------|---------------------------------|
| `x-api-key`        | Yes      | API Key xác thực                |
| `Idempotency-Key`  | No       | UUID chống duplicate            |

**Request Body** `multipart/form-data`:

| Field           | Type     | Required | Description                                                |
|-----------------|----------|----------|------------------------------------------------------------|
| `file`          | binary   | Yes*     | Tài liệu đầu vào (PDF, DOCX)                              |
| `source_file`   | binary   | No       | File gốc — chỉ khi pipeline chứa `prebuilt-compare`        |
| `target_file`   | binary   | No       | File đối chiếu — chỉ khi pipeline chứa `prebuilt-compare`  |
| `pipeline`      | string   | Yes      | JSON array mô tả chuỗi processors cần chạy                |
| `output_format` | string   | No       | Override output format bước cuối: `md`/`html`/`json`        |
| `webhook_url`   | string   | No       | URL callback khi operation hoàn tất                         |

*\* `file` required trừ khi pipeline chỉ chứa `prebuilt-compare`.*

**`pipeline` field — Cấu trúc JSON:**

```json
[
  {
    "processor": "prebuilt-layout"
    // Không có variables → dùng default
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

Quy tắc:
- Tối thiểu 1 step, tối đa 5 steps.
- Output bước N tự động là input text cho bước N+1.
- Bước đầu tiên nhận `file` binary. Các bước sau nhận text output.
- Nếu chỉ có 1 step → tương đương single-processor mode.

**Response** `202 Accepted`:

```json
{
  "name": "operations/op-a1b2c3d4",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "pipeline": ["prebuilt-layout", "prebuilt-translate"],
    "current_step": 0,
    "current_processor": "prebuilt-layout",
    "progress_percent": 0,
    "create_time": "2026-03-29T10:30:00Z",
    "update_time": "2026-03-29T10:30:00Z"
  }
}
```

**Response Headers:**

| Header               | Value                                  |
|----------------------|----------------------------------------|
| `Operation-Location` | `/api/v1/operations/op-a1b2c3d4`       |

**Error — Processor không tồn tại** `404`:
```json
{
  "type": "https://dugate.vn/errors/invalid-processor",
  "title": "Processor Not Found",
  "status": 404,
  "detail": "Processor 'prebuilt-xyz' in pipeline step 1 does not exist."
}
```

**Error — Vượt giới hạn pipeline** `422`:
```json
{
  "type": "https://dugate.vn/errors/pipeline-too-long",
  "title": "Pipeline Exceeds Maximum Steps",
  "status": 422,
  "detail": "Pipeline has 7 steps. Maximum allowed is 5."
}
```

---

### 3.2 Operations (Long-Running — AIP-151)

#### `GET /api/v1/operations/{operation_id}`

> **Polling trạng thái + lấy kết quả.** Khi `done: true`, field `result`
> chứa toàn bộ output. KHÔNG cần endpoint `/result` riêng biệt.

**Response — Đang chạy** `200 OK`:
```json
{
  "name": "operations/op-a1b2c3d4",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "pipeline": ["prebuilt-layout", "prebuilt-translate"],
    "current_step": 1,
    "current_processor": "prebuilt-translate",
    "progress_percent": 55,
    "progress_message": "Đang dịch thuật...",
    "create_time": "2026-03-29T10:30:00Z",
    "update_time": "2026-03-29T10:30:45Z"
  }
}
```

**Response — Hoàn tất thành công (Single step)** `200 OK`:
```json
{
  "name": "operations/op-single-001",
  "done": true,
  "metadata": {
    "state": "SUCCEEDED",
    "pipeline": ["prebuilt-invoice"],
    "current_step": 0,
    "progress_percent": 100,
    "create_time": "2026-03-29T10:30:00Z",
    "update_time": "2026-03-29T10:30:08Z"
  },
  "result": {
    "output_format": "json",
    "content": null,
    "extracted_data": {
      "invoice_no": "HD-001234",
      "seller": "CÔNG TY ĐIỆN LỰC",
      "total_amount": 1500000
    },
    "usage": {
      "input_tokens": 8500,
      "output_tokens": 120,
      "model_used": "gemini-2.5-pro",
      "cost_usd": 0.005
    },
    "download_url": "/api/v1/operations/op-single-001:download"
  }
}
```

**Response — Hoàn tất thành công (Multi-step pipeline)** `200 OK`:
```json
{
  "name": "operations/op-chain-888",
  "done": true,
  "metadata": {
    "state": "SUCCEEDED",
    "pipeline": ["prebuilt-layout", "prebuilt-translate", "custom-bachmai-hoso"],
    "progress_percent": 100
  },
  "result": {
    "output_format": "json",
    "content": null,
    "extracted_data": {
      "patient_name": "Nguyen Van A",
      "age": 45,
      "symptoms": ["Cough", "Fever 39°C"]
    },
    "pipeline_steps": [
      {
        "step": 0,
        "processor": "prebuilt-layout",
        "output_format": "md",
        "content_preview": "# Bệnh án\n\n## Thông tin bệnh nhân..."
      },
      {
        "step": 1,
        "processor": "prebuilt-translate",
        "output_format": "md",
        "content_preview": "# Medical Record\n\n## Patient Information..."
      },
      {
        "step": 2,
        "processor": "custom-bachmai-hoso",
        "output_format": "json",
        "content_preview": null
      }
    ],
    "usage": {
      "input_tokens": 25000,
      "output_tokens": 4200,
      "model_used": "gemini-2.5-pro",
      "cost_usd": 0.035,
      "breakdown": [
        { "processor": "prebuilt-layout",       "input_tokens": 12000, "output_tokens": 3000, "cost_usd": 0.018 },
        { "processor": "prebuilt-translate",     "input_tokens": 8000,  "output_tokens": 1000, "cost_usd": 0.012 },
        { "processor": "custom-bachmai-hoso",    "input_tokens": 5000,  "output_tokens": 200,  "cost_usd": 0.005 }
      ]
    },
    "download_url": "/api/v1/operations/op-chain-888:download"
  }
}
```

**Response — Lỗi giữa pipeline** `200 OK` (operation failed):
```json
{
  "name": "operations/op-chain-999",
  "done": true,
  "metadata": {
    "state": "FAILED",
    "pipeline": ["prebuilt-layout", "prebuilt-translate"],
    "failed_at_step": 1,
    "failed_processor": "prebuilt-translate"
  },
  "error": {
    "code": "LLM_OUTPUT_ERROR",
    "message": "Translation step failed: Model returned empty response.",
    "failed_step": 1
  },
  "result": {
    "pipeline_steps": [
      {
        "step": 0,
        "processor": "prebuilt-layout",
        "output_format": "md",
        "content_preview": "# Annual Report..."
      }
    ],
    "usage": {
      "input_tokens": 12000,
      "output_tokens": 3000,
      "cost_usd": 0.018
    }
  }
}
```
> Khi pipeline fail giữa chừng, `result.pipeline_steps` vẫn chứa output
> của các bước đã thành công. Client không mất data đã xử lý.

---

#### `GET /api/v1/operations`

> **Lịch sử operations.** Cursor-based pagination.

**Query Params:**

| Param        | Type   | Description                                             |
|--------------|--------|---------------------------------------------------------|
| `page_size`  | int    | Items/page (default 20, max 100)                        |
| `page_token` | string | Opaque cursor                                           |
| `filter`     | string | `state=SUCCEEDED`, `processor=prebuilt-layout`          |
| `order_by`   | string | `create_time desc` (default)                            |

**Response** `200 OK`:
```json
{
  "operations": [
    {
      "name": "operations/op-a1b2c3d4",
      "done": true,
      "metadata": {
        "state": "SUCCEEDED",
        "pipeline": ["prebuilt-layout", "prebuilt-translate"],
        "create_time": "2026-03-29T10:30:00Z"
      }
    }
  ],
  "next_page_token": "eyJjcmVhdGVkQXQiOi..."
}
```

#### `POST /api/v1/operations/{operation_id}:cancel`

**Response** `200 OK`:
```json
{
  "name": "operations/op-a1b2c3d4",
  "done": true,
  "metadata": { "state": "CANCELLED" }
}
```

#### `DELETE /api/v1/operations/{operation_id}`

Soft delete + cleanup files trên disk.

**Response** `204 No Content`

#### `GET /api/v1/operations/{operation_id}:download`

> **Tải file kết quả.** Trả binary stream.

**Query Params:**

| Param    | Description                                |
|----------|--------------------------------------------|
| `format` | `zip` (default) / `md` / `html` / `json`  |
| `step`   | Index step cụ thể (default: bước cuối)     |

**Response**: Binary stream  
**Headers**: `Content-Disposition: attachment; filename="..."`

---

### 3.3 Processors (Registry)

#### `GET /api/v1/processors`

> Liệt kê processors mà API Key hiện tại có quyền sử dụng.

**Query Params:**

| Param      | Type   | Description                              |
|------------|--------|------------------------------------------|
| `category` | string | Filter: `extract`, `generate`, `analyze` |

**Response** `200 OK`:
```json
{
  "processors": [
    {
      "name": "processors/prebuilt-layout",
      "display_name": "Document Layout Extraction",
      "type": "PREBUILT",
      "category": "extract",
      "state": "ENABLED",
      "accepted_mime_types": [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ],
      "output_formats": ["md", "html"],
      "can_be_first_step": true,
      "can_be_chained_step": false,
      "variables_schema": null,
      "description": "Converts PDF/DOCX to structured Markdown."
    },
    {
      "name": "processors/prebuilt-translate",
      "display_name": "Document Translation",
      "type": "PREBUILT",
      "category": "generate",
      "state": "ENABLED",
      "accepted_mime_types": [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ],
      "output_formats": ["md", "html"],
      "can_be_first_step": true,
      "can_be_chained_step": true,
      "variables_schema": {
        "type": "object",
        "required": ["target_language"],
        "properties": {
          "target_language": {
            "type": "string",
            "description": "Target language",
            "examples": ["Vietnamese", "English", "Japanese"]
          },
          "tone": {
            "type": "string",
            "enum": ["formal", "casual", "technical"],
            "default": "formal"
          }
        }
      },
      "description": "Translates document while preserving formatting."
    }
  ]
}
```

> Lưu ý `can_be_first_step` và `can_be_chained_step`:
> - `prebuilt-layout`: chỉ nhận file binary → chỉ đứng đầu pipeline.
> - `prebuilt-translate`: nhận cả file lẫn text → đứng đầu hoặc giữa pipeline.
> - `prebuilt-compare`: cần 2 file → chỉ đứng đầu, không chain được.

#### `GET /api/v1/processors/{processor_id}`

Chi tiết 1 Processor bao gồm variables schema đầy đủ.

---

### 3.4 Billing

#### `GET /api/v1/billing/balance`

```json
{
  "plan": "Pay-As-You-Go",
  "currency": "USD",
  "total_granted": 100.00,
  "total_used": 12.50,
  "balance": 87.50,
  "spending_limit": 150.00
}
```

#### `GET /api/v1/billing/usage`

**Query Params**: `start_date`, `end_date`

```json
{
  "start_date": "2026-03-01",
  "end_date": "2026-03-29",
  "total_cost_usd": 12.50,
  "total_operations": 142,
  "breakdown_by_processor": [
    { "processor": "prebuilt-layout",    "operations": 85, "tokens": 180000, "cost_usd": 5.50 },
    { "processor": "prebuilt-translate", "operations": 30, "tokens": 50000,  "cost_usd": 4.00 },
    { "processor": "prebuilt-compare",   "operations": 12, "tokens": 30000,  "cost_usd": 3.00 }
  ]
}
```

---

## 4. PREBUILT PROCESSORS CATALOG

| #  | ID                    | Category  | Input     | Output  | First? | Chain? | Variables                                       |
|----|-----------------------|-----------|-----------|---------|--------|--------|-------------------------------------------------|
| 1  | `prebuilt-layout`     | extract   | 1 file    | md,html | ✅     | ❌     | —                                               |
| 2  | `prebuilt-invoice`    | extract   | 1 file    | json    | ✅     | ❌     | —                                               |
| 3  | `prebuilt-id-card`    | extract   | 1 file    | json    | ✅     | ❌     | —                                               |
| 4  | `prebuilt-contract`   | extract   | 1 file    | json    | ✅     | ❌     | `clauses_focus?: string[]`                      |
| 5  | `prebuilt-summarize`  | generate  | 1+ files  | md      | ✅     | ✅     | `max_words?: number`                            |
| 6  | `prebuilt-translate`  | generate  | 1 file    | md,html | ✅     | ✅     | `target_language: string`, `tone?: string`      |
| 7  | `prebuilt-redact`     | generate  | 1 file    | md      | ✅     | ✅     | `pii_types?: string[]`                          |
| 8  | `prebuilt-compare`    | analyze   | 2 files   | json    | ✅     | ❌     | —                                               |
| 9  | `prebuilt-classify`   | analyze   | 1 file    | json    | ✅     | ✅     | `labels?: string[]`                             |
| 10 | `dynamic-genai`       | advanced  | 1+ files  | any     | ✅     | ✅     | `prompt`, `response_schema` ⚠️ **Admin Key**   |

### Chain Compatibility Rules

- **First step** (`can_be_first_step`): Processor nhận file binary trực tiếp.
- **Chain step** (`can_be_chained_step`): Processor nhận text output từ bước trước.
- Extract processors (layout, invoice, id-card) chỉ nhận binary → chỉ đứng đầu.
- Generate/Analyze processors nhận text → đứng được ở giữa/cuối pipeline.
- `prebuilt-compare` cần 2 file → chỉ đứng đầu, pipeline chỉ 1 step.

### Ví dụ Pipeline hợp lệ

| Pipeline                                                | Mô tả                                    |
|---------------------------------------------------------|-------------------------------------------|
| `[layout]`                                              | Đơn giản: PDF → Markdown                  |
| `[layout, translate]`                                   | PDF → Markdown → Dịch tiếng Việt          |
| `[layout, redact, summarize]`                           | PDF → Markdown → Che PII → Tóm tắt       |
| `[layout, translate, custom-bachmai]`                   | PDF → MD → Dịch → Extract JSON            |
| `[invoice]`                                             | PDF Hóa đơn → JSON structured             |
| `[compare]`                                             | So sánh 2 file                             |

### Ví dụ Pipeline KHÔNG hợp lệ (Server sẽ reject 422)

| Pipeline                    | Lý do                                         |
|-----------------------------|------------------------------------------------|
| `[translate, layout]`       | `layout` không đứng được sau bước khác         |
| `[compare, summarize]`      | `compare` output JSON, `summarize` cần text    |
| `[layout, invoice]`         | `invoice` chỉ nhận file binary, không nhận text|

---

## 5. DATABASE SCHEMA

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ═══════════════════════════════════════════════
// Processor — AI Pipeline Registry
// ═══════════════════════════════════════════════
model Processor {
  id              String   @id @default(uuid())
  slug            String   @unique              // "prebuilt-layout"
  displayName     String                        // "Document Layout Extraction"
  type            String                        // "PREBUILT" | "CUSTOM"
  category        String                        // "extract" | "generate" | "analyze"
  description     String?  @db.Text
  state           String   @default("ENABLED")  // "ENABLED" | "DISABLED"

  // AI Config — Server-side only, NEVER exposed
  systemPrompt    String   @db.Text             // Template: "Dịch sang {{target_language}}..."
  responseSchema  String?  @db.Text             // JSON Schema → structured output
  maxOutputTokens Int      @default(4096)
  temperature     Float    @default(0.1)
  modelOverride   String?                       // null = system default

  // Input/Output constraints
  acceptedMimes   String                        // "application/pdf,application/vnd..."
  outputFormats   String   @default("md")       // "md,html,json"
  variablesSchema String?  @db.Text             // JSON Schema for allowed variables
  canBeFirstStep  Boolean  @default(true)       // Can receive binary file
  canBeChainStep  Boolean  @default(false)      // Can receive text from previous step

  // Tenant scoping
  tenantApiKeyId  String?                       // null = prebuilt (global)

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([slug])
  @@index([type, state])
  @@index([tenantApiKeyId])
}

// ═══════════════════════════════════════════════
// Operation — Long-Running Operation (AIP-151)
// ═══════════════════════════════════════════════
model Operation {
  id              String   @id @default(uuid())
  apiKeyId        String
  idempotencyKey  String?  @unique              // AIP-155

  // State
  done            Boolean  @default(false)
  state           String   @default("RUNNING")  // RUNNING | SUCCEEDED | FAILED | CANCELLED
  progressPercent Int      @default(0)
  progressMessage String?

  // Pipeline definition
  pipelineJson    String   @db.Text             // JSON array: [{ processor, variables }]
  currentStep     Int      @default(0)          // Index of step currently being processed
  failedAtStep    Int?                          // Step index where pipeline failed (null if ok)

  // Input
  fileName        String?
  fileMime        String?
  fileSize        Int      @default(0)
  inputPath       String?                       // File on disk

  // Compare-specific
  sourceFilePath  String?
  targetFilePath  String?

  // Output — final result
  outputFormat    String   @default("md")
  outputContent   String?  @db.Text             // Final step content (md/html/json)
  outputFilePath  String?                       // Full output file on disk
  extractedData   String?  @db.Text             // Structured JSON (if processor has schema)

  // Pipeline intermediate results
  stepsResultJson String?  @db.Text             // JSON array of per-step outputs

  // Usage & Cost (aggregated across all steps)
  totalInputTokens  Int    @default(0)
  totalOutputTokens Int    @default(0)
  pagesProcessed    Int    @default(0)
  modelUsed         String?
  totalCostUsd      Float  @default(0.0)
  usageBreakdown    String? @db.Text            // JSON: per-processor cost breakdown

  // Webhook
  webhookUrl      String?
  webhookSentAt   DateTime?

  // Error
  errorCode       String?
  errorMessage    String?  @db.Text

  // Lifecycle
  filesDeleted    Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  deletedAt       DateTime?

  apiKey          ApiKey   @relation(fields: [apiKeyId], references: [id])

  @@index([state])
  @@index([apiKeyId, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
  @@index([idempotencyKey])
}

// ═══════════════════════════════════════════════
// API Key & Auth
// ═══════════════════════════════════════════════
model ApiKey {
  id            String      @id @default(uuid())
  name          String                          // "Production Key"
  keyHash       String      @unique             // bcrypt hash
  prefix        String                          // "sk-abc1..." (display only)
  role          String      @default("STANDARD") // "STANDARD" | "ADMIN"
  spendingLimit Float       @default(0.0)
  totalUsed     Float       @default(0.0)
  status        String      @default("active")  // "active" | "revoked"
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  operations    Operation[]

  @@index([status])
}

// ═══════════════════════════════════════════════
// App Settings (key-value store)
// ═══════════════════════════════════════════════
model AppSetting {
  id        String   @id @default(uuid())
  key       String   @unique
  value     String   @db.Text
  updatedAt DateTime @updatedAt
}
```

---

## 6. NEXT.JS FILE STRUCTURE

```
app/api/v1/
├── documents/
│   └── process/
│       └── route.ts                    # POST /documents:process (core)
│
├── operations/
│   ├── route.ts                        # GET  /operations (list)
│   └── [id]/
│       ├── route.ts                    # GET  /operations/{id} + DELETE
│       ├── cancel/
│       │   └── route.ts               # POST /operations/{id}:cancel
│       └── download/
│           └── route.ts               # GET  /operations/{id}:download
│
├── processors/
│   ├── route.ts                        # GET  /processors
│   └── [id]/
│       └── route.ts                   # GET  /processors/{id}
│
├── billing/
│   ├── balance/
│   │   └── route.ts                   # GET  /billing/balance
│   └── usage/
│       └── route.ts                   # GET  /billing/usage
│
└── swagger/
    └── route.ts                        # GET  /swagger (OpenAPI spec)
```

> Next.js routing maps cleanly: `/documents/process/route.ts` handles
> `POST /api/v1/documents:process`. No rewrites needed — the `:process`
> suffix is just API naming convention, actual URL path is `/documents/process`.

---

## 7. USE-CASE EXAMPLES

### UC1: Đơn giản — PDF → Markdown
```bash
curl -X POST /api/v1/documents:process \
  -H "x-api-key: sk-xxx" \
  -F "file=@report.pdf" \
  -F 'pipeline=[{"processor":"prebuilt-layout"}]'

# → 202: { "name": "operations/op-001", ... }
# → GET /operations/op-001 → done:true → result.content = "# Report..."
```

### UC2: Bóc data hóa đơn → JSON
```bash
curl -X POST /api/v1/documents:process \
  -H "x-api-key: sk-xxx" \
  -F "file=@invoice.pdf" \
  -F 'pipeline=[{"processor":"prebuilt-invoice"}]'

# → result.extracted_data = { invoice_no: "HD-123", total: 15000000 }
```

### UC3: Chain — Extract + Dịch + Tóm tắt
```bash
curl -X POST /api/v1/documents:process \
  -H "x-api-key: sk-xxx" \
  -F "file=@english-report.pdf" \
  -F 'pipeline=[
    {"processor":"prebuilt-layout"},
    {"processor":"prebuilt-translate","variables":{"target_language":"Tiếng Việt"}},
    {"processor":"prebuilt-summarize","variables":{"max_words":300}}
  ]'

# → 1 Operation, 3 bước tuần tự
# → result.content = "Tóm tắt: Báo cáo cho thấy doanh thu tăng 25%..."
# → result.pipeline_steps[0].content = "# Annual Report..." (full MD)
# → result.pipeline_steps[1].content = "# Báo cáo thường niên..." (full dịch)
```

### UC4: So sánh 2 hợp đồng
```bash
curl -X POST /api/v1/documents:process \
  -H "x-api-key: sk-xxx" \
  -F "source_file=@contract_v1.docx" \
  -F "target_file=@contract_v2.docx" \
  -F 'pipeline=[{"processor":"prebuilt-compare"}]'

# → result.extracted_data = { differences: [...], similarity_score: 0.85 }
```

### UC5: Custom B2B — Bệnh viện
```bash
curl -X POST /api/v1/documents:process \
  -H "x-api-key: sk-bachmai-key" \
  -F "file=@benh-an.pdf" \
  -F 'pipeline=[
    {"processor":"prebuilt-layout"},
    {"processor":"custom-bachmai-hoso"}
  ]'

# → result.extracted_data = { patient_name: "Nguyen Van A", symptoms: [...] }
```

---

## 8. ENDPOINT SUMMARY

| #  | Method   | Path                                   | Description                     |
|----|----------|----------------------------------------|---------------------------------|
| 1  | `POST`   | `/api/v1/documents:process`            | ★ Submit pipeline               |
| 2  | `GET`    | `/api/v1/operations`                   | List operations (history)       |
| 3  | `GET`    | `/api/v1/operations/{id}`              | Status + Result (when done)     |
| 4  | `POST`   | `/api/v1/operations/{id}:cancel`       | Cancel running operation        |
| 5  | `DELETE` | `/api/v1/operations/{id}`              | Delete + cleanup files          |
| 6  | `GET`    | `/api/v1/operations/{id}:download`     | Download output files           |
| 7  | `GET`    | `/api/v1/processors`                   | List available processors       |
| 8  | `GET`    | `/api/v1/processors/{id}`              | Processor detail                |
| 9  | `GET`    | `/api/v1/billing/balance`              | Account balance                 |
| 10 | `GET`    | `/api/v1/billing/usage`                | Usage statistics                |

---

## 9. BEST PRACTICES APPLIED

| #  | Practice                                | Source          | How Applied                                       |
|----|-----------------------------------------|-----------------|---------------------------------------------------|
| 1  | Resource-oriented design                | Google AIP-121  | Processors, Operations as resources               |
| 2  | Custom methods `:verb`                  | Google AIP-136  | `:process`, `:cancel`, `:download`                |
| 3  | Long-running operations                 | Google AIP-151  | Unified Operation (status + result in one GET)    |
| 4  | Idempotency keys                        | Google AIP-155  | `Idempotency-Key` header                         |
| 5  | Cursor-based pagination                 | Google AIP-158  | `page_token` / `next_page_token`                  |
| 6  | RFC 9457 error format                   | IETF            | `type`, `title`, `status`, `detail`               |
| 7  | Operation-Location header               | Azure Doc Intel | 202 response + polling URL                        |
| 8  | Processor registry                      | Google + Azure  | `/processors` catalog                             |
| 9  | Feature-level billing                   | AWS Textract    | Per-processor cost in usage breakdown             |
| 10 | Structured outputs via schema           | OpenAI          | `response_schema` in Processor server config      |
| 11 | Pipeline chaining                       | Langchain/Pipes | Multi-step pipeline in single request             |
| 12 | Webhook callback                        | Industry std    | Optional `webhook_url`                            |
| 13 | Soft delete                             | Google AIP-164  | `deletedAt` field                                 |
| 14 | Partial failure recovery                | AWS Step Func   | Pipeline fails mid-chain, completed steps retained|
| 15 | Template variables (no open prompts)    | Security best   | Server-side prompt templates with `{{var}}`       |
