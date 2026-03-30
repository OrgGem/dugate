// lib/pipelines/submit.ts
// Shared core logic for submitting pipeline jobs.
// Used by both /api/v1/documents/process (raw) and all Recipe endpoints.
// Recipe endpoints build the pipeline internally; the raw endpoint parses it from the client.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { runPipeline, type PipelineStep } from '@/lib/pipelines/engine';
import { saveUploadedFile } from '@/lib/upload-helper';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SubmitPipelineParams {
  pipeline: PipelineStep[];
  file?: File | null;
  sourceFile?: File | null;
  targetFile?: File | null;
  outputFormat?: string;           // "md" | "html" | "json" — default "md"
  webhookUrl?: string | null;
  idempotencyKey?: string;
}

export type SubmitPipelineResult =
  | { ok: false; errorResponse: NextResponse }
  | { ok: true; operation: any; isIdempotent: boolean };

// ─── Core submit function ─────────────────────────────────────────────────────

export async function submitPipelineJob(
  params: SubmitPipelineParams,
): Promise<SubmitPipelineResult> {
  const {
    pipeline,
    file,
    sourceFile,
    targetFile,
    outputFormat = 'md',
    webhookUrl,
    idempotencyKey,
  } = params;

  // ── 1. Basic pipeline validation ─────────────────────────────────────────
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { type: 'https://dugate.vn/errors/empty-pipeline', title: 'Empty Pipeline', status: 400, detail: 'Pipeline must have at least 1 step.' },
        { status: 400 },
      ),
    };
  }

  if (pipeline.length > 5) {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { type: 'https://dugate.vn/errors/pipeline-too-long', title: 'Pipeline Too Long', status: 422, detail: `Pipeline has ${pipeline.length} steps. Maximum is 5.` },
        { status: 422 },
      ),
    };
  }

  // ── 2. Validate each processor in DB ─────────────────────────────────────
  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i];
    const proc = await prisma.processor.findUnique({ where: { slug: step.processor } });

    if (!proc) {
      return {
        ok: false,
        errorResponse: NextResponse.json(
          { type: 'https://dugate.vn/errors/invalid-processor', title: 'Processor Not Found', status: 404, detail: `Processor '${step.processor}' in step ${i} does not exist.` },
          { status: 404 },
        ),
      };
    }

    if (proc.state !== 'ENABLED') {
      return {
        ok: false,
        errorResponse: NextResponse.json(
          { type: 'https://dugate.vn/errors/processor-disabled', title: 'Processor Disabled', status: 422, detail: `Processor '${step.processor}' is currently disabled.` },
          { status: 422 },
        ),
      };
    }

    if (i === 0 && !proc.canBeFirstStep) {
      return {
        ok: false,
        errorResponse: NextResponse.json(
          { type: 'https://dugate.vn/errors/invalid-chain', title: 'Invalid Pipeline Chain', status: 422, detail: `Processor '${step.processor}' cannot be used as first step.` },
          { status: 422 },
        ),
      };
    }

    if (i > 0 && !proc.canBeChainStep) {
      return {
        ok: false,
        errorResponse: NextResponse.json(
          { type: 'https://dugate.vn/errors/invalid-chain', title: 'Invalid Pipeline Chain', status: 422, detail: `Processor '${step.processor}' cannot be used as a chain step (step ${i}).` },
          { status: 422 },
        ),
      };
    }
  }

  // ── 3. Idempotency check ──────────────────────────────────────────────────
  if (idempotencyKey) {
    const existing = await prisma.operation.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return { ok: true, operation: existing, isIdempotent: true };
    }
  }

  // ── 4. File requirement check ─────────────────────────────────────────────
  const isCompare = pipeline.some(s => s.processor === 'prebuilt-compare');

  if (isCompare) {
    if (!sourceFile || !targetFile) {
      return {
        ok: false,
        errorResponse: NextResponse.json(
          { type: 'https://dugate.vn/errors/missing-files', title: 'Missing Files', status: 400, detail: 'Compare processor requires source_file and target_file.' },
          { status: 400 },
        ),
      };
    }
  } else if (!file) {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { type: 'https://dugate.vn/errors/missing-file', title: 'Missing File', status: 400, detail: 'A file is required for this pipeline.' },
        { status: 400 },
      ),
    };
  }

  // ── 5. Save uploaded files to disk ───────────────────────────────────────
  const operationId = crypto.randomUUID();

  let inputPath: string | undefined;
  let fileName: string | undefined;
  let fileMime: string | undefined;
  let fileSize = 0;
  let sourceFilePath: string | undefined;
  let targetFilePath: string | undefined;
  let sourceFileName: string | undefined;
  let targetFileName: string | undefined;

  if (file) {
    const saved = await saveUploadedFile(file, operationId);
    inputPath = saved.path;
    fileName  = file.name;
    fileMime  = file.type;
    fileSize  = file.size;
  }
  if (sourceFile) {
    const saved = await saveUploadedFile(sourceFile, operationId, 'source');
    sourceFilePath = saved.path;
    sourceFileName = sourceFile.name;
  }
  if (targetFile) {
    const saved = await saveUploadedFile(targetFile, operationId, 'target');
    targetFilePath = saved.path;
    targetFileName = targetFile.name;
  }

  // ── 6. Create Operation in DB ─────────────────────────────────────────────
  const operation = await prisma.operation.create({
    data: {
      id:             operationId,
      apiKeyId:       null,
      idempotencyKey: idempotencyKey ?? null,
      pipelineJson:   JSON.stringify(pipeline),
      fileName,
      fileMime,
      fileSize,
      inputPath,
      sourceFilePath,
      targetFilePath,
      sourceFileName,
      targetFileName,
      outputFormat,
      webhookUrl:     webhookUrl ?? null,
      state:          'RUNNING',
      done:           false,
      progressPercent:  0,
      progressMessage: 'Initializing pipeline...',
    },
  });

  // ── 7. Fire-and-forget ────────────────────────────────────────────────────
  runPipeline(operationId).catch(err => {
    console.error(`[submitPipelineJob] Pipeline error for ${operationId}:`, err);
  });

  return { ok: true, operation, isIdempotent: false };
}
