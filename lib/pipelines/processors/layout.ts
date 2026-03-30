// lib/pipelines/processors/layout.ts  
// Layout processor: Converts PDF/DOCX binary to Markdown text
// Wraps existing transform logic from lib/transformers/

import path from 'path';
import fs from 'fs/promises';
import { convertDocx, slugify } from '@/lib/transformers/docx';
import { convertPdf } from '@/lib/transformers/pdf';
import type { ProcessorContext, ProcessorResult } from '@/lib/pipelines/engine';

export async function runLayoutProcessor(ctx: ProcessorContext): Promise<ProcessorResult> {
  const { operationId, inputFilePath, fileName } = ctx;

  if (!inputFilePath || !fileName) {
    throw new Error('Layout processor requires a file input.');
  }

  const outputDir = path.join(process.env.OUTPUT_DIR ?? './outputs', operationId);
  await fs.mkdir(outputDir, { recursive: true });

  const ext = fileName.split('.').pop()?.toLowerCase();
  const slug = slugify(fileName);
  const config = ctx.processorConfig;

  let markdownContent = '';

  if (ext === 'pdf') {
    const compressLevel = (config.compressLevel as string) ?? 'ebook';
    const result = await convertPdf(inputFilePath, outputDir, compressLevel, slug);
    markdownContent = await fs.readFile(result.textOnlyMdPath, 'utf-8');
  } else if (ext === 'docx') {
    const mode = (config.docxMode as 'pandoc' | 'ai') ?? 'ai';
    const { rawMdPath } = await convertDocx(inputFilePath, outputDir, fileName, { mode });
    markdownContent = await fs.readFile(rawMdPath, 'utf-8');
  } else {
    throw new Error(`Layout processor does not support file type: .${ext}`);
  }

  // Save output markdown file
  const outputPath = path.join(outputDir, `${slug}.md`);
  await fs.writeFile(outputPath, markdownContent, 'utf-8');

  return {
    content: markdownContent,
    outputFilePath: outputPath,
    inputTokens: 0,
    outputTokens: 0,
    pagesProcessed: 1,
    modelUsed: 'pandoc/native',
    costUsd: 0,
  };
}
