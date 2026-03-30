// app/api/v1/extract/classify/route.ts
// POST /api/v1/extract/classify — Recipe: Classify document type
// Shortcut for pipeline: [{ processor: "prebuilt-classify", variables: { labels } }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/extract/classify:
 *   post:
 *     summary: Classify a document into a type category
 *     description: |
 *       Recipe shortcut for the `prebuilt-classify` processor.
 *       Automatically identifies the document type (invoice, contract, resume, report, letter, form, regulation, other),
 *       along with confidence score, detected language, estimated page count, and key topics.
 *       Provide custom `labels` to override the default classification taxonomy.
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
 *                 description: Document to classify — PDF or DOCX
 *               labels:
 *                 type: string
 *                 description: 'Optional comma-separated custom classification labels (e.g. "policy,memo,sop,guideline")'
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Result contains extracted_data with document_type, confidence, language, key_topics.
 *       400:
 *         description: Missing file
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const labelsRaw = form.get('labels') as string | null;
    const labels = labelsRaw
      ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    const result = await submitPipelineJob({
      pipeline: [{
        processor: 'prebuilt-classify',
        variables: labels ? { labels } : {},
      }],
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
    console.error('[POST /api/v1/extract/classify] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
