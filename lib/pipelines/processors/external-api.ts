// lib/pipelines/processors/external-api.ts
// External API Processor — forward files trực tiếp đến external AI service via multipart/form-data.
// v2: Supports forwarding multiple files (files[]) in one request.

import fs from 'fs/promises';
import type { ProcessorContext, ProcessorResult } from '@/lib/pipelines/engine';
import type { ExternalApiConnection, ExternalApiOverride } from '@prisma/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve giá trị theo dot-path trong JSON object.
 * VD: resolveDotPath({ data: { response: "hello" } }, "data.response") => "hello"
 */
function resolveDotPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath || obj === null || obj === undefined) return obj;
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Interpolate {{variable}} placeholders trong template string.
 * VD: "Xin chào {{name}}" với { name: "An" } => "Xin chào An"
 */
function interpolateVariables(template: string, variables: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }
  return result;
}

// ─── Core Processor ───────────────────────────────────────────────────────────

/**
 * Gọi external AI service via multipart/form-data HTTP request.
 * - Forward tất cả files gốc trực tiếp (không extract text trước)
 * - Prompt có thể được override bởi client profile
 * - Static form fields luôn cố định theo config admin
 */
export async function runExternalApiProcessor(
  ctx: ProcessorContext,
  connection: ExternalApiConnection,
  override?: ExternalApiOverride | null,
): Promise<ProcessorResult> {
  const startedAt = Date.now();

  // ── 1. Resolve prompt (override → default) ─────────────────────────────────
  const rawPrompt = override?.promptOverride?.trim()
    ? override.promptOverride
    : connection.defaultPrompt;

  // Interpolate {{variable}} từ pipeline variables
  const resolvedPrompt = interpolateVariables(rawPrompt, ctx.variables);

  console.log(`[ExtAPI] ${connection.slug} | step ${ctx.stepIndex + 1}/${ctx.totalSteps} | prompt: ${resolvedPrompt.length} chars`);

  // ── 2. Build multipart/form-data ───────────────────────────────────────────
  const formData = new FormData();

  // 2a. Prompt field
  formData.append(connection.promptFieldName, resolvedPrompt);

  // 2b. Static form fields (admin-configured, cố định)
  if (connection.staticFormFields) {
    try {
      const staticFields = JSON.parse(connection.staticFormFields) as Array<{ key: string; value: string }>;
      for (const field of staticFields) {
        formData.append(field.key, field.value);
      }
    } catch {
      console.warn(`[ExtAPI] staticFormFields JSON invalid for '${connection.slug}', skipping`);
    }
  }

  // 2c. Forward all files (multi-file support)
  if (ctx.filePaths.length > 0) {
    for (let i = 0; i < ctx.filePaths.length; i++) {
      const filePath = ctx.filePaths[i];
      const fileName = ctx.fileNames[i] ?? `file_${i}`;
      try {
        const fileBuffer = await fs.readFile(filePath);
        const blob = new Blob([fileBuffer]);
        formData.append(connection.fileFieldName, blob, fileName);
        console.log(`[ExtAPI] Attaching file[${i}]: ${fileName} (${fileBuffer.length} bytes)`);
      } catch (e) {
        console.warn(`[ExtAPI] Could not read file '${filePath}':`, e);
      }
    }
  } else if (ctx.inputText) {
    // Chain step: inject previous step output as text variable
    formData.append('input_content', ctx.inputText);
  }

  // ── 3. Build request headers ────────────────────────────────────────────────
  const headers: Record<string, string> = {
    'accept': 'application/json',
  };

  if (connection.authType === 'API_KEY_HEADER') {
    headers[connection.authKeyHeader] = connection.authSecret;
  } else if (connection.authType === 'BEARER') {
    headers['Authorization'] = `Bearer ${connection.authSecret}`;
  }

  if (connection.extraHeaders) {
    try {
      const extra = JSON.parse(connection.extraHeaders) as Record<string, string>;
      Object.assign(headers, extra);
    } catch {
      console.warn(`[ExtAPI] extraHeaders JSON invalid for '${connection.slug}', skipping`);
    }
  }

  // ── 4. HTTP Request với timeout ────────────────────────────────────────────
  const controller = new AbortController();
  const timeoutMs = connection.timeoutSec * 1000;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let responseJson: unknown;
  try {
    console.log(`[ExtAPI] POST → ${connection.endpointUrl}`);
    const response = await fetch(connection.endpointUrl, {
      method: connection.httpMethod,
      headers,
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(no body)');
      throw new Error(`External API returned HTTP ${response.status}: ${errorBody.substring(0, 500)}`);
    }

    responseJson = await response.json();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`External API timeout after ${connection.timeoutSec}s (${connection.slug})`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  // ── 5. Parse response với dot-path ────────────────────────────────────────
  const contentPath = connection.responseContentPath ?? 'content';
  const rawContent = resolveDotPath(responseJson, contentPath);

  let content: string;
  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (rawContent !== null && rawContent !== undefined) {
    content = JSON.stringify(rawContent);
  } else {
    console.warn(`[ExtAPI] Path '${contentPath}' not found in response for '${connection.slug}'. Returning full JSON.`);
    content = JSON.stringify(responseJson);
  }

  const latencyMs = Date.now() - startedAt;
  console.log(`[ExtAPI] ✅ ${connection.slug} done in ${latencyMs}ms, output: ${content.length} chars`);

  return {
    content,
    extractedData: undefined,
    outputFilePath: undefined,
    inputTokens: 0,
    outputTokens: 0,
    pagesProcessed: 0,
    modelUsed: `ext:${connection.slug}`,
    costUsd: 0,
  };
}
