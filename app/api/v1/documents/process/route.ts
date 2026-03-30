// app/api/v1/documents/process/route.ts
// ★ Core endpoint: POST /api/v1/documents/process
// Public API — requires x-api-key auth (handled by middleware)
// Business logic delegated to lib/pipelines/submit.ts

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';
import type { PipelineStep } from '@/lib/pipelines/engine';

/**
 * @swagger
 * /api/v1/documents/process:
 *   post:
 *     summary: Giao việc cho Pipeline (Submit Document)
 *     description: |
 *       Endpoint chính của hệ thống. Định nghĩa đầu vào của tài liệu và cấu trúc tuần tự các bước cấu hình AI xử lý (pipeline).
 *       Mọi luồng xử lý đều diễn ra bất đồng bộ (AIP-151 Long Running Operations). 
 *
 *       Quy trình tích hợp:
 *       1. Giao task tại endpoint này -> Nhận `id` Operation dạng `op_...`.
 *       2. Thực hiện Polling gọi `GET /api/v1/operations/{id}` định kỳ (2-5 giây/lần) để lấy trạng thái xử lý.
 *       3. Nếu cần lấy file hoàn chỉnh, gọi `GET /api/v1/operations/{id}/download`.
 *
 *       **Lưu ý quan trọng**:
 *       Khuyến khích truyền thêm Header `Idempotency-Key` với giá trị UUID duy nhất theo từng request để đảm bảo an toàn,
 *       không bị tính phí dịch vụ kép nếu mạng chập chờn buộc client phải gọi lại request.
 *
 *       > **Tip**: Với các Use Case thông thường (như so sánh tài liệu, fact-check, bóc hóa đơn), hãy dùng các
 *       Recipe Endpoints rút gọn (ví dụ `/extract/invoice`, `/compare`, `/fact-check`) thay vì phải ráp nối `pipeline` JSON.
 *     tags: [Documents]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema:
 *           type: string
 *           format: uuid
 *         required: false
 *         description: Khóa chống lặp request do client tự sinh (VD UUID v4) nhằm tránh request xử lý trùng lắp.
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [pipeline]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Tệp tin tài liệu chính cần xử lý (Hỗ trợ PDF, DOCX, JPG, PNG).
 *               source_file:
 *                 type: string
 *                 format: binary
 *                 description: Tệp gốc (Dành riêng cho việc so sánh 2 văn bản hoặc fact-checking rẽ nhánh).
 *               target_file:
 *                 type: string
 *                 format: binary
 *                 description: Tệp mục tiêu (Trích xuất các khác biệt khi so sánh).
 *               pipeline:
 *                 type: string
 *                 description: |
 *                   Mảng biểu thị các khối Processor sẽ chạy dạng chuỗi Stringified JSON. (Tối đa 5 bước).
 *                   Ví dụ dịch thuật: `[{"processor":"prebuilt-layout"},{"processor":"prebuilt-translate","variables":{"target_language":"Tiếng Việt"}}]`
 *               output_format:
 *                 type: string
 *                 enum: [md, html, json]
 *                 default: md
 *                 description: Định dạng nội dung trả về trong operation kết quả (`result.content`).
 *               webhook_url:
 *                 type: string
 *                 description: URL hệ thống ngoài (Webhook) để tự động gọi lại sau khi có kết quả hoàn tất thay cho cơ chế Polling.
 *     responses:
 *       202:
 *         description: |
 *           Operation đã được tạo và pipeline bắt đầu chạy nén. Bắt đầu polling ID này.
 *           Nếu header Idempotency-Key trùng với tác vụ đã chạy xong, HTTP Status trả về 200 thay vì 202.
 *       400:
 *         description: Request không hợp lệ (Missing Params, Invalid Schema).
 *       404:
 *         description: Processor khai báo trong mảng pipeline không tồn tại.
 *       422:
 *         description: Lỗi tính logic đường ống (VD step liên kết không hợp lệ, dữ liệu input không đúng định dạng).
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    // Parse pipeline JSON — only needed for raw endpoint
    const pipelineStr = form.get('pipeline') as string;
    if (!pipelineStr) {
      return NextResponse.json(
        { type: 'https://dugate.vn/errors/missing-pipeline', title: 'Missing Pipeline', status: 400, detail: 'The "pipeline" field is required.' },
        { status: 400 },
      );
    }

    let pipeline: PipelineStep[];
    try {
      pipeline = JSON.parse(pipelineStr);
    } catch {
      return NextResponse.json(
        { type: 'https://dugate.vn/errors/invalid-pipeline', title: 'Invalid Pipeline JSON', status: 400, detail: 'The "pipeline" field must be a valid JSON array.' },
        { status: 400 },
      );
    }

    const result = await submitPipelineJob({
      pipeline,
      file:             form.get('file') as File | null,
      sourceFile:       form.get('source_file') as File | null,
      targetFile:       form.get('target_file') as File | null,
      outputFormat:     (form.get('output_format') as string) ?? 'md',
      webhookUrl:       form.get('webhook_url') as string | null,
      idempotencyKey:   req.headers.get('idempotency-key') ?? undefined,
    });

    if (!result.ok) return result.errorResponse;

    return NextResponse.json(formatOperationResponse(result.operation), {
      status: result.isIdempotent ? 200 : 202,
      headers: result.isIdempotent
        ? {}
        : { 'Operation-Location': `/api/v1/operations/${result.operation.id}` },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[API documents:process] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}

