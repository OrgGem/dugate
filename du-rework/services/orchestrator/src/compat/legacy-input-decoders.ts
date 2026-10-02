/**
 * COMP-03b-adjacent: STRICT legacy INPUT decoder.
 *
 * UNMOUNTED, UNFROZEN. This is evidence-ready module code for a contract that
 * COMP-00/COMP-02 has not decided yet. Nothing here is the frozen contract.
 *
 * ## Relationship to the COMP-02 decoder
 *
 * `legacy-wire-decoders.ts` (COMP-02) is deliberately LENIENT: it drops unknown
 * fields and never rejects. This module is the opposite - it fails closed on
 * every unknown field. Both can coexist; they answer different questions.
 * COMP-02 answers "what did the client mean?", this answers "is this request
 * admissible?". A client that passes COMP-02 can still be rejected here, and
 * that is the intended strict posture, not a contradiction.
 *
 * ## The legacy vulnerability this refuses to reproduce
 *
 * Legacy resolved `apiKeyId` from the request (`x-api-key-id` header,
 * `app/api/internal/profile-endpoints/route.ts:110`) and the schema workflow
 * route additionally selected it from the BODY (`form.get('apiKeyId')`) with an
 * ADMIN-key fallback. That lets a caller choose its own identity. This decoder
 * REJECTS any identity-looking field, in the body or in the headers, with a
 * dedicated `IDENTITY_FIELD_FORBIDDEN` code so the refusal is auditable rather
 * than silent. Identity resolution stays with the host's `resolveApiKey`.
 *
 * ## Strictness
 *
 * Unknown field -> `UNKNOWN_FIELD`. Missing discriminator ->
 * `MISSING_DISCRIMINATOR`. Unknown variant -> `INVALID_DISCRIMINATOR`. Conflicting
 * discriminator aliases -> `CONFLICTING_DISCRIMINATOR`. Every rejection throws
 * `LegacyInputDecodeError`; there is no partial-success return.
 */

import { SubmissionSchema, type Submission } from '@du/contracts';

/* ------------------------------------------------------------------ */
/* Vocabulary (derived from lib/endpoints/registry.ts)                 */
/* ------------------------------------------------------------------ */

export const LEGACY_CORE_ACTIONS = [
  'ingest',
  'extract',
  'analyze',
  'transform',
  'generate',
  'compare',
] as const;
export type LegacyCoreAction = (typeof LEGACY_CORE_ACTIONS)[number];

export const LEGACY_DISCRIMINATORS: Readonly<Record<LegacyCoreAction, string>> = {
  ingest: 'mode',
  extract: 'type',
  analyze: 'task',
  transform: 'action',
  generate: 'task',
  compare: 'mode',
};

/**
 * Per-variant parameter allow-list.
 *
 * Measured, not assumed: each entry lists exactly the `PARAMS.*` references
 * inside that sub-case's `parameters: { ... }` block in `registry.ts`. A
 * parameter the registry never attaches to a sub-case (type, focus_areas,
 * target_language, glossary, redact_patterns, max_words, audience) is therefore
 * NOT reachable here and is rejected as unknown - which is the intended
 * divergence from legacy, where those fields were silently dropped.
 */
export const LEGACY_VARIANT_PARAMS: Readonly<Record<LegacyCoreAction, Readonly<Record<string, readonly string[]>>>> = {
  ingest: {
    parse: ['output_format', 'language'],
    ocr: ['language'],
    digitize: [],
    split: ['pages'],
  },
  extract: {
    invoice: [],
    contract: [],
    'id-card': [],
    receipt: [],
    table: [],
    custom: ['fields', 'schema'],
  },
  analyze: {
    classify: ['categories'],
    sentiment: [],
    compliance: ['criteria'],
    'fact-check': ['reference_data', 'extract_fields'],
    quality: ['criteria'],
    risk: [],
    'summarize-eval': [],
  },
  transform: {
    convert: ['output_format'],
    translate: [],
    rewrite: ['style', 'tone'],
    redact: [],
    template: ['template'],
  },
  generate: {
    summary: [],
    outline: ['format'],
    report: [],
    email: ['tone'],
    minutes: ['format'],
    qa: ['questions'],
  },
  compare: {
    diff: ['output_format'],
    semantic: ['focus'],
    version: ['output_format'],
  },
};

/**
 * Transport fields accepted for EVERY action, because `runEndpoint` reads them
 * outside the per-sub-case merge (`lib/endpoints/runner.ts`).
 */
export const LEGACY_TRANSPORT_FIELDS: readonly string[] = [
  'files[]',
  'file',
  'source_file',
  'target_file',
  'file_urls',
  'source_url',
  'webhook_url',
  'output_format',
  'sync',
  'callback',
];

/** Aliases accepted for the discriminator, in precedence order. */
const DISCRIMINATOR_ALIASES: readonly string[] = ['variant', 'discriminator'];

/**
 * Identity-looking keys refused in the BODY. `x-api-key` is deliberately NOT
 * here: it is the legitimate credential header and is never copied into output.
 */
export const FORBIDDEN_BODY_IDENTITY_FIELDS: readonly string[] = [
  'apiKeyId',
  'api_key_id',
  'xApiKeyId',
  'apiKey',
  'api_key',
  'xApiKey',
  'x_api_key',
  'tenantId',
  'tenant_id',
  'userId',
  'user_id',
  'createdByUserId',
  'authorization',
  'role',
];

/** Identity-looking HEADER keys refused on the request. */
export const FORBIDDEN_IDENTITY_HEADERS: readonly string[] = [
  'x-api-key-id',
  'x_api_key_id',
  'x-tenant-id',
  'x-user-id',
  'authorization',
  // Header comparisons are case-insensitive; include both the common header
  // dialects and the body-style identity spellings so they cannot be silently
  // ignored when moved into the header bag.
  'apiKeyId',
  'api_key_id',
  'xApiKeyId',
  'apiKey',
  'api_key',
  'xApiKey',
  'x_api_key',
  'tenantId',
  'tenant_id',
  'userId',
  'user_id',
  'createdByUserId',
  'created_by_user_id',
  'role',
];

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type LegacyInputDecodeErrorCode =
  | 'UNSUPPORTED_ACTION'
  | 'MISSING_DISCRIMINATOR'
  | 'INVALID_DISCRIMINATOR'
  | 'CONFLICTING_DISCRIMINATOR'
  | 'UNKNOWN_FIELD'
  | 'IDENTITY_FIELD_FORBIDDEN'
  | 'INVALID_FIELD_TYPE'
  | 'INVALID_FILE_URLS'
  | 'INVALID_CALLBACK'
  | 'INVALID_SOURCE_URL';

export class LegacyInputDecodeError extends TypeError {
  readonly code: LegacyInputDecodeErrorCode;
  readonly field?: string;

  constructor(code: LegacyInputDecodeErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'LegacyInputDecodeError';
    this.code = code;
    this.field = field;
  }
}

/* ------------------------------------------------------------------ */
/* Request / result shapes                                            */
/* ------------------------------------------------------------------ */

export interface LegacyStrictFilePart {
  readonly field: 'files[]' | 'file' | 'source_file' | 'target_file';
  readonly fileName: string | null;
  readonly sizeBytes: number | null;
  readonly value: unknown;
}

export interface LegacyDecodedInput {
  readonly action: LegacyCoreAction;
  readonly variant: string;
  /** `service` or `service:variant`, the legacy endpoint-slug dialect. */
  readonly endpointSlug: string;
  /** Canonical, contract-shaped submission. Always validated. */
  readonly submission: Submission;
  readonly files: readonly LegacyStrictFilePart[];
  readonly fileUrls: ReadonlyArray<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly executeSync: boolean;
}

export interface LegacyStrictRequest {
  readonly body?: unknown;
  readonly form?: unknown;
  readonly headers?: unknown;
  readonly query?: unknown;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Decode one legacy action request. Throws `LegacyInputDecodeError` on any
 * violation; there is no lenient mode and no partial result.
 */
export function decodeLegacyInput(
  actionValue: string,
  request: LegacyStrictRequest,
): LegacyDecodedInput {
  if (!isLegacyCoreAction(actionValue)) {
    throw new LegacyInputDecodeError(
      'UNSUPPORTED_ACTION',
      `Unsupported legacy core action: ${actionValue}`,
      'action',
    );
  }
  const action = actionValue;

  assertNoIdentityHeaders(request.headers);
  assertNoUnknownQueryFields(request.query);

  const fields = collectFields(request);
  assertNoIdentityFields(fields);

  const discriminatorName = LEGACY_DISCRIMINATORS[action];
  const discriminator = pickDiscriminator(fields, discriminatorName);
  if (discriminator === undefined || discriminator.trim() === '') {
    throw new LegacyInputDecodeError(
      'MISSING_DISCRIMINATOR',
      `A ${discriminatorName} discriminator is required`,
      discriminatorName,
    );
  }
  const variant = discriminator.trim();

  const variantParams = LEGACY_VARIANT_PARAMS[action][variant];
  if (variantParams === undefined) {
    throw new LegacyInputDecodeError(
      'INVALID_DISCRIMINATOR',
      `Unsupported ${action} variant: ${variant}`,
      discriminatorName,
    );
  }

  const allowed = new Set<string>([
    discriminatorName,
    ...DISCRIMINATOR_ALIASES,
    ...LEGACY_TRANSPORT_FIELDS,
    ...variantParams,
  ]);
  assertNoUnknownFields(fields, allowed);

  const input: Record<string, unknown> = { variant };
  for (const [key, value] of fields) {
    if (key === discriminatorName || DISCRIMINATOR_ALIASES.includes(key)) continue;
    if (LEGACY_TRANSPORT_FIELDS.includes(key)) continue;
    assertStringField(key, value);
    input[toCamelCase(key)] = value;
  }

  const outputFormat = readOptionalString(fields, 'output_format');
  const sourceUrl = readOptionalString(fields, 'source_url');
  const webhookUrl = readOptionalString(fields, 'webhook_url');
  const callbackRaw = fields.get('callback');

  let callbackUrl = webhookUrl;
  if (callbackRaw !== undefined && callbackRaw !== null && callbackRaw !== '') {
    if (typeof callbackRaw !== 'object' || Array.isArray(callbackRaw)) {
      throw new LegacyInputDecodeError('INVALID_CALLBACK', 'callback must be an object', 'callback');
    }
    const url = (callbackRaw as Record<string, unknown>).url;
    if (typeof url !== 'string' || url.trim() === '') {
      throw new LegacyInputDecodeError('INVALID_CALLBACK', 'callback requires a string url', 'callback');
    }
    callbackUrl = url;
  }

  const fileUrls = parseFileUrls(fields.get('file_urls'));
  if (fileUrls.length > 0) input.fileUrls = fileUrls;

  const submissionDraft: Record<string, unknown> = {
    input,
    output: { format: outputFormat ?? 'json' },
  };
  if (sourceUrl !== undefined) submissionDraft.sourceUrl = sourceUrl;
  if (callbackUrl !== undefined) submissionDraft.callback = { url: callbackUrl };

  // Validated against the FROZEN canonical contract: the compat layer never
  // invents a submission shape the canonical DTO would reject.
  const submission = SubmissionSchema.parse(submissionDraft);

  const idempotencyKey = readHeader(request.headers, 'idempotency-key');
  const correlationId = readHeader(request.headers, 'x-correlation-id');
  const syncRaw = readField(request.query, 'sync');
  const executeSync = syncRaw.present && (syncRaw.value === true || syncRaw.value === 'true');

  return {
    action,
    variant,
    endpointSlug: `${action}:${variant}`,
    submission,
    files: collectFiles(fields, request.form),
    fileUrls,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(correlationId === undefined ? {} : { correlationId }),
    executeSync,
  };
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

function assertNoIdentityHeaders(headers: unknown): void {
  const keys =
    typeof Headers !== 'undefined' && headers instanceof Headers
      ? Array.from(headers.keys())
      : isRecord(headers)
        ? Object.keys(headers)
        : [];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_IDENTITY_HEADERS.some((forbidden) => forbidden.toLowerCase() === lower)) {
      throw new LegacyInputDecodeError(
        'IDENTITY_FIELD_FORBIDDEN',
        `The ${lower} header is not accepted; identity is resolved from x-api-key`,
        lower,
      );
    }
  }
}

function assertNoUnknownQueryFields(query: unknown): void {
  if (query === undefined || query === null) return;
  if (typeof URLSearchParams !== 'undefined' && query instanceof URLSearchParams) {
    for (const [key] of query) {
      if (key === 'sync') continue;
      throw new LegacyInputDecodeError('UNKNOWN_FIELD', `Unknown query field '${key}'`, key);
    }
    return;
  }
  if (!isRecord(query)) {
    throw new LegacyInputDecodeError(
      'INVALID_FIELD_TYPE',
      'Query parameters must be provided as an object',
      'query',
    );
  }
  for (const key of Object.keys(query)) {
    if (key === 'sync') continue;
    throw new LegacyInputDecodeError(
      'UNKNOWN_FIELD',
      `Unknown query field '${key}'`,
      key,
    );
  }
}

function assertNoIdentityFields(fields: ReadonlyMap<string, unknown>): void {
  for (const [key, value] of fields) {
    if (FORBIDDEN_BODY_IDENTITY_FIELDS.includes(key) || FORBIDDEN_BODY_IDENTITY_FIELDS.includes(toCamelCase(key))) {
      throw new LegacyInputDecodeError(
        'IDENTITY_FIELD_FORBIDDEN',
        `The '${key}' field is not accepted; identity is resolved from x-api-key`,
        key,
      );
    }
    // A file part can carry a name; only scalar identity keys matter here.
    if (isRecord(value) && typeof value.name === 'string' && FORBIDDEN_BODY_IDENTITY_FIELDS.includes(key)) {
      throw new LegacyInputDecodeError(
        'IDENTITY_FIELD_FORBIDDEN',
        `The '${key}' field is not accepted`,
        key,
      );
    }
  }
}

function assertNoUnknownFields(fields: ReadonlyMap<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of fields.keys()) {
    if (allowed.has(key)) continue;
    throw new LegacyInputDecodeError(
      'UNKNOWN_FIELD',
      `Unknown field '${key}' for this action/variant`,
      key,
    );
  }
}

function assertStringField(key: string, value: unknown): void {
  if (typeof value !== 'string') {
    throw new LegacyInputDecodeError(
      'INVALID_FIELD_TYPE',
      `Field '${key}' must be a string`,
      key,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

function pickDiscriminator(fields: ReadonlyMap<string, unknown>, name: string): string | undefined {
  let chosen: string | undefined;
  for (const alias of [name, ...DISCRIMINATOR_ALIASES]) {
    const value = fields.get(alias);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new LegacyInputDecodeError(
        'INVALID_FIELD_TYPE',
        `Discriminator '${alias}' must be a string`,
        alias,
      );
    }
    if (chosen !== undefined && chosen !== value) {
      throw new LegacyInputDecodeError(
        'CONFLICTING_DISCRIMINATOR',
        `Conflicting legacy aliases for ${name}`,
        name,
      );
    }
    chosen = value;
  }
  return chosen;
}

function readOptionalString(fields: ReadonlyMap<string, unknown>, key: string): string | undefined {
  const value = fields.get(key);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new LegacyInputDecodeError(
      key === 'source_url' ? 'INVALID_SOURCE_URL' : 'INVALID_FIELD_TYPE',
      `Field '${key}' must be a string`,
      key,
    );
  }
  if (key === 'source_url' && value.length > 2048) {
    throw new LegacyInputDecodeError('INVALID_SOURCE_URL', 'source_url exceeds 2048 characters', key);
  }
  return value;
}

function parseFileUrls(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null || value === '') return [];
  let entries: unknown = value;
  if (typeof value === 'string') {
    try {
      entries = JSON.parse(value) as unknown;
    } catch {
      throw new LegacyInputDecodeError('INVALID_FILE_URLS', 'file_urls must contain a JSON array', 'file_urls');
    }
  }
  if (!Array.isArray(entries)) {
    throw new LegacyInputDecodeError('INVALID_FILE_URLS', 'file_urls must be an array', 'file_urls');
  }
  return entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.url !== 'string' || entry.url.trim() === '') {
      throw new LegacyInputDecodeError(
        'INVALID_FILE_URLS',
        `file_urls[${index}] must include a non-empty url`,
        'file_urls',
      );
    }
    try {
      new URL(entry.url);
    } catch {
      throw new LegacyInputDecodeError(
        'INVALID_FILE_URLS',
        `file_urls[${index}] has an invalid URL`,
        'file_urls',
      );
    }
    return { ...entry };
  });
}

function collectFiles(
  fields: ReadonlyMap<string, unknown>,
  form: unknown,
): LegacyStrictFilePart[] {
  const out: LegacyStrictFilePart[] = [];
  const multi = readAll(form, 'files[]');
  const source = fields.get('source_file');
  const target = fields.get('target_file');
  const single = fields.get('file');
  const push = (field: LegacyStrictFilePart['field'], value: unknown) => {
    if (!isFileLike(value)) return;
    out.push({
      field,
      fileName: typeof value.name === 'string' ? value.name : null,
      sizeBytes: typeof value.size === 'number' ? value.size : null,
      value,
    });
  };
  for (const item of multi) push('files[]', item);
  push('source_file', source);
  push('target_file', target);
  push('file', single);
  return out;
}

function collectFields(request: LegacyStrictRequest): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  const body = request.body;
  if (isRecord(body)) {
    for (const [key, value] of Object.entries(body)) {
      if (key === 'input' || key === 'headers' || key === 'query' || key === 'form') continue;
      fields.set(key, value);
    }
    if (isRecord(body.input)) {
      for (const [key, value] of Object.entries(body.input)) fields.set(key, value);
    }
  }
  const form = request.form;
  if (isRecord(form) && typeof (form as { entries?: unknown }).entries === 'function') {
    const entries = (form as { entries: () => Iterable<unknown> }).entries();
    for (const item of entries) {
      if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
      if (!fields.has(item[0])) fields.set(item[0], item[1]);
    }
  }
  return fields;
}

interface Picked {
  present: boolean;
  value?: unknown;
}

function readField(source: unknown, key: string): Picked {
  if (typeof URLSearchParams !== 'undefined' && source instanceof URLSearchParams) {
    const values = source.getAll(key);
    return values.length === 0 ? { present: false } : { present: true, value: values[0] };
  }
  if (!isRecord(source)) return { present: false };
  const candidate = source[key];
  if (candidate === undefined) {
    return { present: Object.prototype.hasOwnProperty.call(source, key) };
  }
  return { present: true, value: candidate };
}

function readAll(source: unknown, key: string): unknown[] {
  if (!isRecord(source)) return [];
  const getAll = (source as { getAll?: unknown }).getAll;
  if (typeof getAll === 'function') {
    const value = (getAll as (name: string) => unknown).call(source, key);
    return Array.isArray(value) ? value : [];
  }
  const value = source[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === 'string' && single !== '' ? single : undefined;
  }
  return undefined;
}

function isLegacyCoreAction(value: string): value is LegacyCoreAction {
  return (LEGACY_CORE_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileLike(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size > 0
  );
}

function toCamelCase(key: string): string {
  return key.replace(/_+([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());
}
