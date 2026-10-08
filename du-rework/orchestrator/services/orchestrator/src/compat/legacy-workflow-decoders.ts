import type { MultipartBody, MultipartFile } from './legacy-multipart';

export const LEGACY_WORKFLOW_PROCESSES = ['disbursement', 'lc-checker', 'doc-compare'] as const;
export type LegacyWorkflowProcess = (typeof LEGACY_WORKFLOW_PROCESSES)[number];

export interface LegacyWorkflowFile {
  readonly field: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export interface LegacyNamedWorkflowRequest {
  readonly kind: 'named';
  readonly process: LegacyWorkflowProcess;
  readonly variables: Record<string, unknown>;
  readonly files: LegacyWorkflowFile[];
  readonly bodyApiKeyId?: string;
}

export interface LegacySchemaWorkflowRequest {
  readonly kind: 'schema';
  readonly schemaSlug: string;
  readonly input: Record<string, unknown>;
  readonly files: LegacyWorkflowFile[];
  readonly bodyApiKeyId?: string;
}

export type LegacyWorkflowRequest = LegacyNamedWorkflowRequest | LegacySchemaWorkflowRequest;

export type LegacyWorkflowDecodeErrorCode =
  | 'MISSING_SELECTOR'
  | 'UNKNOWN_PROCESS'
  | 'INVALID_INPUT'
  | 'MISSING_FILES'
  | 'TOO_MANY_FILES';

export class LegacyWorkflowDecodeError extends TypeError {
  constructor(
    readonly code: LegacyWorkflowDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LegacyWorkflowDecodeError';
  }
}

/**
 * Read fields with the same first-value behavior as `FormData.get`. File
 * selection mirrors legacy `normalizeFiles`: all `files[]` first, then one
 * each of source_file, target_file and file. Empty uploads are ignored.
 */
export function decodeLegacyNamedWorkflow(body: MultipartBody): LegacyNamedWorkflowRequest {
  const processRaw = firstField(body, 'process');
  const process = processRaw?.trim() ?? '';
  if (process === '') {
    throw new LegacyWorkflowDecodeError('MISSING_SELECTOR', "Form field 'process' is required.");
  }
  if (!isLegacyWorkflowProcess(process)) {
    throw new LegacyWorkflowDecodeError('UNKNOWN_PROCESS', `Workflow '${process}' is not registered.`);
  }

  const files = normalizedFiles(body);
  if (files.length === 0) {
    throw new LegacyWorkflowDecodeError('MISSING_FILES', 'Workflow requires at least 1 document.');
  }
  assertFileCount(files);

  const variables: Record<string, unknown> = {};
  // This is the only named-process field declared in the legacy registry.
  // Empty values were falsey and omitted by the old route.
  const resolutionData = firstField(body, 'resolution_data');
  if (process === 'disbursement' && resolutionData) {
    variables.resolution_data = resolutionData;
  }

  return {
    kind: 'named',
    process,
    variables,
    files,
    ...bodyApiKeyId(body),
  };
}

/** Decode the old multipart schema runner request, with object-only JSON input. */
export function decodeLegacySchemaWorkflow(body: MultipartBody): LegacySchemaWorkflowRequest {
  const schemaSlug = firstField(body, 'schemaSlug')?.trim() ?? '';
  if (schemaSlug === '') {
    throw new LegacyWorkflowDecodeError('MISSING_SELECTOR', "Form field 'schemaSlug' is required.");
  }

  const inputRaw = firstField(body, 'input');
  let input: unknown = {};
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw) as unknown;
    } catch {
      throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Form field "input" must be a valid JSON object string.');
    }
  }
  if (!isRecord(input)) {
    throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Form field "input" must be a JSON object.');
  }

  const files = normalizedFiles(body);
  assertFileCount(files);
  return {
    kind: 'schema',
    schemaSlug,
    input,
    files,
    ...bodyApiKeyId(body),
  };
}

export function isLegacyWorkflowProcess(value: string): value is LegacyWorkflowProcess {
  return (LEGACY_WORKFLOW_PROCESSES as readonly string[]).includes(value);
}

function firstField(body: MultipartBody, name: string): string | undefined {
  return body.fields.get(name)?.[0];
}

function bodyApiKeyId(body: MultipartBody): { bodyApiKeyId?: string } {
  const value = firstField(body, 'apiKeyId');
  return value === undefined ? {} : { bodyApiKeyId: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFileCount(files: readonly LegacyWorkflowFile[]): void {
  if (files.length > 64) {
    throw new LegacyWorkflowDecodeError('TOO_MANY_FILES', 'Workflow accepts at most 64 uploaded files.');
  }
}

function normalizedFiles(body: MultipartBody): LegacyWorkflowFile[] {
  const result: LegacyWorkflowFile[] = [];
  const add = (file: MultipartFile): void => {
    if (file.content.length === 0) return;
    result.push({
      field: file.fieldName,
      fileName: file.fileName,
      mimeType: file.contentType,
      bytes: file.content,
    });
  };

  for (const file of body.files) {
    if (file.fieldName === 'files[]') add(file);
  }
  for (const field of ['source_file', 'target_file', 'file']) {
    const file = body.files.find((candidate) => candidate.fieldName === field);
    if (file !== undefined) add(file);
  }
  return result;
}
