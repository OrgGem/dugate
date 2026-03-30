// app/api/v1/fact-check/route.ts
// POST /api/v1/fact-check — Recipe: Fact-check & cross-reference document content
// Maps to pipeline: [{ processor: "prebuilt-fact-check", variables: { reference_text, check_prompt } }]

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';

/**
 * @swagger
 * /api/v1/fact-check:
 *   post:
 *     summary: Fact-check and cross-reference document against reference data
 *     description: |
 *       Recipe shortcut for the `prebuilt-fact-check` processor.
 *       Verifies and cross-references content in a document (PDF/DOCX) against
 *       a provided reference dataset (text or JSON) following custom business rules.
 *
 *       **Returns a structured JSON report with:**
 *       - Overall verdict: `PASS | FAIL | WARNING | INCONCLUSIVE`
 *       - Compliance score (0-100)
 *       - Per-rule check results with `PASS | FAIL | WARNING | NOT_APPLICABLE` status
 *       - Document value vs. reference value comparison for each rule
 *       - List of all discrepancies found
 *
 *       **Use cases:**
 *       - Verify invoice amounts match purchase orders
 *       - Check contract terms against standard clause library
 *       - Validate KYC documents against customer records
 *       - Confirm report figures match source data
 *       - Compliance audit against regulatory requirements
 *     tags: [Analyze]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, reference_text, check_prompt]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Document to fact-check — PDF or DOCX
 *               reference_text:
 *                 type: string
 *                 description: |
 *                   Reference data to compare the document against.
 *                   Accepts plain text or a JSON object (as string).
 *                   Examples: customer record JSON, purchase order text, regulation excerpt.
 *               check_prompt:
 *                 type: string
 *                 description: |
 *                   Business rules or specific criteria to check.
 *                   Describe WHAT to verify and HOW to interpret discrepancies.
 *                   Example: "Check that: 1) Invoice total matches PO amount exactly,
 *                   2) VAT rate is 10%, 3) Delivery date is within 30 days of invoice date."
 *               webhook_url:
 *                 type: string
 *                 description: Optional URL for async completion notification
 *     responses:
 *       202:
 *         description: |
 *           Operation created. Poll GET /api/v1/operations/{id} for result.
 *           When done, result.extracted_data contains the full check report.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name: { type: string }
 *                 done: { type: boolean }
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     state: { type: string, enum: [RUNNING, SUCCEEDED, FAILED, CANCELLED] }
 *                     progress_percent: { type: integer }
 *       400:
 *         description: Missing required fields (file, reference_text, or check_prompt)
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    // ── Validate required fields ────────────────────────────────────────────
    const referenceText = form.get('reference_text') as string | null;
    if (!referenceText?.trim()) {
      return NextResponse.json(
        {
          type: 'https://dugate.vn/errors/missing-parameter',
          title: 'Missing Parameter',
          status: 400,
          detail: 'The "reference_text" field is required. Provide the reference data (text or JSON string) to compare the document against.',
        },
        { status: 400 },
      );
    }

    const checkPrompt = form.get('check_prompt') as string | null;
    if (!checkPrompt?.trim()) {
      return NextResponse.json(
        {
          type: 'https://dugate.vn/errors/missing-parameter',
          title: 'Missing Parameter',
          status: 400,
          detail: 'The "check_prompt" field is required. Describe the business rules or criteria to verify.',
        },
        { status: 400 },
      );
    }

    // ── Submit pipeline ─────────────────────────────────────────────────────
    const result = await submitPipelineJob({
      pipeline: [{
        processor: 'prebuilt-fact-check',
        variables: {
          reference_text: referenceText.trim(),
          check_prompt:   checkPrompt.trim(),
        },
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
    console.error('[POST /api/v1/fact-check] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
