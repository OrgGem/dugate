// lib/pipelines/engine.ts
// Core Pipeline Engine — runs a chain of processors sequentially

import { prisma } from '@/lib/prisma';
import { runLayoutProcessor } from '@/lib/pipelines/processors/layout';
import { runCompareProcessor } from '@/lib/pipelines/processors/compare';
import { runLLMProcessor } from '@/lib/pipelines/processors/llm';

export interface PipelineStep {
  processor: string;
  variables?: Record<string, unknown>;
}

export interface ProcessorContext {
  operationId: string;
  stepIndex: number;
  totalSteps: number;
  // Input
  inputFilePath?: string;         // Binary file (first step only)
  inputText?: string;             // Text from previous step (chain steps)
  sourceFilePath?: string;        // Compare: file 1
  targetFilePath?: string;        // Compare: file 2
  sourceFileName?: string;
  targetFileName?: string;
  fileName?: string;
  // Processor config
  processorSlug: string;
  systemPrompt: string;
  responseSchema?: string | null;
  variables: Record<string, unknown>;
  outputFormat: string;
  processorConfig: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
  modelOverride?: string | null;
}

export interface ProcessorResult {
  content?: string;               // Text/Markdown output
  extractedData?: unknown;        // Structured JSON (if responseSchema)
  outputFilePath?: string;        // File on disk (e.g. markdown file)
  inputTokens: number;
  outputTokens: number;
  pagesProcessed: number;
  modelUsed: string;
  costUsd: number;
}

/**
 * Main pipeline runner. Called async after Operation is created.
 */
export async function runPipeline(operationId: string): Promise<void> {
  const operation = await prisma.operation.findUnique({ where: { id: operationId } });
  if (!operation) {
    console.error(`[Pipeline] Operation ${operationId} not found`);
    return;
  }

  const pipeline: PipelineStep[] = JSON.parse(operation.pipelineJson);
  const stepsResult: Array<{
    step: number;
    processor: string;
    output_format: string;
    content_preview?: string | null;
    extracted_data?: unknown;
  }> = [];

  let currentText: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let totalPages = 0;
  let lastModelUsed = '';
  const usageBreakdown: Array<{
    processor: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }> = [];

  try {
    for (let i = 0; i < pipeline.length; i++) {
      const step = pipeline[i];

      // Update progress
      await prisma.operation.update({
        where: { id: operationId },
        data: {
          currentStep: i,
          progressPercent: Math.round((i / pipeline.length) * 100),
          progressMessage: `Đang xử lý step ${i + 1}/${pipeline.length}: ${step.processor}...`,
        },
      });

      // Load processor from DB
      const processor = await prisma.processor.findUnique({ where: { slug: step.processor } });
      if (!processor) {
        throw new Error(`Processor '${step.processor}' not found in database.`);
      }

      // Build context
      const variables = step.variables ?? {};
      const procConfig = processor.processorConfig ? JSON.parse(processor.processorConfig) : {};

      // Interpolate variables into system prompt
      let resolvedPrompt = processor.systemPrompt;
      for (const [key, value] of Object.entries(variables)) {
        resolvedPrompt = resolvedPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
      }
      // Replace {{input_content}} with text from previous step
      if (currentText) {
        resolvedPrompt = resolvedPrompt.replace(/\{\{input_content\}\}/g, currentText);
      }

      const ctx: ProcessorContext = {
        operationId,
        stepIndex: i,
        totalSteps: pipeline.length,
        inputFilePath: i === 0 ? (operation.inputPath ?? undefined) : undefined,
        inputText: currentText,
        sourceFilePath: operation.sourceFilePath ?? undefined,
        targetFilePath: operation.targetFilePath ?? undefined,
        sourceFileName: operation.sourceFileName ?? undefined,
        targetFileName: operation.targetFileName ?? undefined,
        fileName: operation.fileName ?? undefined,
        processorSlug: processor.slug,
        systemPrompt: resolvedPrompt,
        responseSchema: processor.responseSchema,
        variables,
        outputFormat: operation.outputFormat,
        processorConfig: procConfig,
        maxOutputTokens: processor.maxOutputTokens,
        temperature: processor.temperature,
        modelOverride: processor.modelOverride,
      };

      // Route to appropriate processor implementation
      let result: ProcessorResult;

      if (processor.slug === 'prebuilt-layout') {
        result = await runLayoutProcessor(ctx);
      } else if (processor.slug === 'prebuilt-compare') {
        result = await runCompareProcessor(ctx);
      } else {
        // All other processors use the generic LLM processor
        result = await runLLMProcessor(ctx);
      }

      // Record step result
      const stepOutputFormat = processor.outputFormats.split(',')[0];
      stepsResult.push({
        step: i,
        processor: processor.slug,
        output_format: stepOutputFormat,
        content_preview: result.content ? result.content.substring(0, 2000) : null,
        extracted_data: result.extractedData,
      });

      // Track usage
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCost += result.costUsd;
      totalPages += result.pagesProcessed;
      lastModelUsed = result.modelUsed;
      usageBreakdown.push({
        processor: processor.slug,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: result.costUsd,
      });

      // Pass output to next step
      currentText = result.content ?? (result.extractedData ? JSON.stringify(result.extractedData) : undefined);

      // Save intermediate progress
      await prisma.operation.update({
        where: { id: operationId },
        data: {
          stepsResultJson: JSON.stringify(stepsResult),
        },
      });
    }

    // Pipeline completed successfully
    const lastStep = stepsResult[stepsResult.length - 1];
    await prisma.operation.update({
      where: { id: operationId },
      data: {
        done: true,
        state: 'SUCCEEDED',
        progressPercent: 100,
        progressMessage: null,
        currentStep: pipeline.length - 1,
        outputContent: currentText,
        extractedData: lastStep?.extracted_data ? JSON.stringify(lastStep.extracted_data) : null,
        stepsResultJson: JSON.stringify(stepsResult),
        totalInputTokens,
        totalOutputTokens,
        pagesProcessed: totalPages,
        modelUsed: lastModelUsed,
        totalCostUsd: totalCost,
        usageBreakdown: JSON.stringify(usageBreakdown),
      },
    });

    // Webhook notification
    if (operation.webhookUrl) {
      try {
        await fetch(operation.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation_id: operationId,
            state: 'SUCCEEDED',
            done: true,
          }),
        });
        await prisma.operation.update({
          where: { id: operationId },
          data: { webhookSentAt: new Date() },
        });
      } catch (e) {
        console.error(`[Pipeline] Webhook failed for ${operationId}:`, e);
      }
    }

    console.log(`[Pipeline] ✅ Operation ${operationId} completed successfully.`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Pipeline] ❌ Operation ${operationId} failed at step ${stepsResult.length}:`, msg);

    await prisma.operation.update({
      where: { id: operationId },
      data: {
        done: true,
        state: 'FAILED',
        failedAtStep: stepsResult.length,
        errorCode: 'PIPELINE_ERROR',
        errorMessage: msg,
        stepsResultJson: JSON.stringify(stepsResult),
        totalInputTokens,
        totalOutputTokens,
        totalCostUsd: totalCost,
        usageBreakdown: JSON.stringify(usageBreakdown),
      },
    });

    // Webhook on failure too
    if (operation.webhookUrl) {
      try {
        await fetch(operation.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation_id: operationId, state: 'FAILED', error: msg }),
        });
      } catch {}
    }
  }
}
