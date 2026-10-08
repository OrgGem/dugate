import { createHash } from 'node:crypto';
import {
  CONNECTOR_ARTIFACT_MAX_BYTES,
  LegacyWorkflowResultSchema,
  contentHash,
  type InvocationArtifactContent,
  type InvocationResponse,
  type TaskDisposition,
} from '@du/contracts';
import type { TaskContext } from '@du/worker-sdk';
import { applyPinnedStepPrompt } from '../../actions/prompt-application';

const LEGACY_INPUT_VERSION = 'legacy-workflow-named-input-v1';
const RESULT_VERSION = 'legacy-workflow-result-v1';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const PREVIEW_CHARS = 512;
const REQUIRED_SLOTS = ['legacy-ocr', 'legacy-toc', 'legacy-compare', 'legacy-report'] as const;

interface LegacyNamedInput {
  readonly legacyWorkflow: { readonly version: string; readonly process: string };
  readonly variables: Record<string, unknown>;
  readonly artifactIds: string[];
  readonly fileNames: string[];
  readonly artifacts: { artifactId: string; role: string }[];
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
  hasPages: boolean;
  hasCost: boolean;
}

interface OcrOutcome {
  readonly fileName: string;
  readonly text: string;
  readonly usage?: NonNullable<InvocationResponse['usage']>;
}

interface JsonOutcome<T> {
  readonly content: string;
  readonly data: T;
  readonly usage?: NonNullable<InvocationResponse['usage']>;
}

export class LegacyNamedDocCompareError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LegacyNamedDocCompareError';
  }
}

/** Run the historical OCR → TOC → section compare → report chain durably. */
export async function handleLegacyNamedDocCompare(
  context: TaskContext,
  raw: Record<string, unknown>,
): Promise<TaskDisposition> {
  const input = validateInput(raw);
  if (input.artifactIds.length < 2) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_FILE_COUNT_INVALID', 'Doc-compare requires at least two uploaded documents.');
  }
  assertActive(context);
  for (const slot of REQUIRED_SLOTS) {
    if (typeof context.connectorBindings[slot] !== 'string' || context.connectorBindings[slot]!.trim() === '') {
      throw new LegacyNamedDocCompareError('DOC_COMPARE_CONNECTOR_SLOT_MISSING', 'A required legacy doc-compare connector is not bound.');
    }
  }

  const docs = await Promise.all([0, 1].map((index) => readSourceArtifact(context, input, index)));
  const usage = emptyUsage();

  const ocrOutcomes = await Promise.all(docs.map(async (doc, index) => {
    const prompt = applyPinnedStepPrompt(context, {
      slot: 'legacy-ocr',
      stepId: 'doc-compare/legacy/ocr',
      defaultText: `Convert the entire uploaded document "${doc.fileName}" into faithful Markdown. Preserve headings, tables, lists, and numbering. Do not add commentary.`,
    });
    const response = await invokeCheckpointed(context, `ocr-${index}`, 'legacy-ocr', {
      task: 'extract_document_text',
      prompt,
      artifacts: [doc.artifact],
    }, { responseFormat: 'text' });
    const text = response.result?.content;
    if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      throw new LegacyNamedDocCompareError('DOC_COMPARE_OCR_OUTPUT_INVALID', 'A document could not be converted to bounded text.');
    }
    addUsage(usage, response.usage);
    return { fileName: doc.fileName, text, ...(response.usage ? { usage: response.usage } : {}) } satisfies OcrOutcome;
  }));

  const tocPrompt = applyPinnedStepPrompt(context, {
    slot: 'legacy-toc',
    stepId: 'doc-compare/legacy/toc',
    defaultText: buildTocPrompt(ocrOutcomes[0]!, ocrOutcomes[1]!),
  });
  const tocOutcome = await invokeJsonCheckpointed<TocResult>(context, 'toc', 'legacy-toc', {
    task: 'extract_document_toc', prompt: tocPrompt,
  });
  validateToc(tocOutcome.data, ocrOutcomes[0]!.fileName, ocrOutcomes[1]!.fileName);
  addUsage(usage, tocOutcome.usage);

  const comparePrompt = applyPinnedStepPrompt(context, {
    slot: 'legacy-compare',
    stepId: 'doc-compare/legacy/compare',
    defaultText: buildComparePrompt(tocOutcome.data, ocrOutcomes[0]!, ocrOutcomes[1]!),
  });
  const compareOutcome = await invokeJsonCheckpointed<ComparisonResult>(context, 'section-compare', 'legacy-compare', {
    task: 'compare_document_sections', prompt: comparePrompt,
  });
  validateComparison(compareOutcome.data, ocrOutcomes[0]!.fileName, ocrOutcomes[1]!.fileName);
  addUsage(usage, compareOutcome.usage);

  const reportPrompt = applyPinnedStepPrompt(context, {
    slot: 'legacy-report',
    stepId: 'doc-compare/legacy/report',
    defaultText: buildReportPrompt(compareOutcome.data),
  });
  const reportResponse = await invokeCheckpointed(context, 'report', 'legacy-report', {
    task: 'generate_document_comparison_report', prompt: reportPrompt,
  }, { responseFormat: 'text' });
  const report = reportResponse.result?.content;
  if (typeof report !== 'string' || report.trim().length === 0 || Buffer.byteLength(report, 'utf8') > MAX_TEXT_BYTES) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_REPORT_INVALID', 'Doc-compare did not produce a bounded report.');
  }
  addUsage(usage, reportResponse.usage);

  const pipelineSteps = [
    {
      step: 0,
      stepName: 'OCR documents',
      processor: 'ext-doc-layout',
      content_preview: JSON.stringify(ocrOutcomes.map((row) => ({ file: row.fileName, status: 'success', ocr_chars: row.text.length })), null, 0).slice(0, PREVIEW_CHARS),
      extracted_data: null,
    },
    {
      step: 1,
      stepName: 'Extract both tables of contents',
      processor: 'ext-doc-compare',
      content_preview: tocOutcome.content.slice(0, PREVIEW_CHARS),
      extracted_data: tocOutcome.data,
    },
    {
      step: 2,
      stepName: 'Compare corresponding sections',
      processor: 'ext-doc-compare',
      content_preview: compareOutcome.content.slice(0, PREVIEW_CHARS),
      extracted_data: compareOutcome.data,
    },
    {
      step: 3,
      stepName: 'Generate comparison report',
      processor: 'ext-content-gen',
      content_preview: report.slice(0, PREVIEW_CHARS),
      extracted_data: null,
    },
  ];
  const result = {
    schemaVersion: RESULT_VERSION,
    outputFormat: 'md',
    content: report,
    extractedData: compareOutcome.data,
    pipelineSteps,
    usage: usageToResult(usage),
  };
  const checked = LegacyWorkflowResultSchema.safeParse(result);
  const serialized = JSON.stringify(result);
  if (!checked.success || Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_RESULT_INVALID', 'Doc-compare result exceeds its supported contract.');
  }
  await context.progress.report(100, 'Legacy doc-compare complete');
  return { kind: 'completed', resultRef: serialized };
}

function validateInput(raw: Record<string, unknown>): LegacyNamedInput {
  const legacyWorkflow = raw.legacyWorkflow;
  const variables = raw.variables;
  const artifactIds = raw.artifactIds;
  const fileNames = raw.fileNames;
  const artifacts = raw.artifacts;
  if (!isRecord(legacyWorkflow) || legacyWorkflow.version !== LEGACY_INPUT_VERSION || legacyWorkflow.process !== 'doc-compare'
      || !isRecord(variables) || Object.keys(variables).length > 0
      || !Array.isArray(artifactIds) || !artifactIds.every(isUuid)
      || !Array.isArray(fileNames) || !fileNames.every((name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 255)
      || !Array.isArray(artifacts) || !artifacts.every((item) => isRecord(item) && isUuid(item.artifactId) && typeof item.role === 'string')) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_INPUT_INVALID', 'Legacy doc-compare input is invalid.');
  }
  if (artifactIds.length !== fileNames.length || artifactIds.length > 64
      || new Set(artifactIds).size !== artifactIds.length
      || artifacts.some((item) => !artifactIds.includes((item as { artifactId: string }).artifactId))) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_INPUT_INVALID', 'Legacy doc-compare file references are inconsistent.');
  }
  return { legacyWorkflow, variables, artifactIds, fileNames, artifacts } as unknown as LegacyNamedInput;
}

async function readSourceArtifact(
  context: TaskContext,
  input: LegacyNamedInput,
  index: number,
): Promise<{ fileName: string; artifact: InvocationArtifactContent }> {
  const artifactId = input.artifactIds[index]!;
  const fileName = safeFileName(input.fileNames[index]!);
  let source: Awaited<ReturnType<TaskContext['artifacts']['readWithMetadata']>>;
  try {
    source = await context.artifacts.readWithMetadata(artifactId, { signal: context.signal });
  } catch {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_ARTIFACT_UNAVAILABLE', 'A document could not be read from the admitted artifact set.');
  }
  const sha256 = createHash('sha256').update(source.buffer).digest('hex');
  if (source.buffer.byteLength < 1 || source.buffer.byteLength > CONNECTOR_ARTIFACT_MAX_BYTES
      || source.sizeBytes !== source.buffer.byteLength || source.sha256 !== sha256
      || typeof source.storageVersionId !== 'string' || source.storageVersionId.length === 0) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_ARTIFACT_INVALID', 'A document failed its artifact integrity check.');
  }
  const mimeType = normalizeMimeType(source.mimeType ?? 'application/octet-stream');
  return {
    fileName,
    artifact: {
      artifactId,
      fileName,
      mimeType,
      sizeBytes: source.buffer.byteLength,
      sha256,
      storageVersionId: source.storageVersionId,
      contentBase64: source.buffer.toString('base64'),
    },
  };
}

async function invokeJsonCheckpointed<T>(
  context: TaskContext,
  step: string,
  slot: string,
  input: Record<string, unknown>,
): Promise<JsonOutcome<T>> {
  const response = await invokeCheckpointed(context, step, slot, input, { responseFormat: 'json' });
  const raw = response.result?.data ?? response.result?.content;
  const data = parseJson<T>(raw);
  if (data === undefined) throw new LegacyNamedDocCompareError('DOC_COMPARE_CONNECTOR_OUTPUT_INVALID', 'A comparison stage did not return valid JSON.');
  const content = typeof response.result?.content === 'string' ? response.result.content : JSON.stringify(data);
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new LegacyNamedDocCompareError('DOC_COMPARE_CONNECTOR_OUTPUT_TOO_LARGE', 'A comparison stage returned oversized output.');
  return { content, data, ...(response.usage ? { usage: response.usage } : {}) };
}

async function invokeCheckpointed(
  context: TaskContext,
  step: string,
  slot: string,
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<InvocationResponse> {
  const stepKey = `legacy-doc-compare:v1:${step}`;
  const inputHash = contentHash({ slot, input, options });
  const response = await context.step.run<InvocationResponse>(stepKey, inputHash, async () => {
    assertActive(context);
    try {
      return await context.connector.invoke(slot, input, options);
    } catch {
      throw new LegacyNamedDocCompareError('DOC_COMPARE_CONNECTOR_FAILED', 'A required legacy doc-compare connector failed.');
    }
  });
  if (response.state !== 'SUCCEEDED' || !response.result) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_CONNECTOR_FAILED', 'A required legacy doc-compare stage did not complete.');
  }
  return response;
}

interface TocSection { number: string; title: string; level: number; children: TocSection[] }
interface TocResult { doc1_name: string; doc1_toc: TocSection[]; doc2_name: string; doc2_toc: TocSection[] }
interface SectionResult {
  section_id: string;
  type: 'unchanged' | 'modified' | 'added' | 'removed';
  doc1_section?: { number: string; title: string; content_summary: string };
  doc2_section?: { number: string; title: string; content_summary: string };
  changes: string[];
  significance: 'high' | 'medium' | 'low';
}
interface ComparisonResult {
  doc1_name: string;
  doc2_name: string;
  summary: string;
  total_sections_doc1: number;
  total_sections_doc2: number;
  matched_count: number;
  added_count: number;
  removed_count: number;
  modified_count: number;
  unchanged_count: number;
  sections: SectionResult[];
}

function buildTocPrompt(doc1: OcrOutcome, doc2: OcrOutcome): string {
  return `Extract a hierarchical table of contents from each full document. Preserve numbered section labels; assign sequential numbers where none exist. Return JSON only with doc1_name, doc1_toc, doc2_name, and doc2_toc. Each section has number, title, integer level, and children.\n\nDOCUMENT 1 (${doc1.fileName}):\n${doc1.text}\n\nDOCUMENT 2 (${doc2.fileName}):\n${doc2.text}`;
}

function buildComparePrompt(toc: TocResult, doc1: OcrOutcome, doc2: OcrOutcome): string {
  return `Compare corresponding sections using both tables of contents and the full document text. Classify every section as unchanged, modified, added, or removed. Include section_id, optional doc1_section/doc2_section summaries, changes, and significance (high, medium, low). Return JSON only with doc1_name, doc2_name, summary, total_sections_doc1, total_sections_doc2, matched_count, added_count, removed_count, modified_count, unchanged_count, and sections.\n\nTABLES OF CONTENTS:\n${JSON.stringify(toc)}\n\nDOCUMENT 1 (${doc1.fileName}):\n${doc1.text}\n\nDOCUMENT 2 (${doc2.fileName}):\n${doc2.text}`;
}

function buildReportPrompt(result: ComparisonResult): string {
  return `Write a complete professional Markdown document-comparison report in Vietnamese based on this verified comparison. Include document names, overall summary, counts, significant changes, added and removed sections, a table of all sections, and recommendations. Do not invent findings.\n\n${JSON.stringify(result)}`;
}

function validateToc(value: TocResult, doc1: string, doc2: string): void {
  if (!isRecord(value) || value.doc1_name !== doc1 || value.doc2_name !== doc2
      || !Array.isArray(value.doc1_toc) || !Array.isArray(value.doc2_toc)) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_TOC_INVALID', 'The table-of-contents stage returned an invalid document structure.');
  }
  let count = 0;
  const stack = [...value.doc1_toc, ...value.doc2_toc];
  while (stack.length > 0) {
    const row = stack.pop();
    count += 1;
    if (count > 4096 || !isRecord(row) || typeof row.number !== 'string' || typeof row.title !== 'string'
        || !Number.isInteger(row.level) || !Array.isArray(row.children)) {
      throw new LegacyNamedDocCompareError('DOC_COMPARE_TOC_INVALID', 'The table-of-contents stage returned an invalid document structure.');
    }
    stack.push(...row.children);
  }
}

function validateComparison(value: ComparisonResult, doc1: string, doc2: string): void {
  const countKeys = ['total_sections_doc1', 'total_sections_doc2', 'matched_count', 'added_count', 'removed_count', 'modified_count', 'unchanged_count'] as const;
  if (!isRecord(value) || value.doc1_name !== doc1 || value.doc2_name !== doc2 || typeof value.summary !== 'string'
      || !countKeys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
      || !Array.isArray(value.sections) || value.sections.length > 4096) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_COMPARISON_INVALID', 'The section-comparison stage returned invalid evidence.');
  }
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.section_id !== 'string'
        || !['unchanged', 'modified', 'added', 'removed'].includes(String(section.type))
        || !Array.isArray(section.changes) || !section.changes.every((item) => typeof item === 'string')
        || !['high', 'medium', 'low'].includes(String(section.significance))) {
      throw new LegacyNamedDocCompareError('DOC_COMPARE_COMPARISON_INVALID', 'The section-comparison stage returned invalid evidence.');
    }
  }
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string') return isRecord(raw) || Array.isArray(raw) ? raw as T : undefined;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

function addUsage(target: UsageTotals, usage: InvocationResponse['usage']): void {
  if (!usage) return;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.costMicrousd += usage.costMicrousd;
  if (usage.pages !== undefined) {
    target.pages += usage.pages;
    target.hasPages = true;
  }
  if (usage.costMicrousd > 0) target.hasCost = true;
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, pages: 0, costMicrousd: 0, hasPages: false, hasCost: false };
}

function usageToResult(usage: UsageTotals) {
  return {
    ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.hasPages ? { pages: usage.pages } : {}),
    ...(usage.hasCost ? { costUsd: usage.costMicrousd / 1_000_000 } : {}),
  };
}

function normalizeMimeType(value: string): string {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) && value.length <= 127 ? value : 'application/octet-stream';
}

function safeFileName(value: string): string {
  const result = value.normalize('NFC').replace(/[\\/\0-\x1f\x7f]/g, '_').trim();
  if (result.length === 0 || result === '.' || result === '..' || result.length > 255) {
    throw new LegacyNamedDocCompareError('DOC_COMPARE_FILENAME_INVALID', 'A document filename is invalid.');
  }
  return result;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertActive(context: TaskContext): void {
  if (context.signal.aborted || context.cancelRequested) {
    throw new LegacyNamedDocCompareError('OPERATION_CANCELLED', 'Workflow execution was cancelled.');
  }
}
