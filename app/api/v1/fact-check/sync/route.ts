// app/api/v1/fact-check/sync/route.ts
// POST /api/v1/fact-check/sync — Synchronous variant of the fact-check endpoint.
//
// Unlike POST /api/v1/fact-check (async, returns 202 + polling),
// this endpoint BLOCKS until the pipeline completes and returns the full result directly.
//
// Best suited for:
//   - Small/medium documents where the check completes in < 120s
//   - Clients that cannot implement polling (simple scripts, low-code tools)
//   - Server-to-server integrations that need immediate verdict
//
// Default timeout: 120 seconds. Adjust MAX_WAIT_MS for longer documents.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { submitPipelineJob } from '@/lib/pipelines/submit';

// Allow up to 5 minutes on self-hosted deployments (ignored on Vercel hobby/pro)
export const maxDuration = 300;

const MAX_WAIT_MS  = 120_000; // 120 seconds default timeout
const POLL_INTERVAL = 800;    // poll DB every 800ms

/**
 * @swagger
 * /api/v1/fact-check/sync:
 *   post:
 *     summary: Fact-check document synchronously (blocks until result)
 *     description: |
 *       **Synchronous** variant of `POST /api/v1/fact-check`.
 *
 *       This endpoint submits a fact-check pipeline and **waits** for the result to be ready,
 *       then returns the complete verdict report in a single response — no polling required.
 *
 *       ---
 *
 *       **When to use this vs the async endpoint:**
 *       | Scenario | Use |
 *       |---|---|
 *       | Small document, need result immediately | `/fact-check/sync` ✅ |
 *       | Large document (> 30s processing) | `/fact-check` async + polling ✅ |
 *       | Client cannot implement polling | `/fact-check/sync` ✅ |
 *       | Webhook integration | `/fact-check` async + `webhook_url` ✅ |
 *
 *       ---
 *
 *       **Timeout:** 120 seconds by default.
 *       Returns `408 Request Timeout` if the pipeline does not complete in time.
 *       The background pipeline continues running — you can still retrieve the result later
 *       via `GET /api/v1/operations/{operation_id}`.
 *
 *       ---
 *
 *       **Response shape on success:**
 *       ```json
 *       {
 *         "operation_id": "uuid",
 *         "verdict": "PASS | FAIL | WARNING | INCONCLUSIVE",
 *         "score": 92,
 *         "summary": "2-3 sentence assessment",
 *         "checks": [
 *           {
 *             "rule": "VAT rate must be 10%",
 *             "status": "PASS | FAIL | WARNING | NOT_APPLICABLE",
 *             "document_value": "10%",
 *             "reference_value": "10%",
 *             "explanation": "VAT rate matches exactly"
 *           }
 *         ],
 *         "discrepancies": [],
 *         "timing_ms": 4200,
 *         "usage": { "input_tokens": 1280, "output_tokens": 312, "cost_usd": 0.0014 }
 *       }
 *       ```
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
 *                   Accepts plain text or a JSON string (e.g. structured record, purchase order).
 *                   Example: `{"supplier":"ABC Corp","total":15000000,"vat_rate":"10%"}`
 *               check_prompt:
 *                 type: string
 *                 description: |
 *                   Business rules or criteria to verify. Be specific about what to check and
 *                   how to interpret discrepancies.
 *                   Example: `"1) Invoice total must match PO total exactly. 2) VAT must be 10%. 3) Delivery within 30 days."`
 *               timeout_seconds:
 *                 type: integer
 *                 default: 120
 *                 minimum: 10
 *                 maximum: 300
 *                 description: How long to wait for the result before returning 408 Timeout
 *     responses:
 *       200:
 *         description: Fact-check completed. Returns full verdict report.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 operation_id:
 *                   type: string
 *                   description: Operation ID — can be used to retrieve result again later
 *                 verdict:
 *                   type: string
 *                   enum: [PASS, FAIL, WARNING, INCONCLUSIVE]
 *                 score:
 *                   type: integer
 *                   minimum: 0
 *                   maximum: 100
 *                   description: Overall compliance score (0 = fully non-compliant, 100 = fully compliant)
 *                 summary:
 *                   type: string
 *                 checks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       rule: { type: string }
 *                       status:
 *                         type: string
 *                         enum: [PASS, FAIL, WARNING, NOT_APPLICABLE]
 *                       document_value: { type: string }
 *                       reference_value: { type: string }
 *                       explanation: { type: string }
 *                 discrepancies:
 *                   type: array
 *                   items:
 *                     type: string
 *                 timing_ms:
 *                   type: integer
 *                   description: Total time from submit to result, in milliseconds
 *                 usage:
 *                   type: object
 *                   properties:
 *                     input_tokens: { type: integer }
 *                     output_tokens: { type: integer }
 *                     cost_usd: { type: number }
 *       400:
 *         description: Missing required fields (file, reference_text, check_prompt)
 *       408:
 *         description: Timeout — pipeline did not complete within the specified timeout. The background pipeline continues; use operation_id to retrieve the result later.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type: { type: string }
 *                 title: { type: string }
 *                 status: { type: integer }
 *                 detail: { type: string }
 *                 operation_id:
 *                   type: string
 *                   description: Use this ID to poll GET /api/v1/operations/{operation_id}
 *       422:
 *         description: Pipeline failed during processing
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();

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
          detail: 'The "reference_text" field is required.',
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
          detail: 'The "check_prompt" field is required.',
        },
        { status: 400 },
      );
    }

    // Optional timeout override (10–300s)
    const timeoutRaw = form.get('timeout_seconds') as string | null;
    const timeoutMs = timeoutRaw
      ? Math.min(300_000, Math.max(10_000, parseInt(timeoutRaw) * 1000))
      : MAX_WAIT_MS;

    // ── Submit async pipeline (same as /fact-check) ─────────────────────────
    const submitResult = await submitPipelineJob({
      pipeline: [{
        processor: 'prebuilt-fact-check',
        variables: {
          reference_text: referenceText.trim(),
          check_prompt:   checkPrompt.trim(),
        },
      }],
      file:         form.get('file') as File | null,
      outputFormat: 'json',
      webhookUrl:   null,   // sync — no webhook needed
      idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
    });

    if (!submitResult.ok) return submitResult.errorResponse;

    const operationId = submitResult.operation.id;

    // ── If idempotency hit and already done — return immediately ────────────
    if (submitResult.isIdempotent && submitResult.operation.done) {
      return buildSyncResponse(submitResult.operation, startedAt, operationId);
    }

    // ── Poll until done or timeout ───────────────────────────────────────────
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);

      const op = await prisma.operation.findUnique({
        where: { id: operationId },
      });

      if (!op) break; // Unexpected: operation disappeared

      if (op.done) {
        return buildSyncResponse(op, startedAt, operationId);
      }
    }

    // ── Timeout ──────────────────────────────────────────────────────────────
    return NextResponse.json(
      {
        type: 'https://dugate.vn/errors/timeout',
        title: 'Request Timeout',
        status: 408,
        detail: `Fact-check did not complete within ${timeoutMs / 1000}s. The pipeline is still running. Use the operation_id to retrieve the result when ready.`,
        operation_id: operationId,
        poll_url: `/api/v1/operations/${operationId}`,
      },
      { status: 408 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[POST /api/v1/fact-check/sync] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildSyncResponse(op: any, startedAt: number, operationId: string): NextResponse {
  const timingMs = Date.now() - startedAt;

  // Pipeline failed
  if (op.state === 'FAILED' || op.state === 'CANCELLED') {
    return NextResponse.json(
      {
        type: 'https://dugate.vn/errors/pipeline-failed',
        title: 'Pipeline Failed',
        status: 422,
        detail: op.errorMessage ?? 'The fact-check pipeline failed.',
        operation_id: operationId,
        error: {
          code: op.errorCode ?? 'PIPELINE_FAILED',
          message: op.errorMessage,
          failed_at_step: op.failedAtStep,
        },
        timing_ms: timingMs,
      },
      { status: 422 },
    );
  }

  // SUCCEEDED — extract structured fact-check result
  let extractedData: any = null;
  try {
    if (op.extractedData) {
      extractedData = JSON.parse(op.extractedData);
    } else if (op.outputContent) {
      // Fallback: try to parse outputContent if extractedData is missing
      extractedData = JSON.parse(op.outputContent);
    }
  } catch {
    // Not valid JSON — return raw content
  }

  return NextResponse.json(
    {
      operation_id:  operationId,
      verdict:       extractedData?.verdict       ?? 'INCONCLUSIVE',
      score:         extractedData?.score         ?? 0,
      summary:       extractedData?.summary       ?? '',
      checks:        extractedData?.checks        ?? [],
      discrepancies: extractedData?.discrepancies ?? [],
      timing_ms:     timingMs,
      usage: {
        input_tokens:  op.totalInputTokens  ?? 0,
        output_tokens: op.totalOutputTokens ?? 0,
        cost_usd:      op.totalCostUsd      ?? 0,
      },
    },
    {
      status: 200,
      headers: {
        // Handy for clients that want to retrieve later
        'X-Operation-Id': operationId,
      },
    },
  );
}
