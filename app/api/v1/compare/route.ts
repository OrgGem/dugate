// app/api/v1/compare/route.ts
// POST /api/v1/compare — Recipe: Semantic diff between 2 documents
// Shortcut for pipeline: [{ processor: "prebuilt-compare" }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/compare:
 *   post:
 *     summary: Compare two documents semantically
 *     description: |
 *       Recipe shortcut for the `prebuilt-compare` processor.
 *       Performs an AI-powered semantic diff between two PDF or DOCX files.
 *       Returns a structured list of added, removed, and modified sections with significance scores.
 *     tags: [Compare]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [source_file, target_file]
 *             properties:
 *               source_file:
 *                 type: string
 *                 format: binary
 *                 description: Original (baseline) document — PDF or DOCX
 *               target_file:
 *                 type: string
 *                 format: binary
 *                 description: Revised document to compare against the source — PDF or DOCX
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Poll GET /api/v1/operations/{id} for result. Result contains extracted_data with differences array.
 *       400:
 *         description: Missing source_file or target_file
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const result = await submitPipelineJob({
      pipeline:   [{ processor: 'prebuilt-compare' }],
      sourceFile: form.get('source_file') as File | null,
      targetFile: form.get('target_file') as File | null,
      outputFormat: 'json',
      webhookUrl: form.get('webhook_url') as string | null,
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
    console.error('[POST /api/v1/compare] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
