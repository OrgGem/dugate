// lib/pipelines/workflows/disbursement.ts
// Workflow: Kiểm tra & Giải ngân (Disbursement Check)
//
// DAG:
//   Step 1: N files → classify per file [song song]
//   Step 2: N files → extract per file  [song song]
//   Step 3: aggregate → crosscheck      [tuần tự]
//   Step 4: generate report             [tuần tự]

import {
  type WorkflowContext,
  enqueueSubStep,
  updateProgress,
  completeWorkflow,
} from '@/lib/pipelines/workflow-engine';

import {
  type ClassifyFileResult,
  type ClassifyResult,
  type ExtractResult,
  type CrosscheckResult,
  buildClassifyPrompt,
  parseClassifyResult,
  mergeClassifyResults,
  buildExtractPrompt,
  buildCrosscheckPrompt,
  buildReportPrompt,
} from './prompts/disbursement-prompts';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

/** Progress percentage ranges for each step [start, end] */
const STEP_PROGRESS: Record<number, [number, number]> = {
  0: [5, 25],    // Classify
  1: [30, 55],   // Extract
  2: [60, 80],   // Crosscheck
  3: [85, 95],   // Report
};

function stepProgress(stepIdx: number, phase: 'start' | 'end'): number {
  const range = STEP_PROGRESS[stepIdx];
  if (!range) return 50;
  return phase === 'start' ? range[0] : range[1];
}

// ─── Main Workflow ────────────────────────────────────────────────────────────

export async function runDisbursement(ctx: WorkflowContext): Promise<void> {
  const { logger, filesData, pipelineVars } = ctx;
  const fileCount = filesData.length;

  // ── STEP 1: Parallel Classify (per file) ──────────────────────────────────
  logger.info(`[WORKFLOW] Step 1/${TOTAL_STEPS}: Classify ${fileCount} file(s)`);
  await updateProgress(ctx, stepProgress(0, 'start'), `Bước 1/${TOTAL_STEPS}: Đang phân loại ${fileCount} tài liệu...`);

  const classifyPromises = filesData.map(async (file): Promise<ClassifyResult> => {
    const singleFileJson = JSON.stringify([file]);
    try {
      const result = await enqueueSubStep(ctx, 'ext-classifier', buildClassifyPrompt(file.name, ctx.promptOverrides.classify), singleFileJson);
      const { classifyData, logicalDocs } = parseClassifyResult(result.content, file.name);
      return { fileName: file.name, classifyData, logicalDocs, subOperationId: result.operation.id, status: 'success' };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(`[WORKFLOW] Classify failed for ${file.name}: ${errMsg}`);
      return { fileName: file.name, classifyData: {}, logicalDocs: [], subOperationId: '', status: 'error', error: errMsg };
    }
  });

  const classifyResults = await Promise.all(classifyPromises);
  const successfulClassifies = classifyResults.filter(
    (r): r is ClassifyFileResult => r.status === 'success',
  );

  if (successfulClassifies.length === 0) {
    const errors = classifyResults
      .filter((r): r is Extract<ClassifyResult, { status: 'error' }> => r.status === 'error')
      .map(r => `${r.fileName}: ${r.error}`)
      .join('; ');
    throw new Error(`All ${fileCount} classify jobs failed. Errors: ${errors}`);
  }

  const { allLogicalDocs, mergedClassifyData } = mergeClassifyResults(successfulClassifies);

  ctx.stepsResult.push({
    step: 0,
    stepName: `Phân loại tài liệu (${fileCount} file)`,
    processor: 'ext-classifier',
    content_preview: JSON.stringify(classifyResults.map(r => ({
      file: r.fileName,
      status: r.status,
      docs: r.status === 'success' ? r.logicalDocs.length : 0,
    }))),
    extracted_data: mergedClassifyData,
    sub_results: classifyResults.map(r => ({
      file: r.fileName,
      status: r.status,
      sub_operation_id: r.subOperationId,
      logical_documents: r.status === 'success' ? r.logicalDocs : [],
    })),
  });
  await updateProgress(ctx, stepProgress(0, 'end'), `Bước 1 hoàn tất. ${fileCount} file → ${allLogicalDocs.length} loại tài liệu.`);

  // ── STEP 2: Parallel Extract (per file) ───────────────────────────────────
  logger.info(`[WORKFLOW] Step 2/${TOTAL_STEPS}: Extract ${fileCount} file(s)`);
  await updateProgress(ctx, stepProgress(1, 'start'), `Bước 2/${TOTAL_STEPS}: Đang bóc tách ${fileCount} file...`);

  const extractPromises = filesData.map(async (file): Promise<ExtractResult> => {
    const docsForFile = allLogicalDocs.filter(d => d.source_file === file.name);
    const singleFileJson = JSON.stringify([file]);
    try {
      const result = await enqueueSubStep(ctx, 'ext-data-extractor', buildExtractPrompt(docsForFile, file.name, ctx.promptOverrides.extract), singleFileJson);
      return {
        file_name: file.name,
        logical_docs: docsForFile.map(d => d.label),
        status: 'success',
        sub_operation_id: result.operation.id,
        content: result.content,
        extracted_data: result.extractedData,
      };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(`[WORKFLOW] Extract failed for ${file.name}: ${errMsg}`);
      return { file_name: file.name, logical_docs: docsForFile.map(d => d.label), status: 'error', error: errMsg };
    }
  });

  const extractionResults = await Promise.all(extractPromises);
  const extractSuccess = extractionResults.filter(r => r.status === 'success').length;

  ctx.stepsResult.push({
    step: 1,
    stepName: `OCR & Bóc tách (${fileCount} file)`,
    processor: 'ext-data-extractor',
    content_preview: JSON.stringify(extractionResults.map(r => ({
      file: r.file_name,
      docs: r.logical_docs,
      status: r.status,
    }))),
    extracted_data: extractionResults,
    sub_results: extractionResults,
  });
  await updateProgress(ctx, stepProgress(1, 'end'), `Bước 2 hoàn tất. ${extractSuccess}/${fileCount} file thành công.`);

  // ── STEP 3: Cross-Check ───────────────────────────────────────────────────
  logger.info(`[WORKFLOW] Step 3/${TOTAL_STEPS}: Cross-check`);
  await updateProgress(ctx, stepProgress(2, 'start'), `Bước 3/${TOTAL_STEPS}: Đang đối chiếu...`);

  const referenceData = pipelineVars.resolution_data ? String(pipelineVars.resolution_data) : undefined;
  const step3 = await enqueueSubStep(ctx, 'ext-fact-verifier', buildCrosscheckPrompt(extractionResults, referenceData, ctx.promptOverrides.crosscheck), null);

  let crosscheckData: CrosscheckResult = {};
  if (step3.content) {
    try {
      crosscheckData = JSON.parse(step3.content) as CrosscheckResult;
    } catch (err) {
      logger.warn(`[WORKFLOW] Failed to parse crosscheck result JSON`, undefined, err);
    }
  }

  ctx.stepsResult.push({
    step: 2,
    stepName: 'Đối chiếu Nghị quyết',
    processor: 'ext-fact-verifier',
    sub_operation_id: step3.operation.id,
    content_preview: step3.content?.substring(0, 2000),
    extracted_data: crosscheckData,
  });
  await updateProgress(ctx, stepProgress(2, 'end'), 'Bước 3 hoàn tất.');

  // ── STEP 4: Report ────────────────────────────────────────────────────────
  logger.info(`[WORKFLOW] Step 4/${TOTAL_STEPS}: Generate report`);
  await updateProgress(ctx, stepProgress(3, 'start'), `Bước 4/${TOTAL_STEPS}: Đang soạn Tờ trình...`);

  const step4 = await enqueueSubStep(ctx, 'ext-content-gen', buildReportPrompt(mergedClassifyData, extractionResults, crosscheckData, ctx.promptOverrides.report), null);

  ctx.stepsResult.push({
    step: 3,
    stepName: 'Soạn Tờ trình',
    processor: 'ext-content-gen',
    sub_operation_id: step4.operation.id,
    content_preview: step4.content?.substring(0, 2000),
    extracted_data: null,
  });

  await completeWorkflow(ctx, step4.content, crosscheckData);
}
