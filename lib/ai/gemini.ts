// lib/ai/gemini.ts
// Gemini AI wrapper: vision cho hình ảnh (DOCX flow) + PDF → markdown
// Interface AIVisionProvider đặt sẵn để sau thêm OpenAI/Anthropic

import fs from 'fs/promises';
import path from 'path';
import { getSetting } from '@/lib/settings';

// ─── Provider interface (extensible) ─────────────────────────────────────────

export interface AIVisionProvider {
  describeImage(imagePath: string, prompt: string): Promise<{ description: string; shortAlt: string }>;
  convertPdf(pdfPath: string, prompt: string): Promise<string>;
  convertDocx(htmlContent: string, prompt: string): Promise<string>; // nhận HTML từ pandoc -t html
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 120_000; // Tăng timeout lên 2 phút (từ 60s) cho tác vụ lớn
const DELAY_MS = 200;
const RATE_LIMIT_DELAY_MS = 2_000;
const RATE_LIMIT_PAUSE_MS = 30_000;
const MAX_RETRIES = 3;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getApiKey(): Promise<string> {
  // DB trước → .env fallback
  const dbKey = await getSetting('ai_api_key');
  if (dbKey) return dbKey;

  const envKey = process.env.GEMINI_API_KEY;
  if (envKey) return envKey;

  throw new Error('Chưa cấu hình API key. Vào /settings để nhập.');
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string = ''): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.warn(`[Timeout] ${label} vượt quá ${ms}ms`);
      reject(new Error(`[Timeout] ${label}`));
    }, ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timer!);
    return result;
  } catch (e) {
    clearTimeout(timer!);
    throw e;
  }
}

// ─── Gemini implementation ────────────────────────────────────────────────────

class GeminiProvider implements AIVisionProvider {
  async describeImage(
    imagePath: string,
    prompt: string
  ): Promise<{ description: string; shortAlt: string }> {
    const apiKey = await getApiKey();
    const model = await getSetting('ai_model');

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });

    const imageBuffer = await fs.readFile(imagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    let consecutiveFails = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await withTimeout(
          geminiModel.generateContent([
            { inlineData: { data: base64, mimeType } },
            prompt,
          ]),
          TIMEOUT_MS
        );

        const text = result.response.text().trim();
        const lines = text.split('\n').filter(l => l.trim());
        const shortAlt = lines[0]?.slice(0, 100) ?? 'Hình minh họa';

        await sleep(DELAY_MS);
        return { description: text, shortAlt };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isTimeout = msg.includes('[Timeout]');

        console.error(`[Gemini] describeImage lỗi ở lần thử ${attempt}: ${msg}`);

        if (isRateLimit) {
          consecutiveFails++;
          if (consecutiveFails >= 3) {
            console.warn('[Gemini] describeImage quá giới hạn (rate limit) 3 lần liên tiếp — đang chờ 30s...');
            await sleep(RATE_LIMIT_PAUSE_MS);
            consecutiveFails = 0;
          } else {
            console.warn(`[Gemini] describeImage rate limit — chờ ${RATE_LIMIT_DELAY_MS}ms...`);
            await sleep(RATE_LIMIT_DELAY_MS);
          }
          continue;
        }

        if (isTimeout && attempt === 0) {
          console.warn('[Gemini] describeImage Timeout lần đầu — đang thử lại 1 lần...');
          continue;
        }

        // Lỗi khác hoặc đã retry đủ lần
        console.error(`[Gemini] describeImage thất bại sau ${attempt} lần thử:`, msg);
        if (attempt >= 1) break;
      }
    }

    return { description: '[Không thể mô tả hình này]', shortAlt: 'Hình minh họa' };
  }

  async convertPdf(pdfPath: string, prompt: string): Promise<string> {
    const apiKey = await getApiKey();
    const model = await getSetting('ai_model');

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });

    const pdfBuffer = await fs.readFile(pdfPath);
    const base64 = pdfBuffer.toString('base64');

    let consecutiveFails = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await withTimeout(
          geminiModel.generateContent([
            { inlineData: { data: base64, mimeType: 'application/pdf' } },
            prompt,
          ]),
          TIMEOUT_MS
        );

        await sleep(DELAY_MS);
        return result.response.text().trim();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isTimeout = msg.includes('[Timeout]');

        console.error(`[Gemini] convertPdf lỗi ở lần thử ${attempt}: ${msg}`);

        if (isRateLimit) {
          consecutiveFails++;
          if (consecutiveFails >= 3) {
            console.warn('[Gemini] convertPdf quá giới hạn (rate limit) 3 lần liên tiếp — đang chờ 30s...');
            await sleep(RATE_LIMIT_PAUSE_MS);
            consecutiveFails = 0;
          } else {
            console.warn(`[Gemini] convertPdf rate limit — chờ ${RATE_LIMIT_DELAY_MS}ms...`);
            await sleep(RATE_LIMIT_DELAY_MS);
          }
          continue;
        }
        
        if (isTimeout && attempt === 0) {
          console.warn('[Gemini] convertPdf Timeout lần đầu — đang thử lại 1 lần...');
          continue;
        }

        console.error(`[Gemini] convertPdf thất bại sau ${attempt} lần thử:`, msg);
        if (attempt >= 1) throw err;
      }
    }

    throw new Error('Gemini không thể transform PDF sau nhiều lần thử.');
  }

  // convertDocx: nhận HTML content (từ pandoc -t html), gửi Gemini dưới dạng text
  // Gemini không hỗ trợ MIME DOCX → phải transform sang text/HTML trước
  async convertDocx(htmlContent: string, prompt: string): Promise<string> {
    const apiKey = await getApiKey();
    const model = await getSetting('ai_model');

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });

    const fullPrompt = `${prompt}\n\nHere is the document content in HTML format:\n\n${htmlContent}`;

    let consecutiveFails = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await withTimeout(
          geminiModel.generateContent(fullPrompt),
          TIMEOUT_MS
        );

        await sleep(DELAY_MS);
        return result.response.text().trim();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isTimeout = msg.includes('[Timeout]');

        console.error(`[Gemini] convertDocx lỗi ở lần thử ${attempt}: ${msg}`);

        if (isRateLimit) {
          consecutiveFails++;
          if (consecutiveFails >= 3) {
            console.warn('[Gemini] convertDocx quá giới hạn (rate limit) 3 lần liên tiếp — đang chờ 30s...');
            await sleep(RATE_LIMIT_PAUSE_MS);
            consecutiveFails = 0;
          } else {
            console.warn(`[Gemini] convertDocx rate limit — chờ ${RATE_LIMIT_DELAY_MS}ms...`);
            await sleep(RATE_LIMIT_DELAY_MS);
          }
          continue;
        }

        if (isTimeout && attempt === 0) {
          console.warn('[Gemini] convertDocx Timeout lần đầu — đang thử lại 1 lần...');
          continue;
        }

        console.error(`[Gemini] convertDocx thất bại sau ${attempt} lần thử:`, msg);
        if (attempt >= 1) throw err;
      }
    }

    throw new Error('Gemini không thể transform DOCX sau nhiều lần thử.');
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const aiProvider: AIVisionProvider = new GeminiProvider();

// ─── Convenience exports ───────────────────────────────────────────────────────

export async function describeImage(
  imagePath: string
): Promise<{ description: string; shortAlt: string }> {
  const prompt = await getSetting('ai_image_prompt');
  return aiProvider.describeImage(imagePath, prompt);
}

// ─── Parallel batch describe ───────────────────────────────────────────────────
// Gọi song song tối đa `concurrency` request cùng lúc, delay 300ms giữa các chunk.
// Nếu 1 hình fail → trả fallback, không fail toàn batch. Kết quả theo đúng thứ tự input.

export async function describeImages(
  imagePaths: string[],
  concurrency = 5,
  onChunkDone?: (done: number, total: number) => void,
): Promise<Array<{ description: string; shortAlt: string }>> {
  const total = imagePaths.length;
  const results: Array<{ description: string; shortAlt: string }> = [];
  const prompt = await getSetting('ai_image_prompt');

  for (let i = 0; i < total; i += concurrency) {
    const chunk = imagePaths.slice(i, i + concurrency);

    const chunkResults = await Promise.allSettled(
      chunk.map(imagePath => aiProvider.describeImage(imagePath, prompt))
    );

    for (const r of chunkResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error('[Gemini] describeImages item failed:', r.reason);
        results.push({ description: '[Không thể mô tả hình này]', shortAlt: 'Hình minh họa' });
      }
    }

    const done = Math.min(i + concurrency, total);
    onChunkDone?.(done, total);

    // Delay giữa các chunk (trừ chunk cuối) để tránh rate limit
    if (i + concurrency < total) {
      await sleep(300);
    }
  }

  return results;
}

export async function convertPdfWithAI(
  pdfPath: string
): Promise<string> {
  const prompt = await getSetting('ai_pdf_prompt');
  return aiProvider.convertPdf(pdfPath, prompt);
}

export async function convertDocxWithAI(
  htmlContent: string
): Promise<string> {
  const prompt = await getSetting('ai_docx_prompt');
  return aiProvider.convertDocx(htmlContent, prompt);
}

// ─── Document comparison ───────────────────────────────────────────────────────
// So sánh 2 tài liệu (đã transform sang markdown) bằng Gemini.
// Trả về JSON array của ComparisonRow[].

export interface ComparisonRow {
  clause: string;        // Điều/khoản (vd: "Điều 3")
  file1Content: string;  // Nội dung từ file 1 (rỗng nếu không có)
  file2Content: string;  // Nội dung từ file 2 (rỗng nếu không có)
  note: string;          // Mô tả sự khác biệt
}

export async function compareDocuments(
  md1: string,
  md2: string,
): Promise<ComparisonRow[]> {
  const apiKey = await getApiKey();
  const model = await getSetting('ai_model');
  const promptTemplate = await getSetting('ai_compare_prompt');

  const prompt = promptTemplate
    .replace('{file1}', md1)
    .replace('{file2}', md2);

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });

  let consecutiveFails = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(
        geminiModel.generateContent(prompt),
        120_000  // 2 phút — tài liệu dài có thể cần nhiều thời gian hơn
      );

      await sleep(DELAY_MS);
      const text = result.response.text().trim();

      // Bóc JSON từ response (có thể wrapped trong ```json ... ```)
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/^\s*(\[[\s\S]*\])\s*$/);
      const jsonStr = jsonMatch ? jsonMatch[1] : text;

      try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) return parsed as ComparisonRow[];
        throw new Error('Response không phải JSON array');
      } catch (parseErr) {
        console.error('[compareDocuments] JSON parse error:', parseErr, '\nRaw:', jsonStr.slice(0, 300));
        throw parseErr;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit) {
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          await sleep(RATE_LIMIT_PAUSE_MS);
          consecutiveFails = 0;
        } else {
          await sleep(RATE_LIMIT_DELAY_MS);
        }
        continue;
      }

      console.error(`[compareDocuments] fail attempt ${attempt}:`, msg);
      if (attempt >= 1) throw err;
    }
  }

  throw new Error('Gemini không thể so sánh tài liệu sau nhiều lần thử.');
}

// ─── Document generation ──────────────────────────────────────────────────────
// Đọc nội dung tài liệu (md/html) + user prompt → AI tạo tài liệu mới.

export async function generateDocument(
  inputContent: string,
  outputFormat: 'md' | 'html',
  userPrompt: string,
): Promise<string> {
  const apiKey = await getApiKey();
  const model = await getSetting('ai_model');
  const promptTemplate = await getSetting('ai_generate_prompt');

  const formatInstruction = outputFormat === 'html'
    ? 'Output ONLY valid HTML (body content, no <html>/<head> wrapper). Do not include markdown.'
    : 'Output ONLY clean Markdown. Do not include HTML tags.';

  const prompt = promptTemplate
    .replace('{user_prompt}', userPrompt)
    .replace('{input_content}', inputContent)
    + `\n\n${formatInstruction}`;

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });

  let consecutiveFails = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(
        geminiModel.generateContent(prompt),
        120_000
      );

      await sleep(DELAY_MS);
      let text = result.response.text().trim();

      // Strip markdown code fences if present
      text = text.replace(/^```(?:html|markdown|md)?\n?/, '').replace(/\n?```$/, '').trim();

      return text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit) {
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          await sleep(RATE_LIMIT_PAUSE_MS);
          consecutiveFails = 0;
        } else {
          await sleep(RATE_LIMIT_DELAY_MS);
        }
        continue;
      }

      console.error(`[generateDocument] fail attempt ${attempt}:`, msg);
      if (attempt >= 1) throw err;
    }
  }

  throw new Error('Gemini không thể tạo tài liệu sau nhiều lần thử.');
}
