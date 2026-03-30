// app/api/v1/generate/summary/route.ts
// POST /api/v1/generate/summary — Recipe: Summarize a document
// Shortcut for pipeline: [{ processor: "prebuilt-summarize", variables: { max_words } }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/generate/summary:
 *   post:
 *     summary: Generate a concise summary of a document
 *     description: |
 *       Recipe shortcut for the `prebuilt-summarize` processor.
 *       Produces a clear, professional summary of the document content, preserving key facts and figures.
 *       Control output length with `max_words` (default: 500 words).
 *     tags: [Generate]
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
 *                 description: Document to summarize — PDF or DOCX
 *               max_words:
 *                 type: integer
 *                 default: 500
 *                 description: Maximum word count for the summary
 *               output_format:
 *                 type: string
 *                 enum: [md, html]
 *                 default: md
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Result contains content with the summary text.
 *       400:
 *         description: Missing file
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const maxWordsRaw = form.get('max_words') as string | null;
    const maxWords = maxWordsRaw ? parseInt(maxWordsRaw, 10) || 500 : 500;

    const result = await submitPipelineJob({
      pipeline: [{
        processor: 'prebuilt-summarize',
        variables: { max_words: maxWords },
      }],
      file:         form.get('file') as File | null,
      outputFormat: (form.get('output_format') as string) ?? 'md',
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
    console.error('[POST /api/v1/generate/summary] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
