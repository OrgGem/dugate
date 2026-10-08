import {
  CONNECTOR_ARTIFACT_MAX_BYTES,
  LegacyWorkflowResultSchema,
  contentHash,
  type InvocationArtifactContent,
  type InvocationResponse,
  type TaskDisposition,
} from '@du/contracts';
import type { TaskContext } from '@du/worker-sdk';
import { createHash } from 'node:crypto';
import { applyPinnedStepPrompt } from '../../actions/prompt-application';

const LEGACY_INPUT_VERSION = 'legacy-workflow-named-input-v1';
const RESULT_VERSION = 'legacy-workflow-result-v1';
const MAX_CONNECTOR_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_AGGREGATE_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20;
const PREVIEW_CHARS = 512;
const MAX_PARALLEL_FILES = 4;
const REQUIRED_SLOTS = ['classify', 'extract', 'crosscheck', 'report'] as const;
const RESUME_SCHEMA_VERSION = 'legacy-disbursement-review-v1';

interface LegacyNamedInput {
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

interface FileArtifact {
  readonly artifactId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageVersionId: string;
  readonly contentBase64: string;
}

interface StageOutcome {
  readonly content: string;
  readonly data: unknown;
  readonly usage?: NonNullable<InvocationResponse['usage']>;
}

interface ClassifiedFile {
  readonly fileName: string;
  readonly classifyData: Record<string, unknown>;
  readonly logicalDocuments: readonly Record<string, unknown>[];
}

interface ExtractedFile {
  readonly file_name: string;
  readonly logical_docs: readonly string[];
  readonly status: 'success';
  readonly content: string;
  readonly extracted_data: unknown;
}

export class LegacyNamedDisbursementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LegacyNamedDisbursementError';
  }
}

/** Execute the old classify → extract → human review → cross-check → report process. */
export async function handleLegacyNamedDisbursement(
  context: TaskContext,
  raw: Record<string, unknown>,
): Promise<TaskDisposition> {
  const input = validateInput(raw);
  assertActive(context);
  for (const slot of REQUIRED_SLOTS) {
    if (typeof context.connectorBindings[slot] !== 'string' || context.connectorBindings[slot]!.trim() === '') {
      throw new LegacyNamedDisbursementError('DISBURSEMENT_CONNECTOR_SLOT_MISSING', 'A required legacy disbursement connector is not bound.');
    }
  }

  await context.progress.report(8, 'Legacy disbursement: classification');
  const classified = await mapBounded(input.artifactIds, MAX_PARALLEL_FILES, async (_artifactId, index) => {
    const file = await readSourceArtifact(context, input, index);
    const prompt = applyPinnedStepPrompt(context, {
      slot: 'classify',
      stepId: 'disbursement:classify:v1',
      defaultText: buildClassifyPrompt(file.fileName),
    });
    const outcome = await invokeJsonCheckpointed(context, `classify-${index}`, 'classify', {
      task: 'classify_document',
      prompt,
      artifacts: [file],
    });
    const classifiedFile = parseClassifyOutcome(outcome.data, file.fileName);
    return { file: classifiedFile, usage: outcome.usage };
  });
  const classifications = classified.map((entry) => entry.file);
  const classifyUsage = classified.flatMap((entry) => entry.usage ? [entry.usage] : []);

  await context.progress.report(32, 'Legacy disbursement: extraction');
  const extracted = await mapBounded(input.artifactIds, MAX_PARALLEL_FILES, async (_artifactId, index) => {
    const file = await readSourceArtifact(context, input, index);
    const classification = classifications[index]!;
    const prompt = applyPinnedStepPrompt(context, {
      slot: 'extract',
      stepId: 'disbursement:extract:v1',
      defaultText: buildExtractPrompt(file.fileName, classification.logicalDocuments),
    });
    const outcome = await invokeJsonCheckpointed(context, `extract-${index}`, 'extract', {
      task: 'extract_document_data',
      prompt,
      artifacts: [file],
    });
    return { fileName: file.fileName, outcome };
  });
  let extractionResults: readonly ExtractedFile[] = extracted.map(({ fileName, outcome }, index) => ({
    file_name: fileName,
    logical_docs: classifications[index]!.logicalDocuments.map((document) => String(document.label)),
    status: 'success',
    content: outcome.content,
    extracted_data: outcome.data,
  }));
  assertAggregateEvidence(classifications, extractionResults);

  const resume = readResume(context, raw);
  if (resume === undefined) {
    const evidence = JSON.stringify({ classifications, extractionResults });
    if (Buffer.byteLength(evidence, 'utf8') > MAX_AGGREGATE_EVIDENCE_BYTES) {
      throw new LegacyNamedDisbursementError('DISBURSEMENT_EVIDENCE_TOO_LARGE', 'Disbursement review evidence exceeds the supported limit.');
    }
    let evidenceArtifact: Awaited<ReturnType<TaskContext['artifacts']['write']>>;
    try {
      evidenceArtifact = await context.artifacts.write(
        evidence,
        'disbursement-review-evidence.json',
        'application/json',
        'intermediate',
      );
    } catch {
      throw new LegacyNamedDisbursementError('DISBURSEMENT_EVIDENCE_WRITE_FAILED', 'Disbursement review evidence could not be persisted.');
    }
    assertActive(context);
    return context.wait.waitForInput(
      RESUME_SCHEMA_VERSION,
      {
        type: 'object',
        properties: {
          step: { type: 'integer', const: 1 },
          extracted_data: {},
          approved: { type: 'boolean' },
          note: { type: 'string', maxLength: 4000 },
        },
        additionalProperties: false,
      },
      { contextRef: `artifact://${evidenceArtifact.artifactId}` },
    );
  }

  const resumeInput = validateResume(resume);
  if (resumeInput.approved === false) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_REJECTED', 'The human reviewer did not approve the extracted evidence.');
  }
  if (resumeInput.extractedData !== undefined) {
    extractionResults = validateEditedExtraction(resumeInput.extractedData, input, classifications);
    assertAggregateEvidence(classifications, extractionResults);
  }

  await context.progress.report(64, 'Legacy disbursement: cross-check');
  const crosscheckPrompt = applyPinnedStepPrompt(context, {
    slot: 'crosscheck',
    stepId: 'disbursement:crosscheck:v1',
    defaultText: buildCrosscheckPrompt(extractionResults, input.variables.resolution_data),
  });
  const crosscheckOutcome = await invokeJsonCheckpointed(context, 'crosscheck', 'crosscheck', {
    task: 'crosscheck_disbursement_documents',
    prompt: crosscheckPrompt,
  });
  const crosscheck = validateCrosscheck(crosscheckOutcome.data);

  await context.progress.report(84, 'Legacy disbursement: report');
  const reportPrompt = applyPinnedStepPrompt(context, {
    slot: 'report',
    stepId: 'disbursement:report:v1',
    defaultText: buildReportPrompt(classifications, extractionResults, crosscheck),
  });
  const reportOutcome = await invokeCheckpointed(context, 'report', 'report', {
    task: 'generate_disbursement_report',
    prompt: reportPrompt,
  }, { responseFormat: 'text' });
  const report = reportOutcome.result?.content;
  if (typeof report !== 'string' || report.trim().length === 0 || Buffer.byteLength(report, 'utf8') > MAX_CONNECTOR_TEXT_BYTES) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REPORT_INVALID', 'Disbursement did not produce a bounded report.');
  }

  const usage = emptyUsage();
  for (const item of classifyUsage) addUsage(usage, item);
  for (const item of extracted) addUsage(usage, item.outcome.usage);
  addUsage(usage, crosscheckOutcome.usage);
  addUsage(usage, reportOutcome.usage);

  const result = {
    schemaVersion: RESULT_VERSION,
    outputFormat: 'md',
    content: report,
    extractedData: crosscheck,
    pipelineSteps: [
      {
        step: 0,
        stepName: `Classify ${classifications.length} file(s)`,
        processor: 'ext-classifier',
        content_preview: JSON.stringify(classifications.map((entry) => ({
          file: entry.fileName,
          status: 'success',
          docs: entry.logicalDocuments.length,
        }))).slice(0, PREVIEW_CHARS),
        extracted_data: toMergedClassification(classifications),
      },
      {
        step: 1,
        stepName: `Extract ${extractionResults.length} file(s)`,
        processor: 'ext-data-extractor',
        content_preview: JSON.stringify(extractionResults.map((entry) => ({
          file: entry.file_name,
          docs: entry.logical_docs,
          status: entry.status,
        }))).slice(0, PREVIEW_CHARS),
        extracted_data: extractionResults,
      },
      {
        step: 2,
        stepName: 'Cross-check extracted evidence',
        processor: 'ext-fact-verifier',
        content_preview: JSON.stringify(crosscheck).slice(0, PREVIEW_CHARS),
        extracted_data: crosscheck,
      },
      {
        step: 3,
        stepName: 'Generate disbursement report',
        processor: 'ext-content-gen',
        content_preview: report.slice(0, PREVIEW_CHARS),
        extracted_data: null,
      },
    ],
    usage: usageToResult(usage),
  };
  const resultJson = JSON.stringify(result);
  if (!LegacyWorkflowResultSchema.safeParse(result).success || Buffer.byteLength(resultJson, 'utf8') > MAX_RESULT_BYTES) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_RESULT_INVALID', 'Disbursement result exceeds its supported contract.');
  }
  await context.progress.report(100, 'Legacy disbursement complete');
  return { kind: 'completed', resultRef: resultJson };
}

function validateInput(raw: Record<string, unknown>): LegacyNamedInput {
  const marker = raw.legacyWorkflow;
  const variables = raw.variables;
  const artifactIds = raw.artifactIds;
  const fileNames = raw.fileNames;
  const artifacts = raw.artifacts;
  if (!isRecord(marker) || marker.version !== LEGACY_INPUT_VERSION || marker.process !== 'disbursement'
      || !isRecord(variables) || Object.keys(variables).some((key) => key !== 'resolution_data')
      || variables.resolution_data !== undefined && (typeof variables.resolution_data !== 'string' || Buffer.byteLength(variables.resolution_data, 'utf8') > 100_000)
      || !Array.isArray(artifactIds) || !artifactIds.every(isUuid)
      || !Array.isArray(fileNames) || !fileNames.every((name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 255)
      || !Array.isArray(artifacts) || !artifacts.every((item) => isRecord(item) && isUuid(item.artifactId) && typeof item.role === 'string' && item.role.length <= 128)) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_INPUT_INVALID', 'Legacy disbursement input is invalid.');
  }
  if (artifactIds.length < 1 || artifactIds.length > MAX_FILES || fileNames.length !== artifactIds.length
      || artifacts.length !== artifactIds.length || new Set(artifactIds).size !== artifactIds.length
      || artifacts.some((item, index) => !isRecord(item) || item.artifactId !== artifactIds[index])) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_INPUT_INVALID', 'Legacy disbursement file references are inconsistent.');
  }
  return { variables, artifactIds: artifactIds as string[], fileNames: fileNames as string[], artifacts: artifacts as LegacyNamedInput['artifacts'] };
}

async function readSourceArtifact(context: TaskContext, input: LegacyNamedInput, index: number): Promise<FileArtifact> {
  const artifactId = input.artifactIds[index]!;
  const fileName = safeFileName(input.fileNames[index]!);
  let source: Awaited<ReturnType<TaskContext['artifacts']['readWithMetadata']>>;
  try {
    source = await context.artifacts.readWithMetadata(artifactId, { signal: context.signal });
  } catch {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_ARTIFACT_UNAVAILABLE', 'An admitted source document could not be read.');
  }
  const sha256 = createHash('sha256').update(source.buffer).digest('hex');
  if (source.buffer.byteLength < 1 || source.buffer.byteLength > CONNECTOR_ARTIFACT_MAX_BYTES
      || source.sizeBytes !== source.buffer.byteLength || source.sha256 !== sha256
      || typeof source.storageVersionId !== 'string' || source.storageVersionId.length === 0) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_ARTIFACT_INVALID', 'An admitted source document failed its integrity check.');
  }
  return {
    artifactId,
    fileName,
    mimeType: normalizeMimeType(source.mimeType ?? 'application/octet-stream'),
    sizeBytes: source.buffer.byteLength,
    sha256,
    storageVersionId: source.storageVersionId,
    contentBase64: source.buffer.toString('base64'),
  };
}

async function invokeJsonCheckpointed(
  context: TaskContext,
  step: string,
  slot: string,
  input: Record<string, unknown>,
): Promise<StageOutcome> {
  const response = await invokeCheckpointed(context, step, slot, input, { responseFormat: 'json' });
  const parsed = parseJson(response.result?.data ?? response.result?.content);
  const content = typeof response.result?.content === 'string' ? response.result.content : JSON.stringify(parsed);
  if (parsed === undefined || Buffer.byteLength(content, 'utf8') > MAX_CONNECTOR_TEXT_BYTES) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', `The ${slot} connector returned invalid or oversized output.`);
  }
  return { content, data: parsed, ...(response.usage ? { usage: response.usage } : {}) };
}

async function invokeCheckpointed(
  context: TaskContext,
  step: string,
  slot: string,
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<InvocationResponse> {
  const stepKey = `legacy-disbursement:v1:${step}`;
  const inputHash = contentHash({ slot, input, options });
  const response = await context.step.run<InvocationResponse>(stepKey, inputHash, async () => {
    assertActive(context);
    try {
      return await context.connector.invoke(slot, input, options);
    } catch {
      throw new LegacyNamedDisbursementError('DISBURSEMENT_CONNECTOR_FAILED', `The required ${slot} connector failed.`);
    }
  });
  if (response.state !== 'SUCCEEDED' || !response.result) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_CONNECTOR_FAILED', `The required ${slot} stage did not complete.`);
  }
  return response;
}

function parseClassifyOutcome(raw: unknown, fileName: string): ClassifiedFile {
  if (!isRecord(raw)) throw new LegacyNamedDisbursementError('DISBURSEMENT_CLASSIFICATION_INVALID', 'Classification output is malformed.');
  const data: Record<string, unknown> = { ...raw };
  const rows = Array.isArray(data.logical_documents) ? data.logical_documents : [];
  const logicalDocuments = rows.length > 0
    ? rows.map((row, index) => {
        if (!isRecord(row) || typeof row.label !== 'string' || row.label.trim().length === 0
            || typeof row.pages !== 'string' || row.pages.length > 256
            || row.confidence !== undefined && (typeof row.confidence !== 'number' || row.confidence < 0 || row.confidence > 1)) {
          throw new LegacyNamedDisbursementError('DISBURSEMENT_CLASSIFICATION_INVALID', 'Classification output contains an invalid document row.');
        }
        return {
          ...row,
          id: typeof row.id === 'string' && row.id.length > 0 ? row.id : `legacy-${index + 1}`,
          source_file: typeof row.source_file === 'string' && row.source_file.length > 0 ? row.source_file : fileName,
        };
      })
    : [{
        id: `auto-${fileName.replace(/\W/g, '_')}`,
        label: typeof data.document_type === 'string' && data.document_type.length > 0 ? data.document_type : 'Document',
        pages: 'all',
        confidence: typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : 1,
        source_file: fileName,
      }];
  data.logical_documents = logicalDocuments;
  return { fileName, classifyData: data, logicalDocuments };
}

function validateCrosscheck(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new LegacyNamedDisbursementError('DISBURSEMENT_CROSSCHECK_INVALID', 'Cross-check output is malformed.');
  if (raw.verdict !== undefined && !['PASS', 'FAIL', 'WARNING'].includes(String(raw.verdict))) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_CROSSCHECK_INVALID', 'Cross-check verdict is invalid.');
  }
  if (raw.score !== undefined && (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100)) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_CROSSCHECK_INVALID', 'Cross-check score is invalid.');
  }
  if (raw.checks !== undefined && (!Array.isArray(raw.checks) || raw.checks.length > 1000 || !raw.checks.every((item) =>
      isRecord(item) && typeof item.rule === 'string' && ['PASS', 'FAIL', 'WARNING'].includes(String(item.status))))
      || raw.discrepancies !== undefined && (!Array.isArray(raw.discrepancies) || raw.discrepancies.length > 1000 || !raw.discrepancies.every((item) => typeof item === 'string'))) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_CROSSCHECK_INVALID', 'Cross-check findings are invalid.');
  }
  return raw;
}

function validateEditedExtraction(raw: unknown, input: LegacyNamedInput, classifications: readonly ClassifiedFile[]): readonly ExtractedFile[] {
  if (!Array.isArray(raw) || raw.length !== input.artifactIds.length) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Reviewed extraction data must contain one row per uploaded file.');
  }
  return raw.map((value, index) => {
    if (!isRecord(value) || value.file_name !== input.fileNames[index] || value.status !== 'success'
        || !Array.isArray(value.logical_docs) || !isRecord(value.extracted_data)) {
      throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Reviewed extraction data does not match the uploaded file list.');
    }
    const expectedLabels = classifications[index]!.logicalDocuments.map((document) => String(document.label));
    if (!value.logical_docs.every((label) => typeof label === 'string' && expectedLabels.includes(label))) {
      throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Reviewed extraction data contains an unknown document label.');
    }
    return {
      file_name: input.fileNames[index]!,
      logical_docs: value.logical_docs as string[],
      status: 'success',
      content: typeof value.content === 'string' ? value.content.slice(0, MAX_CONNECTOR_TEXT_BYTES) : JSON.stringify(value.extracted_data),
      extracted_data: value.extracted_data,
    };
  });
}

function readResume(context: TaskContext, raw: Record<string, unknown>): unknown | undefined {
  if (context.waitResponse !== undefined) return context.waitResponse;
  if (Object.hasOwn(raw, 'resumeInput') && typeof raw.waitId === 'string') return raw.resumeInput;
  if (Object.hasOwn(context.input, 'resumeInput') && typeof context.input.waitId === 'string') return context.input.resumeInput;
  return undefined;
}

function validateResume(raw: unknown): { approved?: boolean; extractedData?: unknown } {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['step', 'extracted_data', 'approved', 'note'].includes(key))) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Disbursement review response is malformed.');
  }
  if (raw.step !== undefined && raw.step !== 1) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Disbursement review can update only the extraction step.');
  }
  if (raw.approved !== undefined && typeof raw.approved !== 'boolean') {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Disbursement review approval must be a boolean.');
  }
  if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 4000)) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Disbursement review note is invalid.');
  }
  if (Object.hasOwn(raw, 'extracted_data') && Buffer.byteLength(safeJson(raw.extracted_data), 'utf8') > MAX_AGGREGATE_EVIDENCE_BYTES) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_REVIEW_INVALID', 'Reviewed extraction data exceeds the supported limit.');
  }
  return {
    ...(typeof raw.approved === 'boolean' ? { approved: raw.approved } : {}),
    ...(Object.hasOwn(raw, 'extracted_data') ? { extractedData: raw.extracted_data } : {}),
  };
}

function assertAggregateEvidence(classifications: readonly ClassifiedFile[], extractionResults: readonly ExtractedFile[]): void {
  const size = Buffer.byteLength(safeJson({ classifications, extractionResults }), 'utf8');
  if (size > MAX_AGGREGATE_EVIDENCE_BYTES) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_EVIDENCE_TOO_LARGE', 'Accumulated disbursement evidence exceeds the worker limit.');
  }
}

function toMergedClassification(classifications: readonly ClassifiedFile[]) {
  const logicalDocuments = classifications.flatMap((entry) => entry.logicalDocuments);
  return {
    files_analyzed: classifications.length,
    total_logical_documents: logicalDocuments.length,
    per_file: classifications.map((entry) => ({
      file: entry.fileName,
      document_type: entry.classifyData.document_type,
      logical_documents_count: entry.logicalDocuments.length,
    })),
    logical_documents: logicalDocuments,
  };
}

function buildClassifyPrompt(fileName: string): string {
  return `Classify the uploaded document "${fileName}". Return JSON only with document_type, confidence (0 to 1), and logical_documents. Each logical document must include id, label, pages, confidence, and source_file. Use one logical document with pages "all" when the file is a single document.`;
}

function buildExtractPrompt(fileName: string, logicalDocuments: readonly Record<string, unknown>[]): string {
  return `Extract the requested fields from the uploaded document "${fileName}". Read the full file and return the extracted result as JSON. The classified logical documents are: ${JSON.stringify(logicalDocuments)}. Preserve source values and do not infer missing values.`;
}

function buildCrosscheckPrompt(extractionResults: readonly ExtractedFile[], resolutionData: unknown): string {
  const successful = extractionResults.filter((entry) => entry.status === 'success').map((entry) => ({
    file: entry.file_name,
    logical_documents: entry.logical_docs,
    data: entry.extracted_data,
  }));
  const reference = typeof resolutionData === 'string' && resolutionData.length > 0
    ? `REFERENCE DATA:\n${resolutionData}`
    : 'No external resolution data was provided; check consistency across the extracted documents only.';
  return `Cross-check the extracted evidence for a disbursement review. Return JSON only with verdict (PASS, FAIL, or WARNING), score from 0 to 100, summary, checks (each with rule, status, document_value, reference_value, explanation), and discrepancies. Do not invent evidence.\n\nEXTRACTED DATA:\n${JSON.stringify(successful)}\n\n${reference}`;
}

function buildReportPrompt(
  classifications: readonly ClassifiedFile[],
  extractionResults: readonly ExtractedFile[],
  crosscheck: Record<string, unknown>,
): string {
  return `Prepare a professional Markdown disbursement review report. Include the classified documents, extracted evidence, cross-check verdict and findings, recommendations, and any discrepancies. Do not add unsupported facts.\n\nCLASSIFICATION:\n${JSON.stringify(toMergedClassification(classifications))}\n\nEXTRACTION:\n${JSON.stringify(extractionResults)}\n\nCROSS-CHECK:\n${JSON.stringify(crosscheck)}`;
}

function parseJson(raw: unknown): unknown | undefined {
  if (isRecord(raw) || Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

async function mapBounded<T, R>(values: readonly T[], concurrency: number, run: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await run(values[index]!, index);
    }
  }));
  return results;
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
  const normalized = value.normalize('NFC').replace(/[\\/\0-\x1f\x7f]/g, '_').trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.length > 255) {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_FILENAME_INVALID', 'An uploaded document filename is invalid.');
  }
  return normalized;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? 'null'; } catch {
    throw new LegacyNamedDisbursementError('DISBURSEMENT_RESULT_INVALID', 'Disbursement evidence could not be serialized safely.');
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertActive(context: TaskContext): void {
  if (context.signal.aborted || context.cancelRequested) {
    throw new LegacyNamedDisbursementError('OPERATION_CANCELLED', 'Disbursement workflow was cancelled.');
  }
}
