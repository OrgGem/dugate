// lib/ai/openai.ts
import fs from 'fs/promises';
import { getSetting } from '@/lib/settings';

const TIMEOUT_MS = 120_000;
const DELAY_MS = 200;
const MAX_RETRIES = 3;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getClient() {
  const { OpenAI } = await import('openai');
  const apiKey = await getSetting('openai_api_key');
  const baseURL = await getSetting('openai_base_url');
  
  if (!apiKey && !baseURL) {
    throw new Error('Chưa cấu hình OpenAI key hoặc Base URL. Vào /settings để nhập.');
  }

  // Khuyến khích truyền dummy key nếu chạy local (vLLM/Ollama không cần key nhưng SDK vẫn bắt buộc string)
  return new OpenAI({
    apiKey: apiKey || 'dummy-key',
    baseURL: baseURL || 'https://api.openai.com/v1',
    timeout: TIMEOUT_MS,
  });
}

export async function describeImage(imagePath: string): Promise<{ description: string; shortAlt: string }> {
  const prompt = await getSetting('ai_image_prompt');
  const model = await getSetting('ai_model') || 'gpt-4o-mini';
  const client = await getClient();

  const imageBuffer = await fs.readFile(imagePath);
  const base64 = imageBuffer.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  let consecutiveFails = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
            ]
          }
        ]
      });

      const text = response.choices[0]?.message?.content?.trim() || '';
      const lines = text.split('\n').filter(l => l.trim());
      const shortAlt = lines[0]?.slice(0, 100) ?? 'Hình minh họa';

      await sleep(DELAY_MS);
      return { description: text, shortAlt };
    } catch (err: any) {
      if (err.status === 429) {
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          await sleep(30_000);
          consecutiveFails = 0;
        } else {
          await sleep(2000);
        }
        continue;
      }
      if (attempt >= 1) {
        console.error(`[OpenAI] describeImage error:`, err);
        break; // Lỗi từ SDK không phải timeout/rate_limit thì thoát
      }
    }
  }
  return { description: '[Không thể mô tả hình này]', shortAlt: 'Hình minh họa' };
}

export async function describeImages(
  imagePaths: string[],
  concurrency = 5,
  onChunkDone?: (done: number, total: number) => void
): Promise<Array<{ description: string; shortAlt: string }>> {
  const total = imagePaths.length;
  const results: Array<{ description: string; shortAlt: string }> = [];

  for (let i = 0; i < total; i += concurrency) {
    const chunk = imagePaths.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(imagePath => describeImage(imagePath))
    );

    for (const r of chunkResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ description: '[Không thể mô tả hình này]', shortAlt: 'Hình minh họa' });
      }
    }

    const done = Math.min(i + concurrency, total);
    onChunkDone?.(done, total);

    if (i + concurrency < total) {
      await sleep(300);
    }
  }
  return results;
}

export async function convertPdfWithAI(pdfPath: string): Promise<string> {
  throw new Error('Chức năng PDF bằng Vision API chưa được hỗ trợ tốt trên chuẩn OpenAI (API không hỗ trợ native file pdf qua base64 URL như Gemini). Vui lòng đổi sang Gemini để dùng chế độ đọc PDF.');
}

export async function convertDocxWithAI(htmlContent: string): Promise<string> {
  const prompt = await getSetting('ai_docx_prompt');
  const model = await getSetting('ai_model') || 'gpt-4o-mini';
  const client = await getClient();

  const fullPrompt = `${prompt}\n\nHere is the document content in HTML format:\n\n${htmlContent}`;

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: fullPrompt }]
  });

  return response.choices[0]?.message?.content?.trim() || '';
}

export interface ComparisonRow {
  clause: string;
  file1Content: string;
  file2Content: string;
  note: string;
}

export async function compareDocuments(md1: string, md2: string): Promise<ComparisonRow[]> {
  const promptTemplate = await getSetting('ai_compare_prompt');
  const model = await getSetting('ai_model') || 'gpt-4o-mini';
  const client = await getClient();

  const prompt = promptTemplate.replace('{file1}', md1).replace('{file2}', md2);

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.choices[0]?.message?.content?.trim() || '';
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/^\s*(\[[\s\S]*\])\s*$/);
  const jsonStr = jsonMatch ? jsonMatch[1] : text;

  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) return parsed as ComparisonRow[];
    throw new Error('Response không phải JSON array');
  } catch (err) {
    throw err;
  }
}

export async function generateDocument(inputContent: string, outputFormat: 'md' | 'html', userPrompt: string): Promise<string> {
  const promptTemplate = await getSetting('ai_generate_prompt');
  const model = await getSetting('ai_model') || 'gpt-4o-mini';
  const client = await getClient();

  const formatInstruction = outputFormat === 'html'
    ? 'Output ONLY valid HTML (body content, no <html>/<head> wrapper). Do not include markdown.'
    : 'Output ONLY clean Markdown. Do not include HTML tags.';

  const prompt = promptTemplate
    .replace('{user_prompt}', userPrompt)
    .replace('{input_content}', inputContent)
    + `\n\n${formatInstruction}`;

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }]
  });

  let text = response.choices[0]?.message?.content?.trim() || '';
  text = text.replace(/^```(?:html|markdown|md)?\n?/, '').replace(/\n?```$/, '').trim();
  return text;
}
