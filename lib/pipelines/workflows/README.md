# Hướng dẫn: Tạo Workflow mới

## Tổng quan

Workflow là luồng xử lý tài liệu phức tạp, hỗ trợ:
- **Tuần tự**: `await enqueueSubStep(...)` — chờ xong mới tiếp
- **Song song**: `Promise.all(items.map(...))` — N jobs BullMQ đồng thời
- **Truyền context**: output bước trước làm input bước sau
- **Realtime**: UI poll `GET /operations/{id}` thấy tiến trình từng bước

Mỗi sub-step là 1 BullMQ job riêng (hiện trong Dashboard), gọi tới connector thật qua mock-service hoặc AI provider.

---

## Cấu trúc thư mục

```
lib/pipelines/
├── workflow-engine.ts              ← Shared infrastructure (KHÔNG SỬA)
│   ├── WorkflowContext             (type — dữ liệu xuyên suốt workflow)
│   ├── enqueueSubStep()            (tạo BullMQ job, chờ kết quả)
│   ├── updateProgress()            (cập nhật % + message cho UI poll)
│   ├── completeWorkflow()          (đánh dấu hoàn tất)
│   ├── failWorkflow()              (đánh dấu lỗi)
│   └── WORKFLOW_REGISTRY           (map tên → hàm xử lý)
│
└── workflows/
    ├── disbursement.ts             ← Ví dụ mẫu (Giải ngân)
    └── <ten-workflow-moi>.ts       ← File bạn sẽ tạo
```

---

## Các bước tạo Workflow mới

### Bước 1: Tạo file workflow

Tạo file `lib/pipelines/workflows/<ten-workflow>.ts`:

```typescript
// lib/pipelines/workflows/appraisal.ts
// Workflow: Thẩm định tài sản

import {
  type WorkflowContext,
  enqueueSubStep,
  updateProgress,
  completeWorkflow,
} from '@/lib/pipelines/workflow-engine';

export async function runAppraisal(ctx: WorkflowContext): Promise<void> {
  const { logger, filesJson, pipelineVars } = ctx;

  // ── STEP 1 ──────────────────────────────────────────────
  logger.info('[WORKFLOW] Step 1: ...');
  await updateProgress(ctx, 10, 'Bước 1: Đang xử lý...');

  const step1 = await enqueueSubStep(
    ctx,
    'ext-classifier',       // slug connector trong DB
    { ...pipelineVars },    // variables truyền vào prompt
    filesJson,              // files gốc (null nếu không cần)
  );

  // Parse kết quả
  let data: any = {};
  try { data = JSON.parse(step1.content || '{}'); } catch {}

  // Lưu vào stepsResult (UI sẽ hiện)
  ctx.stepsResult.push({
    step: 0,
    stepName: 'Tên bước hiển thị trên UI',
    processor: 'ext-classifier',
    sub_operation_id: step1.operation.id,
    content_preview: step1.content?.substring(0, 2000),
    extracted_data: data,
  });
  await updateProgress(ctx, 50, 'Bước 1 hoàn tất.');

  // ── STEP 2 (song song) ─────────────────────────────────
  const items = ['a', 'b', 'c'];
  await updateProgress(ctx, 55, `Bước 2: Xử lý ${items.length} items...`);

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const r = await enqueueSubStep(ctx, 'ext-data-extractor', { item }, filesJson);
        return { item, status: 'success', content: r.content };
      } catch (e: any) {
        return { item, status: 'error', error: e.message };
      }
    })
  );

  ctx.stepsResult.push({
    step: 1,
    stepName: 'Xử lý song song',
    processor: 'ext-data-extractor',
    extracted_data: results,
    sub_results: results,
  });
  await updateProgress(ctx, 90, 'Bước 2 hoàn tất.');

  // ── DONE ────────────────────────────────────────────────
  await completeWorkflow(ctx, 'Kết quả cuối cùng', data);
}
```

### Bước 2: Đăng ký vào Registry

Mở `lib/pipelines/workflow-engine.ts`, thêm vào cuối file:

```typescript
import { runAppraisal } from '@/lib/pipelines/workflows/appraisal';

const WORKFLOW_REGISTRY: Record<string, (ctx: WorkflowContext) => Promise<void>> = {
  disbursement: runDisbursement,
  appraisal: runAppraisal,       // ← THÊM DÒNG NÀY
};
```

### Bước 3: Đăng ký endpoint trong Registry

Mở `lib/endpoints/registry.ts`, thêm subCase mới trong group `workflows`:

```typescript
workflows: {
  subCases: {
    disbursement: { ... },
    appraisal: {                 // ← THÊM BLOCK NÀY
      label: 'Thẩm định tài sản',
      description: 'Workflow thẩm định giá trị tài sản đảm bảo',
      parameters: {
        asset_type: { type: 'string', required: false },
      },
    },
  },
},
```

### Bước 4: Rebuild & Test

```bash
# Rebuild Docker worker (bắt buộc)
docker-compose build worker
docker-compose up -d worker

# Test qua API
curl -X POST http://localhost:2023/api/v1/workflows \
  -H "x-api-key: sk-admin-default-secret-key" \
  -F "process=appraisal" \
  -F "files[]=@document.pdf"

# Poll kết quả
curl http://localhost:2023/api/v1/operations/{id}
```

---

## API Reference nhanh

### `enqueueSubStep(ctx, processorSlug, variables, filesJson)`

| Tham số | Ý nghĩa |
|---------|---------|
| `ctx` | WorkflowContext (nhận từ tham số hàm) |
| `processorSlug` | Slug connector trong DB: `ext-classifier`, `ext-data-extractor`, `ext-fact-verifier`, `ext-content-gen`, ... |
| `variables` | Object truyền vào prompt template: `{{ key }}` sẽ được thay bằng `value` |
| `filesJson` | JSON string mảng files (`ctx.filesJson`), hoặc `null` nếu step không cần file |

**Trả về**: `{ operation, content, extractedData }`

### `updateProgress(ctx, percent, message)`

Cập nhật `progressPercent` + `progressMessage` trên parent Operation.
UI poll `GET /operations/{id}` sẽ nhận được giá trị mới.

### `completeWorkflow(ctx, outputContent, extractedData)`

Đánh dấu workflow SUCCEEDED. `outputContent` là kết quả cuối (thường là Markdown/text).

---

## Connectors có sẵn

| Slug | Chức năng | Khi nào dùng |
|------|-----------|-------------|
| `ext-classifier` | Phân loại tài liệu | Bước đầu — xác định loại file |
| `ext-data-extractor` | Bóc tách dữ liệu có cấu trúc | Trích key-value từ hóa đơn, HĐ, ... |
| `ext-fact-verifier` | Đối chiếu dữ liệu | So sánh với reference/NQ |
| `ext-content-gen` | Sinh nội dung | Tạo báo cáo, tờ trình, tóm tắt |
| `ext-doc-layout` | Parse PDF → Markdown | OCR, chuyển đổi định dạng |
| `ext-compliance` | Kiểm tra tuân thủ | Đánh giá theo tiêu chuẩn |
| `ext-quality-eval` | Đánh giá chất lượng & rủi ro | Chấm điểm tài liệu |
| `ext-comparator` | So sánh tài liệu | Diff 2+ files |

> Xem đầy đủ trong `prisma/seed.ts` mảng `CONNECTORS`.

---

## Lưu ý quan trọng

1. **Worker concurrency** phải >= 2 (mặc định đang là 5). Workflow chiếm 1 slot, các sub-steps chiếm thêm.
2. **Mỗi `enqueueSubStep`** tạo 1 child Operation (soft-deleted, ẩn khỏi history) + 1 BullMQ job.
3. **Timeout** mỗi sub-step: 120s. Sửa trong `workflow-engine.ts` nếu cần.
4. **Error handling**: Nếu `enqueueSubStep` throw → `failWorkflow` được gọi tự động bởi router. Nếu muốn bỏ qua lỗi 1 item (ví dụ trong `Promise.all`), wrap bằng `try/catch` và return error object.
5. **Sau khi sửa code**: phải `docker-compose build worker && docker-compose up -d worker` vì Worker chạy trong Docker.
