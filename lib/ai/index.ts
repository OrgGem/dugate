// lib/ai/index.ts
// Lớp điều phối (Switch Container) chọn provider AI tương ứng

import { getSetting } from '@/lib/settings';
import * as gemini from './gemini';
import * as openai from './openai';

export interface ComparisonRow {
  clause: string;
  file1Content: string;
  file2Content: string;
  note: string;
}

export async function describeImage(imagePath: string): Promise<{ description: string; shortAlt: string }> {
  const provider = await getSetting('ai_provider');
  if (provider === 'openai') {
    return openai.describeImage(imagePath);
  }
  return gemini.describeImage(imagePath);
}

export async function describeImages(
  imagePaths: string[],
  concurrency = 5,
  onChunkDone?: (done: number, total: number) => void
): Promise<Array<{ description: string; shortAlt: string }>> {
  const provider = await getSetting('ai_provider');
  if (provider === 'openai') {
    return openai.describeImages(imagePaths, concurrency, onChunkDone);
  }
  return gemini.describeImages(imagePaths, concurrency, onChunkDone);
}

export async function convertPdfWithAI(pdfPath: string): Promise<string> {
  const provider = await getSetting('ai_provider');
  if (provider === 'openai') {
    return openai.convertPdfWithAI(pdfPath);
  }
  return gemini.convertPdfWithAI(pdfPath);
}

export async function convertDocxWithAI(htmlContent: string): Promise<string> {
  const provider = await getSetting('ai_provider');
  if (provider === 'openai') {
    return openai.convertDocxWithAI(htmlContent);
  }
  return gemini.convertDocxWithAI(htmlContent);
}

export async function compareDocuments(md1: string, md2: string): Promise<ComparisonRow[]> {
  const provider = await getSetting('ai_provider');
  if (provider === 'openai') {
    return openai.compareDocuments(md1, md2);
  }
  return gemini.compareDocuments(md1, md2);
}

export async function generateDocument(inputContent: string, outputFormat: 'md' | 'html', userPrompt: string): Promise<string> {
  const provider = await getSetting('ai_provider');
  if (provider === 'openai') {
    return openai.generateDocument(inputContent, outputFormat, userPrompt);
  }
  return gemini.generateDocument(inputContent, outputFormat, userPrompt);
}
