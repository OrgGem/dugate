// lib/pipelines/processors/llm.ts
// Generic LLM processor: handles summarize, translate, redact, classify, generate, etc.
// Uses system prompt from Processor config + input text from context

import path from 'path';
import fs from 'fs/promises';
import { convertDocx } from '@/lib/transformers/docx';
import { convertPdf } from '@/lib/transformers/pdf';
import { generateDocument } from '@/lib/ai';
import type { ProcessorContext, ProcessorResult } from '@/lib/pipelines/engine';

/**
 * If this is the first step and we have a binary file, extract text from it first.
 * If we already have inputText (from a previous step), use that directly.
 */
async function resolveInputText(ctx: ProcessorContext): Promise<string> {
  // Chain step: use text from previous step
  if (ctx.inputText) {
    return ctx.inputText;
  }

  // First step with file: extract text first
  if (ctx.inputFilePath && ctx.fileName) {
    const ext = ctx.fileName.split('.').pop()?.toLowerCase();
    const outputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', ctx.operationId, `_step${ctx.stepIndex}`);
    await fs.mkdir(outputDir, { recursive: true });

    if (ext === 'pdf') {
      const compressLevel = (ctx.processorConfig.compressLevel as string) ?? 'ebook';
      const result = await convertPdf(ctx.inputFilePath, outputDir, compressLevel, 'input');
      return await fs.readFile(result.textOnlyMdPath, 'utf-8');
    } else if (ext === 'docx') {
      const mode = (ctx.processorConfig.docxMode as 'pandoc' | 'ai') ?? 'ai';
      const { rawMdPath } = await convertDocx(ctx.inputFilePath, outputDir, ctx.fileName, { mode });
      return await fs.readFile(rawMdPath, 'utf-8');
    }
    throw new Error(`LLM processor cannot extract text from .${ext} files`);
  }

  throw new Error('LLM processor requires either inputText or inputFilePath.');
}

export async function runLLMProcessor(ctx: ProcessorContext): Promise<ProcessorResult> {
  const inputContent = await resolveInputText(ctx);

  // The system prompt already has variables interpolated by engine.ts
  // But if it still contains {{input_content}}, replace it now
  let prompt = ctx.systemPrompt;
  if (prompt.includes('{{input_content}}')) {
    prompt = prompt.replace(/\{\{input_content\}\}/g, inputContent);
  }

  // Determine output format from the processor
  const outputFormat = (ctx.outputFormat === 'json' ? 'md' : ctx.outputFormat) as 'md' | 'html';

  // Call AI
  const outputContent = await generateDocument(inputContent, outputFormat, prompt);

  // If processor has responseSchema, try to parse as JSON
  let extractedData: unknown = undefined;
  if (ctx.responseSchema) {
    try {
      // Try to find JSON in the output
      const jsonMatch = outputContent.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[1]);
      } else {
        // Try parsing the whole output as JSON
        extractedData = JSON.parse(outputContent);
      }
    } catch {
      // If JSON parsing fails, store as text
      extractedData = null;
    }
  }

  // Save output to file
  const outputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', ctx.operationId);
  await fs.mkdir(outputDir, { recursive: true });
  const ext = ctx.outputFormat === 'html' ? 'html' : 'md';
  const outputPath = path.join(outputDir, `output_step${ctx.stepIndex}.${ext}`);
  await fs.writeFile(outputPath, outputContent, 'utf-8');

  return {
    content: outputContent,
    extractedData,
    outputFilePath: outputPath,
    inputTokens: Math.ceil(inputContent.length / 4),  // rough estimate
    outputTokens: Math.ceil(outputContent.length / 4),
    pagesProcessed: 0,
    modelUsed: ctx.modelOverride ?? 'default',
    costUsd: 0,
  };
}
