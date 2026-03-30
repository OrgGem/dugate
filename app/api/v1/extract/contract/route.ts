// app/api/v1/extract/contract/route.ts
// POST /api/v1/extract/contract — Recipe: Extract clauses from legal contracts
// Shortcut for pipeline: [{ processor: "prebuilt-contract", variables: { clauses_focus } }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/extract/contract:
 *   post:
 *     summary: Extract structured clauses and parties from a legal contract
 *     description: |
 *       Recipe shortcut for the `prebuilt-contract` processor.
 *       Extracts: contracting parties, effective date, expiry date, key clauses with summaries,
 *       penalty terms, and total contract value.
 *       Use `clauses_focus` to narrow extraction to specific articles (e.g. "Điều 3,Điều 5").
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
 *                 description: Legal contract document — PDF or DOCX
 *               clauses_focus:
 *                 type: string
 *                 description: Optional comma-separated list of specific clauses to focus on (e.g. "Điều 3,Điều 5,Khoản 2.1")
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: Operation created. Result contains extracted_data with contract structure.
 *       400:
 *         description: Missing file
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    const clausesFocusRaw = form.get('clauses_focus') as string | null;
    const clausesFocus = clausesFocusRaw
      ? clausesFocusRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    const result = await submitPipelineJob({
      pipeline: [{
        processor: 'prebuilt-contract',
        variables: clausesFocus ? { clauses_focus: clausesFocus } : {},
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
    console.error('[POST /api/v1/extract/contract] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
