import {
  CONNECTOR_ARTIFACT_MAX_BYTES,
  CONNECTOR_ARTIFACT_MAX_COUNT,
  LegacyWorkflowResultSchema,
  contentHash,
} from '@du/contracts';
import type { TaskContext, TaskDisposition } from '@du/worker-sdk';

import { LcCheckerError } from './errors';
import { buildComplianceCheckPrompt, buildOcrPrompt, buildReportPrompt, type LCCheckResult } from './legacy-workflow-prompts';

const LEGACY_MARKER_VERSION = 'legacy-workflow-named-input-v1';
const LEGACY_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const LEGACY_OCR_TEXT_MAX_BYTES = 4 * 1024 * 1024;
const LEGACY_OCR_CONCURRENCY = 8;
const LEGACY_OCR_SLOT = 'legacy-ocr';
const LEGACY_COMPLIANCE_SLOT = 'legacy-compliance';
const LEGACY_REPORT_SLOT = 'legacy-report';
const LEGACY_CONNECTOR_SLOTS = [LEGACY_OCR_SLOT, LEGACY_COMPLIANCE_SLOT, LEGACY_REPORT_SLOT] as const;

interface LegacyArtifactInput {
  readonly artifactId: string;
  readonly role: string;
}

interface LegacyLcInput {
  readonly variables: Record<string, unknown>;
  readonly artifactIds: readonly string[];
  readonly fileNames: readonly string[];
  readonly artifacts: readonly LegacyArtifactInput[];
}

interface InlinedLegacyArtifact {
  readonly artifactId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageVersionId: string;
  readonly contentBase64: string;
}

interface UsageSnapshot {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly pages?: number;
  readonly costUsd?: number;
}

interface UsageTotals {
  sawUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  sawPages: boolean;
  costMicrousd: number;
  sawCost: boolean;
}

interface OcrCheckpoint {
  readonly artifactId: string;
  readonly characterCount: number;
  readonly usage: UsageSnapshot;
}

interface OcrOutcome {
  readonly fileName: string;
  readonly text: string;
  readonly status: 'success' | 'error';
  readonly error?: string;
  readonly usage: UsageSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLegacyLcInput(ctx: TaskContext): LegacyLcInput {
  if (ctx.businessId !== 'lc-checker' || ctx.action !== 'lc-checker') {
    throw new LcCheckerError('INPUT_INVALID', 'Legacy LC input is not authorized for this business action');
  }

  const raw = ctx.input;
  const allowedKeys = new Set(['variables', 'artifactIds', 'fileNames', 'artifacts', 'legacyWorkflow']);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    throw new LcCheckerError('INPUT_INVALID', 'Legacy LC input contains unsupported fields');
  }
  const marker = raw['legacyWorkflow'];
  if (!isRecord(marker) || Object.keys(marker).length !== 2
      || marker['version'] !== LEGACY_MARKER_VERSION || marker['process'] !== 'lc-checker') {
    throw new LcCheckerError('INPUT_INVALID', 'Legacy LC input marker is missing or invalid');
  }
  if (!isRecord(raw['variables']) || Object.keys(raw['variables']).length !== 0) {
    throw new LcCheckerError('INPUT_INVALID', 'The legacy LC workflow accepts no variables');
  }
  if (!Array.isArray(raw['artifactIds']) || !Array.isArray(raw['fileNames']) || !Array.isArray(raw['artifacts'])) {
    throw new LcCheckerError('INPUT_INVALID', 'Legacy LC input is missing its normalized artifact references');
  }

  const artifactIds = raw['artifactIds'];
  const fileNames = raw['fileNames'];
  const artifacts = raw['artifacts'];
  if (artifactIds.length < 1 || artifactIds.length > 50 || artifactIds.length !== fileNames.length
      || artifactIds.length !== artifacts.length || new Set(artifactIds).size !== artifactIds.length) {
    throw new LcCheckerError('INPUT_INVALID', 'Legacy LC input must contain matching unique document references');
  }
  for (let index = 0; index < artifactIds.length; index += 1) {
    const id = artifactIds[index];
    const name = fileNames[index];
    const ref = artifacts[index];
    if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0 || name.length > 255
        || !isRecord(ref) || Object.keys(ref).some((key) => key !== 'artifactId' && key !== 'role')
        || ref['artifactId'] !== id || typeof ref['role'] !== 'string' || ref['role'].length === 0) {
      throw new LcCheckerError('INPUT_INVALID', 'Legacy LC artifact references are malformed');
    }
  }
  return {
    variables: raw['variables'],
    artifactIds: artifactIds as string[],
    fileNames: fileNames as string[],
    artifacts: artifacts as LegacyArtifactInput[],
  };
}

function assertLegacySlots(ctx: TaskContext): void {
  for (const slot of LEGACY_CONNECTOR_SLOTS) {
    if (typeof ctx.connectorBindings[slot] !== 'string' || ctx.connectorBindings[slot]!.length === 0) {
      throw new LcCheckerError(
        'PORT_MISCONFIGURED',
        `The authorized profile does not pin required legacy LC connector slot ${slot}`,
      );
    }
  }
}

function assertActive(ctx: TaskContext): void {
  if (ctx.cancelRequested) throw new LcCheckerError('PORT_MISCONFIGURED', 'Cancellation was requested for this operation');
  if (ctx.signal.aborted) throw new LcCheckerError('PORT_MISCONFIGURED', 'The task lease was lost or shutdown began');
}

async function inlineArtifact(
  ctx: TaskContext,
  artifactId: string,
  fallbackName: string,
): Promise<InlinedLegacyArtifact> {
  const read = await ctx.artifacts.readWithMetadata(artifactId, { signal: ctx.signal });
  if (read.sizeBytes > CONNECTOR_ARTIFACT_MAX_BYTES) {
    throw new LcCheckerError('PORT_MISCONFIGURED', `Legacy LC file exceeds the ${CONNECTOR_ARTIFACT_MAX_BYTES}-byte connector limit`);
  }
  return {
    artifactId,
    fileName: read.filename ?? fallbackName,
    mimeType: read.mimeType ?? 'application/octet-stream',
    sizeBytes: read.sizeBytes,
    sha256: read.sha256,
    storageVersionId: read.storageVersionId ?? '',
    contentBase64: read.buffer.toString('base64'),
  };
}

async function loadOriginalDocuments(ctx: TaskContext, input: LegacyLcInput): Promise<InlinedLegacyArtifact[]> {
  if (input.artifactIds.length > CONNECTOR_ARTIFACT_MAX_COUNT) {
    throw new LcCheckerError(
      'PORT_MISCONFIGURED',
      `Legacy LC compliance requires every original PDF, but the connector contract allows at most ${CONNECTOR_ARTIFACT_MAX_COUNT} attachments`,
    );
  }
  const documents: InlinedLegacyArtifact[] = [];
  let totalBytes = 0;
  for (let index = 0; index < input.artifactIds.length; index += 1) {
    assertActive(ctx);
    const document = await inlineArtifact(ctx, input.artifactIds[index]!, input.fileNames[index]!);
    totalBytes += document.sizeBytes;
    if (totalBytes > CONNECTOR_ARTIFACT_MAX_BYTES) {
      throw new LcCheckerError(
        'PORT_MISCONFIGURED',
        `Legacy LC compliance requires every original PDF, but the ${CONNECTOR_ARTIFACT_MAX_BYTES}-byte connector attachment limit was exceeded`,
      );
    }
    documents.push(document);
  }
  return documents;
}

function usageSnapshot(response: { usage?: {
  inputTokens?: number;
  outputTokens?: number;
  pages?: number;
  costMicrousd?: number;
} | null }): UsageSnapshot {
  const usage = response.usage;
  if (!usage) return {};
  return {
    ...(Number.isSafeInteger(usage.inputTokens) && usage.inputTokens! >= 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(Number.isSafeInteger(usage.outputTokens) && usage.outputTokens! >= 0 ? { outputTokens: usage.outputTokens } : {}),
    ...(Number.isSafeInteger(usage.pages) && usage.pages! >= 0 ? { pages: usage.pages } : {}),
    ...(Number.isSafeInteger(usage.costMicrousd) && usage.costMicrousd! >= 0 ? { costUsd: usage.costMicrousd! / 1_000_000 } : {}),
  };
}

function addUsage(target: UsageTotals, source: UsageSnapshot): void {
  const addSafe = (key: 'inputTokens' | 'outputTokens' | 'pages', value: number | undefined): number => {
    if (value === undefined) return target[key];
    const next = target[key] + value;
    if (!Number.isSafeInteger(next)) throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC usage totals exceed the safe numeric range');
    target.sawUsage = true;
    if (key === 'pages') target.sawPages = true;
    target[key] = next;
    return next;
  };
  addSafe('inputTokens', source.inputTokens);
  addSafe('outputTokens', source.outputTokens);
  addSafe('pages', source.pages);
  if (source.costUsd !== undefined) {
    const micros = Math.round(source.costUsd * 1_000_000);
    const next = target.costMicrousd + micros;
    if (!Number.isSafeInteger(micros) || micros < 0 || !Number.isSafeInteger(next)) {
      throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC cost total exceeds the safe numeric range');
    }
    target.costMicrousd = next;
    target.sawCost = true;
    target.sawUsage = true;
  }
}

function renderUsage(totals: UsageTotals): Record<string, number> {
  if (!totals.sawUsage) return {};
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.sawPages ? { pages: totals.pages } : {}),
    ...(totals.sawCost ? { costUsd: totals.costMicrousd / 1_000_000 } : {}),
  };
}

function parseDeep(raw: unknown, depth = 0): unknown {
  if (depth > 12) return raw;
  if (typeof raw === 'string') {
    let trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json|javascript|js)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) trimmed = fenced[1].trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return parseDeep(JSON.parse(trimmed) as unknown, depth + 1);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  if (Array.isArray(raw)) return raw.map((value) => parseDeep(value, depth + 1));
  if (isRecord(raw)) {
    const parsed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) parsed[key] = parseDeep(value, depth + 1);
    return parsed;
  }
  return raw;
}

function promptText(value: Record<string, unknown>): string {
  const prompt = value['_prompt'];
  if (typeof prompt !== 'string') throw new LcCheckerError('INPUT_INVALID', 'Legacy LC prompt builder returned an invalid prompt');
  return prompt;
}

function legacyStepName(step: number, fileCount: number): string {
  if (step === 0) return `OCR chứng từ LC (${fileCount} file)`;
  if (step === 1) return 'Kiểm tra tuân thủ UCP 600 / ISBP 821';
  return 'Báo cáo Kiểm tra Chứng từ LC';
}

function initialCheckResult(): LCCheckResult {
  return {
    verdict: 'PENDING',
    total_discrepancies: 0,
    major_discrepancies: 0,
    minor_discrepancies: 0,
    advisory_count: 0,
    documents_present: [],
    documents_missing: [],
    discrepancies: [],
    summary: '',
    recommendation: 'RESERVE_FOR_REVIEW',
  };
}

async function runOcr(
  ctx: TaskContext,
  input: LegacyLcInput,
  sourceDocuments: readonly InlinedLegacyArtifact[],
  index: number,
): Promise<OcrOutcome> {
  const artifactId = input.artifactIds[index]!;
  const fileName = input.fileNames[index]!;
  try {
    const checkpoint = await ctx.step.run<OcrCheckpoint>(
      `legacy-lc:ocr:${String(index).padStart(2, '0')}`,
      contentHash({ artifactId, fileName, step: 'legacy-lc-ocr-v1' }),
      async () => {
        const response = await ctx.connector.invoke(LEGACY_OCR_SLOT, {
          prompt: promptText(buildOcrPrompt(fileName)),
          artifacts: [sourceDocuments[index]!],
        });
        if (response.state !== 'SUCCEEDED') {
          throw new LcCheckerError('PORT_MISCONFIGURED', 'The legacy OCR provider did not complete successfully', true);
        }
        const text = response.result?.content ?? '';
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > LEGACY_OCR_TEXT_MAX_BYTES) {
          throw new LcCheckerError('PORT_MISCONFIGURED', 'The legacy OCR result exceeds the bounded intermediate size');
        }
        // OCR text is user content. Only its encrypted artifact reference is
        // checkpointed; the runtime checkpoint never stores the text itself.
        const stored = await ctx.artifacts.write(
          text,
          `legacy-lc-ocr-${ctx.operationId}-${String(index).padStart(2, '0')}.txt`,
          'text/plain',
          'intermediate',
        );
        return {
          artifactId: stored.artifactId,
          characterCount: text.length,
          usage: usageSnapshot(response),
        };
      },
    );
    const text = (await ctx.artifacts.readWithMetadata(checkpoint.artifactId, { signal: ctx.signal })).buffer.toString('utf8');
    return { fileName, text, status: 'success', usage: checkpoint.usage };
  } catch (error: unknown) {
    if (ctx.cancelRequested || ctx.signal.aborted) throw error;
    return { fileName, text: '', status: 'error', error: 'OCR provider failed.', usage: {} };
  }
}

async function runWithConcurrency<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await task(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => runWorker()));
  return results;
}

function validateFinalResult(value: unknown): string {
  const parsed = LegacyWorkflowResultSchema.safeParse(value);
  if (!parsed.success) throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC result does not match the frozen compatibility contract');
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized, 'utf8') > LEGACY_RESULT_MAX_BYTES) {
    throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC result exceeds the 8 MiB result bound');
  }
  return serialized;
}

/**
 * Compatibility-only adapter for the original three-stage LC workflow.
 * The canonical lc-checker-input-v1 state machine remains untouched: this
 * branch uses its own profile-pinned slots and freezes the former OCR →
 * original-PDF hybrid compliance → report sequence.
 */
export async function legacyLcCheckerHandler(ctx: TaskContext): Promise<TaskDisposition> {
  assertActive(ctx);
  assertLegacySlots(ctx);
  const input = parseLegacyLcInput(ctx);
  const sourceDocuments = await loadOriginalDocuments(ctx, input);
  const usage: UsageTotals = {
    sawUsage: false,
    inputTokens: 0,
    outputTokens: 0,
    pages: 0,
    sawPages: false,
    costMicrousd: 0,
    sawCost: false,
  };

  await ctx.progress.report(5, 'Initializing workflow...');
  await ctx.progress.report(5, 'Legacy LC workflow: OCR documents');
  const ocrOutcomes = await runWithConcurrency(
    input.artifactIds.length,
    LEGACY_OCR_CONCURRENCY,
    (index) => runOcr(ctx, input, sourceDocuments, index),
  );
  let totalOcrBytes = 0;
  const ocrTexts = new Map<string, string>();
  for (const outcome of ocrOutcomes) {
    addUsage(usage, outcome.usage);
    const size = Buffer.byteLength(outcome.text, 'utf8');
    totalOcrBytes += size;
    if (totalOcrBytes > LEGACY_OCR_TEXT_MAX_BYTES) {
      throw new LcCheckerError('OUTPUT_INVALID', 'Combined legacy LC OCR text exceeds the bounded prompt size');
    }
    if (outcome.status === 'success' && outcome.text.length > 0) ocrTexts.set(outcome.fileName, outcome.text);
  }
  await ctx.progress.report(30, 'Legacy LC workflow: OCR stage complete');

  assertActive(ctx);
  await ctx.progress.report(35, 'Legacy LC workflow: compliance examination');
  const complianceResponse = await ctx.step.run(
    'legacy-lc:compliance',
    contentHash({
      artifactIds: input.artifactIds,
      fileNames: input.fileNames,
      ocrArtifactRefs: ocrOutcomes.map((outcome, index) => ({
        index,
        name: outcome.fileName,
        status: outcome.status,
        size: Buffer.byteLength(outcome.text, 'utf8'),
      })),
      step: 'legacy-lc-compliance-v1',
    }),
    async () => {
      const response = await ctx.connector.invoke(LEGACY_COMPLIANCE_SLOT, {
        prompt: promptText(buildComplianceCheckPrompt(input.fileNames.length, ocrTexts)),
        artifacts: sourceDocuments,
      });
      if (response.state !== 'SUCCEEDED') {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The legacy compliance provider did not complete successfully', true);
      }
      const content = response.result?.content ?? '';
      if (Buffer.byteLength(content, 'utf8') > LEGACY_RESULT_MAX_BYTES) {
        throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC compliance output exceeds the bounded result size');
      }
      const stored = await ctx.artifacts.write(
        content,
        `legacy-lc-compliance-${ctx.operationId}.json`,
        'application/json',
        'intermediate',
      );
      return { artifactId: stored.artifactId, usage: usageSnapshot(response) };
    },
  );
  const complianceText = (await ctx.artifacts.readWithMetadata(complianceResponse.artifactId, { signal: ctx.signal })).buffer.toString('utf8');
  let checkResult = initialCheckResult();
  if (complianceText.length > 0) checkResult = parseDeep(complianceText) as LCCheckResult;
  if (!isRecord(checkResult) && !Array.isArray(checkResult)) {
    throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC compliance provider returned an invalid result');
  }
  addUsage(usage, complianceResponse.usage);
  await ctx.progress.report(80, 'Legacy LC workflow: compliance stage complete');

  assertActive(ctx);
  await ctx.progress.report(85, 'Legacy LC workflow: generating report');
  const reportCheckpoint = await ctx.step.run(
    'legacy-lc:report',
    contentHash({
      fileCount: input.fileNames.length,
      complianceArtifactId: complianceResponse.artifactId,
      step: 'legacy-lc-report-v1',
    }),
    async () => {
      const response = await ctx.connector.invoke(LEGACY_REPORT_SLOT, {
        prompt: promptText(buildReportPrompt(input.fileNames.length, checkResult as LCCheckResult)),
      });
      if (response.state !== 'SUCCEEDED') {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The legacy report provider did not complete successfully', true);
      }
      const report = response.result?.content ?? '';
      if (Buffer.byteLength(report, 'utf8') > LEGACY_RESULT_MAX_BYTES) {
        throw new LcCheckerError('OUTPUT_INVALID', 'Legacy LC report exceeds the bounded result size');
      }
      const stored = await ctx.artifacts.write(
        report,
        `legacy-lc-report-${ctx.operationId}.md`,
        'text/markdown',
        'intermediate',
      );
      return { artifactId: stored.artifactId, usage: usageSnapshot(response) };
    },
  );
  const finalReport = (await ctx.artifacts.readWithMetadata(reportCheckpoint.artifactId, { signal: ctx.signal })).buffer.toString('utf8');
  addUsage(usage, reportCheckpoint.usage);
  await ctx.progress.report(95, 'Legacy LC workflow: report ready');

  const pipelineSteps = [
    {
      step: 0,
      stepName: legacyStepName(0, input.fileNames.length),
      processor: 'ext-doc-layout',
      content_preview: JSON.stringify(ocrOutcomes.map((outcome) => ({
        file: outcome.fileName,
        status: outcome.status,
        ocr_chars: outcome.text.length,
      }))),
      extracted_data: null,
    },
    {
      step: 1,
      stepName: legacyStepName(1, input.fileNames.length),
      processor: 'ext-fact-verifier',
      content_preview: JSON.stringify(checkResult),
      extracted_data: checkResult,
    },
    {
      step: 2,
      stepName: legacyStepName(2, input.fileNames.length),
      processor: 'ext-content-gen',
      content_preview: finalReport || null,
      extracted_data: null,
    },
  ];
  const serialized = validateFinalResult({
    schemaVersion: 'legacy-workflow-result-v1',
    outputFormat: 'json',
    content: finalReport,
    extractedData: checkResult,
    pipelineSteps,
    usage: renderUsage(usage),
  });
  await ctx.progress.report(100, 'Legacy LC workflow complete');
  return { kind: 'completed', resultRef: serialized };
}
