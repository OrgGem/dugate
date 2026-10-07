/**
 * COMP-02 legacy DUGate request normalization.
 *
 * This module is deliberately a pure wire decoder: it translates the six
 * historical public action formats into a canonical submission shape and
 * records which client fields were present. Authentication, tenant selection,
 * profile policy, URL egress policy, and file admission remain downstream
 * responsibilities. In particular, identity-looking body fields and headers
 * are never promoted into trusted request context.
 */

export const LEGACY_CORE_ACTIONS = [
  'ingest',
  'extract',
  'analyze',
  'transform',
  'generate',
  'compare',
] as const;

export type LegacyCoreAction = (typeof LEGACY_CORE_ACTIONS)[number];

const DISCRIMINATORS: Record<LegacyCoreAction, string> = {
  ingest: 'mode',
  extract: 'type',
  analyze: 'task',
  transform: 'action',
  generate: 'task',
  compare: 'mode',
};

const VARIANTS: Record<LegacyCoreAction, ReadonlySet<string>> = {
  ingest: new Set(['parse', 'ocr', 'digitize', 'split']),
  extract: new Set(['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom']),
  analyze: new Set(['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval']),
  transform: new Set(['convert', 'translate', 'rewrite', 'redact', 'template']),
  generate: new Set(['summary', 'outline', 'report', 'email', 'minutes', 'qa']),
  compare: new Set(['diff', 'semantic', 'version']),
};

const FILE_FIELDS = ['source_file', 'target_file', 'file'] as const;
const FILE_LIST_FIELD = 'files[]';
const AUTHORITY_FIELDS = new Set([
  'apiKey',
  'apiKeyId',
  'tenantId',
  'userId',
  'xApiKey',
  'xApiKeyId',
  'xUserId',
  'authorization',
  'idempotencyKey',
  'correlationId',
]);

export type LegacyWireDecodeErrorCode =
  | 'UNSUPPORTED_ACTION'
  | 'MISSING_DISCRIMINATOR'
  | 'INVALID_DISCRIMINATOR'
  | 'CONFLICTING_DISCRIMINATOR'
  | 'INVALID_PARAMETERS'
  | 'CONFLICTING_PARAMETER'
  | 'INVALID_FILE_URLS'
  | 'INVALID_CALLBACK'
  | 'INVALID_SOURCE_URL'
  | 'INVALID_HEADER';

export class LegacyWireDecodeError extends TypeError {
  readonly code: LegacyWireDecodeErrorCode;
  readonly field?: string;

  constructor(code: LegacyWireDecodeErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'LegacyWireDecodeError';
    this.code = code;
    this.field = field;
  }
}

export interface LegacyFilePart {
  /** Historical multipart field name, retained for callers that need file roles. */
  field: typeof FILE_LIST_FIELD | (typeof FILE_FIELDS)[number];
  value: unknown;
}

export interface LegacyDecodedSubmission {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  sourceUrl?: string;
  callback?: { url: string };
}

export interface LegacyFieldPresence {
  /** Canonical action input keys supplied by the caller, including `variant`. */
  inputFields: string[];
  outputFormat: boolean;
  sourceUrl: boolean;
  callback: boolean;
  fileUrls: boolean;
  fileFields: string[];
  idempotencyKey: boolean;
  correlationId: boolean;
  executeSync: boolean;
}

export interface LegacyDecodedRequest {
  action: LegacyCoreAction;
  variant: string;
  submission: LegacyDecodedSubmission;
  /** URL inputs remain explicit so the caller can apply source-ingestion policy. */
  fileUrls: Array<Record<string, unknown>>;
  /** Binary values are kept outside JSON submission input for bounded upload handling. */
  files: LegacyFilePart[];
  idempotencyKey?: string;
  correlationId?: string;
  executeSync: boolean;
  presence: LegacyFieldPresence;
}

/**
 * A small envelope around the legacy wire pieces. `form`, `headers`, and
 * `query` accept native Fetch objects or plain records, which keeps decoding
 * usable by both an HTTP adapter and focused unit tests without reading a body.
 */
export interface LegacyWireRequest {
  body?: unknown;
  params?: unknown;
  parameters?: unknown;
  form?: unknown;
  headers?: unknown;
  query?: unknown;
}

interface Entry {
  key: string;
  value: unknown;
}

interface PickedValue {
  present: boolean;
  value?: unknown;
}

/** Decode old form/body parameter names and legacy transport headers. */
export function decodeLegacyWire(
  actionValue: string,
  request: LegacyWireRequest,
): LegacyDecodedRequest {
  if (!isLegacyCoreAction(actionValue)) {
    throw new LegacyWireDecodeError('UNSUPPORTED_ACTION', `Unsupported legacy core action: ${actionValue}`, 'action');
  }

  const action = actionValue;
  const body = asRecord(request.body, 'body', true);
  const inputRecord = body.input === undefined ? {} : asRecord(body.input, 'input');

  // Preserve the old flat multipart shape while also accepting already
  // grouped params/parameters objects used by compatibility clients.
  const rawFields = new Map<string, unknown>();
  mergeEntries(rawFields, objectEntries(body, new Set(['input', 'params', 'parameters', 'headers', 'query', 'form'])));
  mergeEntries(rawFields, objectEntries(inputRecord));
  mergeEntries(rawFields, objectEntries(parseParameterObject(body.parameters, 'parameters')));
  mergeEntries(rawFields, objectEntries(parseParameterObject(body.params, 'params')));
  mergeEntries(rawFields, objectEntries(parseParameterObject(request.parameters, 'parameters')));
  mergeEntries(rawFields, objectEntries(parseParameterObject(request.params, 'params')));
  mergeEntries(rawFields, fieldEntries(request.form));

  const discriminatorName = DISCRIMINATORS[action];
  const discriminator = pickAliases(rawFields, [discriminatorName, 'variant', 'discriminator'], 'variant', 'CONFLICTING_DISCRIMINATOR');
  if (!discriminator.present || typeof discriminator.value !== 'string' || discriminator.value.trim() === '') {
    throw new LegacyWireDecodeError('MISSING_DISCRIMINATOR', `A ${discriminatorName} discriminator is required`, discriminatorName);
  }
  const variant = discriminator.value.trim();
  if (!VARIANTS[action].has(variant)) {
    throw new LegacyWireDecodeError('INVALID_DISCRIMINATOR', `Unsupported ${action} variant: ${variant}`, discriminatorName);
  }

  const outputFormat = pickAliases(rawFields, ['output_format', 'outputFormat'], 'output_format', 'CONFLICTING_PARAMETER');
  if (outputFormat.present && typeof outputFormat.value !== 'string') {
    throw new LegacyWireDecodeError('INVALID_PARAMETERS', 'output_format must be a string', 'output_format');
  }

  const sourceUrl = pickAliases(rawFields, ['source_url', 'sourceUrl'], 'source_url', 'CONFLICTING_PARAMETER');
  if (sourceUrl.present && typeof sourceUrl.value !== 'string') {
    throw new LegacyWireDecodeError('INVALID_SOURCE_URL', 'source_url must be a string', 'source_url');
  }

  const fileUrlsValue = pickAliases(rawFields, ['file_urls', 'fileUrls'], 'file_urls', 'CONFLICTING_PARAMETER');
  const fileUrls = fileUrlsValue.present ? parseFileUrls(fileUrlsValue.value) : [];

  const webhookUrl = pickAliases(rawFields, ['webhook_url', 'webhookUrl'], 'webhook_url', 'CONFLICTING_PARAMETER');
  const canonicalCallback = pickAliases(rawFields, ['callback'], 'callback', 'CONFLICTING_PARAMETER');
  const callback = decodeCallback(webhookUrl, canonicalCallback);

  const canonicalOutput = pickAliases(rawFields, ['output'], 'output', 'CONFLICTING_PARAMETER');
  const output = canonicalOutput.present
    ? normalizeRecord(asRecord(canonicalOutput.value, 'output'))
    : {};
  // The old runner supplied JSON when output_format was omitted.
  output.format = outputFormat.present ? outputFormat.value : 'json';

  const reservedInputFields = new Set([
    discriminatorName,
    'variant',
    'discriminator',
    'output_format',
    'outputFormat',
    'output',
    'source_url',
    'sourceUrl',
    'file_urls',
    'fileUrls',
    'webhook_url',
    'webhookUrl',
    'callback',
    'sync',
    FILE_LIST_FIELD,
    ...FILE_FIELDS,
  ]);
  const canonicalInputFields = new Map<string, unknown>();
  for (const [legacyKey, value] of rawFields) {
    const canonicalKey = snakeToCamel(legacyKey);
    if (reservedInputFields.has(legacyKey) || AUTHORITY_FIELDS.has(canonicalKey)) continue;
    if (canonicalInputFields.has(canonicalKey)) {
      throw new LegacyWireDecodeError(
        'CONFLICTING_PARAMETER',
        `Multiple legacy parameter names map to ${canonicalKey}`,
        canonicalKey,
      );
    }
    canonicalInputFields.set(canonicalKey, value);
  }
  canonicalInputFields.set('variant', variant);
  if (fileUrlsValue.present) canonicalInputFields.set('fileUrls', fileUrls);
  const input = Object.fromEntries(canonicalInputFields);

  const sourceUrlValue = sourceUrl.present ? sourceUrl.value as string : undefined;
  const submission: LegacyDecodedSubmission = {
    input,
    output,
    ...(sourceUrlValue === undefined ? {} : { sourceUrl: sourceUrlValue }),
    ...(callback === undefined ? {} : { callback }),
  };

  const files = collectFiles(request.form, rawFields);
  const idempotency = readHeader(request.headers, ['idempotency-key']);
  const correlation = readHeader(request.headers, ['x-correlation-id', 'correlation-id']);
  const syncValue = readField(request.query, 'sync');
  const executeSync = syncValue.present && (syncValue.value === true || syncValue.value === 'true');

  return {
    action,
    variant,
    submission,
    fileUrls,
    files,
    ...(idempotency.present ? { idempotencyKey: idempotency.value as string } : {}),
    ...(correlation.present ? { correlationId: correlation.value as string } : {}),
    executeSync,
    presence: {
      inputFields: Object.keys(input),
      outputFormat: outputFormat.present,
      sourceUrl: sourceUrl.present,
      callback: webhookUrl.present || canonicalCallback.present,
      fileUrls: fileUrlsValue.present,
      fileFields: [...new Set(files.map((file) => file.field))],
      idempotencyKey: idempotency.present,
      correlationId: correlation.present,
      executeSync: syncValue.present,
    },
  };
}

function isLegacyCoreAction(value: string): value is LegacyCoreAction {
  return (LEGACY_CORE_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, field: string, allowAbsent = false): Record<string, unknown> {
  if (value === undefined && allowAbsent) return {};
  if (!isRecord(value)) {
    throw new LegacyWireDecodeError('INVALID_PARAMETERS', `${field} must be an object`, field);
  }
  return value;
}

function parseParameterObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    if (value.trim() === '') return {};
    try {
      return asRecord(JSON.parse(value) as unknown, field);
    } catch (error: unknown) {
      if (error instanceof LegacyWireDecodeError) throw error;
      throw new LegacyWireDecodeError('INVALID_PARAMETERS', `${field} must contain a JSON object`, field);
    }
  }
  return asRecord(value, field);
}

function objectEntries(record: Record<string, unknown>, excluded: ReadonlySet<string> = new Set()): Entry[] {
  return Object.entries(record)
    .filter(([key]) => !excluded.has(key))
    .map(([key, value]) => ({ key, value }));
}

function fieldEntries(source: unknown): Entry[] {
  if (source === undefined || source === null) return [];
  const entriesMethod = getMethod(source, 'entries');
  if (entriesMethod) {
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const item of entriesMethod.call(source) as Iterable<unknown>) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || seen.has(item[0])) continue;
      seen.add(item[0]);
      entries.push({ key: item[0], value: item[1] });
    }
    return entries;
  }
  if (!isRecord(source)) return [];
  return Object.entries(source).map(([key, value]) => ({ key, value }));
}

function mergeEntries(target: Map<string, unknown>, entries: Entry[]): void {
  for (const entry of entries) target.set(entry.key, entry.value);
}

function getMethod(value: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === 'function' ? candidate as (...args: unknown[]) => unknown : undefined;
}

function readField(source: unknown, key: string): PickedValue {
  if (source === undefined || source === null) return { present: false };
  const get = getMethod(source, 'get');
  if (get) {
    const value = get.call(source, key);
    return { present: value !== null && value !== undefined, value: value === null ? undefined : value };
  }
  if (isRecord(source) && Object.prototype.hasOwnProperty.call(source, key)) {
    return { present: true, value: source[key] };
  }
  return { present: false };
}

function readAllFields(source: unknown, key: string): unknown[] {
  const getAll = getMethod(source, 'getAll');
  if (getAll) {
    const values = getAll.call(source, key);
    return Array.isArray(values) ? values : [];
  }
  const value = readField(source, key);
  if (!value.present) return [];
  return Array.isArray(value.value) ? value.value : [value.value];
}

function pickAliases(
  fields: Map<string, unknown>,
  aliases: string[],
  field: string,
  conflictCode: 'CONFLICTING_DISCRIMINATOR' | 'CONFLICTING_PARAMETER',
): PickedValue {
  const matches = aliases.filter((alias) => fields.has(alias));
  if (matches.length === 0) return { present: false };
  const first = fields.get(matches[0]!);
  for (const alias of matches.slice(1)) {
    if (!sameValue(first, fields.get(alias))) {
      throw new LegacyWireDecodeError(conflictCode, `Conflicting legacy aliases for ${field}`, field);
    }
  }
  return { present: true, value: first };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === 'string' && typeof right === 'string') return left === right;
  return false;
}

function snakeToCamel(key: string): string {
  return key.replace(/_+([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function normalizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = new Map<string, unknown>();
  for (const [legacyKey, value] of Object.entries(record)) {
    const key = snakeToCamel(legacyKey);
    if (normalized.has(key)) {
      throw new LegacyWireDecodeError('CONFLICTING_PARAMETER', `Multiple legacy parameter names map to ${key}`, key);
    }
    normalized.set(key, value);
  }
  return Object.fromEntries(normalized);
}

function parseFileUrls(value: unknown): Array<Record<string, unknown>> {
  if (value === '') return [];
  let entries: unknown = value;
  if (typeof value === 'string') {
    try {
      entries = JSON.parse(value) as unknown;
    } catch {
      throw new LegacyWireDecodeError('INVALID_FILE_URLS', 'file_urls must contain a JSON array', 'file_urls');
    }
  }
  if (!Array.isArray(entries)) {
    throw new LegacyWireDecodeError('INVALID_FILE_URLS', 'file_urls must be an array', 'file_urls');
  }
  return entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.url !== 'string' || entry.url.trim() === '') {
      throw new LegacyWireDecodeError('INVALID_FILE_URLS', `file_urls[${index}] must include a non-empty url`, 'file_urls');
    }
    try {
      // Syntax only. Destination policy belongs to the shared source URL guard.
      new URL(entry.url);
    } catch {
      throw new LegacyWireDecodeError('INVALID_FILE_URLS', `file_urls[${index}] has an invalid URL`, 'file_urls');
    }
    return normalizeRecord(entry);
  });
}

function decodeCallback(webhookUrl: PickedValue, callbackValue: PickedValue): { url: string } | undefined {
  if (webhookUrl.present) {
    if (typeof webhookUrl.value !== 'string') {
      throw new LegacyWireDecodeError('INVALID_CALLBACK', 'webhook_url must be a string', 'webhook_url');
    }
    return { url: webhookUrl.value };
  }
  if (!callbackValue.present) return undefined;
  if (!isRecord(callbackValue.value) || typeof callbackValue.value.url !== 'string') {
    throw new LegacyWireDecodeError('INVALID_CALLBACK', 'callback must contain a string url', 'callback');
  }
  return { url: callbackValue.value.url };
}

function isFileLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && typeof value.size === 'number' && Number.isFinite(value.size) && value.size > 0;
}

function collectFiles(form: unknown, rawFields: Map<string, unknown>): LegacyFilePart[] {
  const files: LegacyFilePart[] = [];
  const multi = readAllFields(form, FILE_LIST_FIELD);
  const listValues = multi.length > 0 ? multi : expandArray(rawFields.get(FILE_LIST_FIELD));
  for (const value of listValues) {
    if (isFileLike(value)) files.push({ field: FILE_LIST_FIELD, value });
  }
  for (const field of FILE_FIELDS) {
    const value = rawFields.get(field);
    if (isFileLike(value)) files.push({ field, value });
  }
  return files;
}

function expandArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function readHeader(source: unknown, aliases: string[]): PickedValue {
  if (source === undefined || source === null) return { present: false };
  const get = getMethod(source, 'get');
  if (get) {
    const matches = aliases.map((alias) => ({ alias, value: get.call(source, alias) }))
      .filter(({ value }) => value !== null && value !== undefined);
    return validateHeaderAliases(matches, aliases[0] ?? 'header');
  }

  const matches = fieldEntries(source)
    .filter(({ key }) => aliases.includes(key.toLowerCase()))
    .map(({ key, value }) => ({ alias: key, value }));
  return validateHeaderAliases(matches, aliases[0] ?? 'header');
}

function validateHeaderAliases(matches: Array<{ alias: string; value: unknown }>, field: string): PickedValue {
  if (matches.length === 0) return { present: false };
  const value = matches[0]!.value;
  if (typeof value !== 'string') {
    throw new LegacyWireDecodeError('INVALID_HEADER', `${field} header must be a string`, field);
  }
  for (const match of matches.slice(1)) {
    if (match.value !== value) {
      throw new LegacyWireDecodeError('INVALID_HEADER', `Conflicting legacy headers for ${field}`, field);
    }
  }
  return { present: true, value };
}
