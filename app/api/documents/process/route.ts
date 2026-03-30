// app/api/documents/process/route.ts
// Internal endpoint for frontend UI — NO x-api-key auth required

import { NextRequest, NextResponse } from 'next/server';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { formatOperationResponse } from '@/lib/pipelines/format';
import type { PipelineStep } from '@/lib/pipelines/engine';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

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
      file:           form.get('file') as File | null,
      sourceFile:     form.get('source_file') as File | null,
      targetFile:     form.get('target_file') as File | null,
      outputFormat:   (form.get('output_format') as string) ?? 'md',
      webhookUrl:     form.get('webhook_url') as string | null,
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
    console.error('[API internal documents:process] Error:', msg);
    return NextResponse.json(
      { type: 'https://dugate.vn/errors/internal', title: 'Internal Error', status: 500, detail: msg },
      { status: 500 },
    );
  }
}
