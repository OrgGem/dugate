// app/api/v1/extract/invoice/route.ts
// POST /api/v1/extract/invoice — Recipe: Extract structured data from invoices
// Shortcut for pipeline: [{ processor: "prebuilt-invoice" }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/extract/invoice:
 *   post:
 *     summary: Extract structured data from a VAT invoice
 *     description: |
 *       Recipe shortcut for the `prebuilt-invoice` processor.
 *       Extracts machine-readable fields from a PDF or DOCX invoice:
 *       invoice number, date, seller/buyer info, line items, totals, tax amounts, currency.
 *       Result is returned as `extracted_data` JSON in the operation response.
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
 *                 description: Invoice document — PDF or DOCX
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Result contains extracted_data with invoice fields.
 *       400:
 *         description: Missing file
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const result = await submitPipelineJob({
      pipeline:     [{ processor: 'prebuilt-invoice' }],
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
    console.error('[POST /api/v1/extract/invoice] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
