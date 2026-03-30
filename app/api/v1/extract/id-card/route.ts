// app/api/v1/extract/id-card/route.ts
// POST /api/v1/extract/id-card — Recipe: Extract data from Vietnamese ID cards
// Shortcut for pipeline: [{ processor: "prebuilt-id-card" }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/extract/id-card:
 *   post:
 *     summary: Extract structured data from a Vietnamese ID card (CCCD/CMND)
 *     description: |
 *       Recipe shortcut for the `prebuilt-id-card` processor.
 *       Extracts machine-readable fields from a scanned Vietnamese National ID card (Căn cước công dân / Chứng minh nhân dân):
 *       full name, date of birth, gender, ID number, place of origin, place of residence, expiry date.
 *       Accepts PDF, DOCX, JPEG, or PNG inputs.
 *     tags: [Extract]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: ID card scan — PDF, DOCX, JPEG, or PNG
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Result contains extracted_data with ID card fields.
 *       400:
 *         description: Missing file
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const result = await submitPipelineJob({
      pipeline:     [{ processor: 'prebuilt-id-card' }],
      file:         form.get('file') as File | null,
      outputFormat: 'json',
      webhookUrl:   form.get('webhook_url') as string | null,
      idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
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
    console.error('[POST /api/v1/extract/id-card] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
