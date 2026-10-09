import type { AesCredentialCipher } from '../services';
import { assertSafeMapping } from '../adapters/mapping';
import type { AdapterConfig } from '../types';

export type LegacyConnectorAdapterErrorCode =
  | 'INVALID_SOURCE'
  | 'INVALID_JSON'
  | 'INVALID_ENDPOINT'
  | 'UNSUPPORTED_HTTP_METHOD'
  | 'UNSUPPORTED_AUTH_TYPE'
  | 'INVALID_AUTH_HEADER'
  | 'INVALID_TIMEOUT'
  | 'UNMAPPABLE_STATE'
  | 'MISSING_SECRET'
  | 'ENCRYPTION_KEY_MISSING'
  | 'ENCRYPTION_FAILED'
  | 'UNSAFE_FIELD_MAPPING';

export class LegacyConnectorAdapterError extends Error {
  public constructor(public readonly code: LegacyConnectorAdapterErrorCode) {
    super('Legacy connector row cannot be projected safely: ' + code + '.');
    this.name = 'LegacyConnectorAdapterError';
  }
}

/** Shape recorded by LDBA-00 for ExternalApiConnection. IDs remain text. */
export interface LegacyExternalApiConnectionRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  endpointUrl: string;
  httpMethod: string;
  authType: string;
  authSecret: string | null;
  authKeyHeader: string;
  promptFieldName: string;
  fileFieldName: string | null;
  fileUrlFieldName: string | null;
  defaultPrompt: string | null;
  staticFormFields: string | null;
  extraHeaders: string | null;
  responseContentPath: string;
  sessionIdResponsePath: string | null;
  sessionIdFieldName: string | null;
  timeoutSec: number;
  state: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface LegacyConnectorConfig extends AdapterConfig {
  name: string;
  slug: string;
  description: string | null;
  endpointUrl: string;
  httpMethod: string;
  authType: string;
  authKeyHeader: string;
  promptFieldName: string;
  fileFieldName: string | null;
  fileUrlFieldName: string | null;
  defaultPrompt: string | null;
  staticFormFields: unknown;
  extraHeaders: Readonly<Record<string, string>> | null;
  responseContentPath: string;
  sessionIdResponsePath: string | null;
  sessionIdFieldName: string | null;
  timeoutSec: number;
}

export interface LegacyConnectorRevisionProjection {
  connectorId: string;
  revision: 1;
  adapter: 'json-http' | 'multipart-http';
  config: LegacyConnectorConfig;
  credentialRef: string;
  state: 'ACTIVE' | 'RETIRED';
  credentialSource: { kind: 'legacy-db'; credentialRef: string };
  tenantId: '';
  createdAt: Date;
}

export interface LegacySecretVersionProjection {
  id: string;
  credentialRef: string;
  encryptedValue: Uint8Array;
}

export interface LegacyConnectorProjection {
  revision: LegacyConnectorRevisionProjection;
  secretVersion: LegacySecretVersionProjection;
  /** Source evidence only; connector_revisions has no updated_at destination. */
  sourceUpdatedAt: Date;
}

const LEGACY_REVISION = 1 as const;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Pure offline projection. It does not access SQL or run migrations.
 * The cipher is mandatory so missing key configuration stops this row before
 * either projected record can be returned.
 */
export function projectLegacyExternalApiConnection(
  source: LegacyExternalApiConnectionRow,
  cipher: AesCredentialCipher | undefined,
): LegacyConnectorProjection {
  if (source === null || typeof source !== 'object') fail('INVALID_SOURCE');
  validateSource(source);
  if (typeof source.authSecret !== 'string' || source.authSecret.length === 0) fail('MISSING_SECRET');
  if (!cipher) fail('ENCRYPTION_KEY_MISSING');
  if (source.httpMethod !== 'POST') fail('UNSUPPORTED_HTTP_METHOD');
  if (source.authType !== 'API_KEY_HEADER') fail('UNSUPPORTED_AUTH_TYPE');
  if (typeof source.authKeyHeader !== 'string' || !HTTP_HEADER_NAME.test(source.authKeyHeader)) {
    fail('INVALID_AUTH_HEADER');
  }
  if (!Number.isInteger(source.timeoutSec) || source.timeoutSec <= 0) fail('INVALID_TIMEOUT');

  const endpoint = parseEndpoint(source.endpointUrl);
  const sourceCreatedAt = timestamp(source.createdAt);
  const sourceUpdatedAt = timestamp(source.updatedAt);
  const staticFormFields = parseJsonColumn(source.staticFormFields);
  const extraHeaders = parseHeaders(source.extraHeaders);
  const state = mapState(source.state);
  const requestMapping = Object.create(null) as Record<string, string>;

  addMapping(requestMapping, source.promptFieldName, 'input.prompt');
  if (source.fileFieldName && source.fileFieldName.trim().length > 0) {
    addMapping(requestMapping, source.fileFieldName, 'input.artifacts');
  }
  if (source.sessionIdFieldName && source.sessionIdFieldName.trim().length > 0) {
    addMapping(requestMapping, source.sessionIdFieldName, 'sessionRef');
  }

  const responseMapping: Record<string, string> = {
    content: source.responseContentPath,
  };
  if (source.sessionIdResponsePath && source.sessionIdResponsePath.trim().length > 0) {
    responseMapping.sessionRef = source.sessionIdResponsePath;
  }

  try {
    assertSafeMapping(requestMapping);
    assertSafeMapping(responseMapping);
  } catch {
    fail('UNSAFE_FIELD_MAPPING');
  }

  let encryptedValue: Uint8Array;
  try {
    encryptedValue = Uint8Array.from(cipher.encrypt(source.authSecret));
  } catch {
    fail('ENCRYPTION_FAILED');
  }
  const plaintextBytes = Buffer.from(source.authSecret, 'utf8');
  if (encryptedValue.byteLength < 28 || Buffer.from(encryptedValue).equals(plaintextBytes)) {
    fail('ENCRYPTION_FAILED');
  }

  const credentialRef = 'legacy-db:connector:' + source.id;
  const adapter = source.fileFieldName && source.fileFieldName.trim().length > 0
    ? 'multipart-http'
    : 'json-http';
  const config: LegacyConnectorConfig = {
    baseUrl: endpoint.origin,
    path: endpoint.pathname + endpoint.search,
    headers: extraHeaders ?? undefined,
    requestMapping,
    responseMapping,
    timeoutMs: source.timeoutSec * 1000,
    credentialSlot: 'header:' + source.authKeyHeader,
    name: source.name,
    slug: source.slug,
    description: source.description,
    endpointUrl: source.endpointUrl,
    httpMethod: source.httpMethod,
    authType: source.authType,
    authKeyHeader: source.authKeyHeader,
    promptFieldName: source.promptFieldName,
    fileFieldName: source.fileFieldName,
    fileUrlFieldName: source.fileUrlFieldName,
    defaultPrompt: source.defaultPrompt,
    staticFormFields,
    extraHeaders,
    responseContentPath: source.responseContentPath,
    sessionIdResponsePath: source.sessionIdResponsePath,
    sessionIdFieldName: source.sessionIdFieldName,
    timeoutSec: source.timeoutSec,
  };

  return {
    revision: {
      connectorId: source.id,
      revision: LEGACY_REVISION,
      adapter,
      config,
      credentialRef,
      state,
      credentialSource: { kind: 'legacy-db', credentialRef },
      // Migration 008 requires legacy-db rows to remain unbound.
      tenantId: '',
      createdAt: sourceCreatedAt,
    },
    secretVersion: {
      id: 'legacy-db:secret:' + source.id + ':1',
      credentialRef,
      encryptedValue,
    },
    sourceUpdatedAt,
  };
}

function mapState(state: string): 'ACTIVE' | 'RETIRED' {
  if (state === 'ENABLED') return 'ACTIVE';
  // Migration 006 already normalizes DISABLED rows to RETIRED. This is
  // terminal in the current lifecycle and can remove legacy re-enable behavior.
  if (state === 'DISABLED') return 'RETIRED';
  return fail('UNMAPPABLE_STATE');
}

function parseEndpoint(value: string): URL {
  try {
    const endpoint = new URL(value);
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
      || endpoint.username.length > 0
      || endpoint.password.length > 0
      || endpoint.hash.length > 0) {
      return fail('INVALID_ENDPOINT');
    }
    return endpoint;
  } catch {
    return fail('INVALID_ENDPOINT');
  }
}

function parseJsonColumn(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail('INVALID_JSON');
  }
}

function parseHeaders(value: string | null): Readonly<Record<string, string>> | null {
  const parsed = parseJsonColumn(value);
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return fail('INVALID_JSON');
  const headers = Object.create(null) as Record<string, string>;
  for (const [name, content] of Object.entries(parsed)) {
    if (!HTTP_HEADER_NAME.test(name) || typeof content !== 'string') fail('INVALID_JSON');
    headers[name] = content;
  }
  return headers;
}

function timestamp(value: Date | string): Date {
  const candidate = value instanceof Date
    ? new Date(value.getTime())
    : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + 'Z');
  if (!Number.isFinite(candidate.getTime())) return fail('INVALID_SOURCE');
  return candidate;
}

function addMapping(mapping: Record<string, string>, fieldName: string, sourcePath: string): void {
  if (typeof fieldName !== 'string' || fieldName.trim().length === 0) fail('INVALID_SOURCE');
  const existing = mapping[fieldName];
  if (existing !== undefined && existing !== sourcePath) fail('UNSAFE_FIELD_MAPPING');
  mapping[fieldName] = sourcePath;
}

function validateSource(source: LegacyExternalApiConnectionRow): void {
  if (typeof source.id !== 'string' || source.id.length === 0
    || typeof source.name !== 'string'
    || typeof source.slug !== 'string'
    || (source.description !== null && typeof source.description !== 'string')
    || typeof source.endpointUrl !== 'string'
    || typeof source.httpMethod !== 'string'
    || typeof source.authType !== 'string'
    || (source.authSecret !== null && typeof source.authSecret !== 'string')
    || typeof source.authKeyHeader !== 'string'
    || typeof source.promptFieldName !== 'string'
    || (source.fileFieldName !== null && typeof source.fileFieldName !== 'string')
    || (source.fileUrlFieldName !== null && typeof source.fileUrlFieldName !== 'string')
    || (source.defaultPrompt !== null && typeof source.defaultPrompt !== 'string')
    || (source.staticFormFields !== null && typeof source.staticFormFields !== 'string')
    || (source.extraHeaders !== null && typeof source.extraHeaders !== 'string')
    || typeof source.responseContentPath !== 'string'
    || (source.sessionIdResponsePath !== null && typeof source.sessionIdResponsePath !== 'string')
    || (source.sessionIdFieldName !== null && typeof source.sessionIdFieldName !== 'string')
    || typeof source.state !== 'string') {
    fail('INVALID_SOURCE');
  }
}

function fail(code: LegacyConnectorAdapterErrorCode): never {
  throw new LegacyConnectorAdapterError(code);
}
