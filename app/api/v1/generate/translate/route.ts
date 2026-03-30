// app/api/v1/generate/translate/route.ts
// POST /api/v1/generate/translate — Recipe: Translate a document
// Shortcut for pipeline: [{ processor: "prebuilt-translate", variables: { target_language, tone } }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/generate/translate:
 *   post:
 *     summary: Translate a document to a target language
 *     description: |
 *       Recipe shortcut for the `prebuilt-translate` processor.
 *       Translates the full document content while preserving all Markdown formatting
 *       (headings, tables, lists, bold, italic, code blocks).
 *       Supported targets include any language the underlying AI model supports
 *       (e.g. "Tiếng Việt", "English", "Japanese", "French", "Chinese Simplified").
 *     tags: [Generate]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, target_language]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Document to translate — PDF or DOCX
 *               target_language:
 *                 type: string
 *                 description: 'Target language for translation (e.g. "Tiếng Việt", "English", "Japanese")'
 *                 example: Tiếng Việt
 *               tone:
 *                 type: string
 *                 enum: [formal, casual, technical]
 *                 default: formal
 *                 description: Translation tone/register
 *               output_format:
 *                 type: string
 *                 enum: [md, html]
 *                 default: md
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Result contains content with the translated document.
 *       400:
 *         description: Missing file or target_language
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const targetLanguage = form.get('target_language') as string | null;
    if (!targetLanguage?.trim()) {
      return NextResponse.json(
        { type: 'https://dugate.vn/errors/missing-parameter', title: 'Missing Parameter', status: 400, detail: 'The "target_language" field is required.' },
        { status: 400 },
      );
    }

    const tone = (form.get('tone') as string) ?? 'formal';
    const validTones = ['formal', 'casual', 'technical'];
    if (!validTones.includes(tone)) {
      return NextResponse.json(
        { type: 'https://dugate.vn/errors/invalid-parameter', title: 'Invalid Parameter', status: 400, detail: `The "tone" must be one of: ${validTones.join(', ')}.` },
        { status: 400 },
      );
    }

    const result = await submitPipelineJob({
      pipeline: [{
        processor: 'prebuilt-translate',
        variables: { target_language: targetLanguage.trim(), tone },
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
    console.error('[POST /api/v1/generate/translate] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
