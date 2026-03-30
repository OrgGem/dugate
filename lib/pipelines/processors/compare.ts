// lib/pipelines/processors/compare.ts
// Compare processor: semantic diff between 2 documents

import path from 'path';
import fs from 'fs/promises';
import { convertDocx } from '@/lib/transformers/docx';
import { convertPdf } from '@/lib/transformers/pdf';
import { compareDocuments } from '@/lib/ai';
import type { ProcessorContext, ProcessorResult } from '@/lib/pipelines/engine';

async function fileToMarkdown(
  filePath: string,
  fileName: string,
  outputDir: string,
  config: Record<string, unknown>,
): Promise<string> {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const tmpDir = path.join(outputDir, `_tmp_${path.basename(fileName, `.${ext}`)}`);
  await fs.mkdir(tmpDir, { recursive: true });

  if (ext === 'pdf') {
    const result = await convertPdf(filePath, tmpDir, 'ebook', 'compare');
    return await fs.readFile(result.textOnlyMdPath, 'utf-8');
  } else if (ext === 'docx') {
    const mode = (config.docxMode as 'pandoc' | 'ai') ?? 'ai';
    const result = await convertDocx(filePath, tmpDir, fileName, { mode });
    return await fs.readFile(result.rawMdPath, 'utf-8');
  }
  throw new Error(`Compare processor does not support: .${ext}`);
}

export async function runCompareProcessor(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { operationId, sourceFilePath, targetFilePath, sourceFileName, targetFileName } = ctx;

  if (!sourceFilePath || !targetFilePath) {
    throw new Error('Compare processor requires source_file and target_file.');
  }

  const outputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', 'compare', operationId);
  await fs.mkdir(outputDir, { recursive: true });

  // Convert both files to markdown
  const md1 = await fileToMarkdown(sourceFilePath, sourceFileName ?? 'source', outputDir, ctx.processorConfig);
  const md2 = await fileToMarkdown(targetFilePath, targetFileName ?? 'target', outputDir, ctx.processorConfig);

  // Run AI comparison
  const rows = await compareDocuments(md1, md2);

  const resultData = {
    similarity_score: 0,
    total_changes: rows.length,
    differences: rows,
    source_preview: md1.substring(0, 500),
    target_preview: md2.substring(0, 500),
  };

  return {
    content: JSON.stringify(resultData, null, 2),
    extractedData: resultData,
    inputTokens: 0,
    outputTokens: 0,
    pagesProcessed: 2,
    modelUsed: 'gemini',
    costUsd: 0,
  };
}
