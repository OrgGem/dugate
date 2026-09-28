// Redaction + log-schema helpers — pure functions, no I/O, no DB, no logging.
// Scope: HTTP / Admin surface owned by the OpenClaude lane (LOG-01).
// Reference: docs/37-log-schema.md §4.
//
// This file is intentionally in the OpenClaude lane (tests/login/src/) so it
// does NOT touch services/orchestrator/src/** (Claude Code's lane) or any
// other lane's source. The platform lane's PLATFORM REQUEST diff is what wires
// this same shape into services/orchestrator/src/http/ingress.ts and the
// Admin shell handlers.

const REDACTION_TOKENS = {
  api_key: '[REDACTED:api_key]',
  bearer: '[REDACTED:bearer]',
  jwt: '[REDACTED:jwt]',
  connector_credential: '[REDACTED:connector_credential]',
  signed_url: '[REDACTED:signed_url]',
  bytes: '[REDACTED:bytes:N]',
  vault_path: '[REDACTED:vault_path]',
  webhook_payload: '[REDACTED:webhook_payload]',
  webhook_signature: '[REDACTED:webhook_signature]',
  depth: '[REDACTED:depth>6]',
};

const MAX_DEPTH = 6;
const MAX_BYTES = 256;
const MAX_BODY_BYTES = 4 * 1024;

const SENTINEL_FIELDS = new Set([
  'api_key', 'apiKey', 'x-api-key', 'x_api_key',
  'authorization', 'Authorization',
  'jwt', 'token',
  'connector_secret', 'connectorCredential', 'connector_password', 'connectorPassword',
  'api_secret', 'apiSecret', 'client_secret', 'clientSecret',
  'webhook_secret', 'webhookSecret',
  'X-DU-Signature', 'x-du-signature',
  'X-Hub-Signature-256', 'x-hub-signature-256',
  'vault_path', 'vaultPath',
  'webhook_payload', 'webhookPayload',
]);

const SENTINEL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'api_key_prefix', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'slack_token', re: /\bxox[bp]-[A-Za-z0-9-]{10,}/g },
  { name: 'github_token', re: /\bgh[posru]_[A-Za-z0-9]{20,}/g },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'vault_token', re: /\b(?:hvs|hvb|s)\.[A-Za-z0-9]{20,}/g },
];

export type RedactedScalar = string | number | boolean | null;
export type Redacted =
  | RedactedScalar
  | { [k: string]: Redacted }
  | Redacted[]
  | '[REDACTED:bytes:N]'
  | '[REDACTED:depth>6]';

export function isSensitiveField(name: string): boolean {
  return SENTINEL_FIELDS.has(name);
}

export function redactStringScalar(value: string): RedactedScalar {
  let out = value;
  for (const { re } of SENTINEL_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTION_TOKENS.jwt);
  }
  return out;
}

export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): Redacted {
  if (depth > MAX_DEPTH) return REDACTION_TOKENS.depth as Redacted;
  if (value === null || value === undefined) return value === undefined ? null : null;
  if (typeof value === 'string') return redactStringScalar(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Buffer || value instanceof Uint8Array) {
    return `[REDACTED:bytes:${value.byteLength}]` as Redacted;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    return value.map((v) => redactValue(v, depth + 1, seen)) as Redacted;
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) return null;
    seen.add(value as object);
    const out: { [k: string]: Redacted } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveField(k)) {
        if (k === 'api_key' || k === 'apiKey' || k === 'x-api-key' || k === 'x_api_key') {
          out[k] = REDACTION_TOKENS.api_key as Redacted;
        } else if (k.toLowerCase() === 'authorization' && typeof v === 'string' && /^Bearer\s+/i.test(v)) {
          out[k] = REDACTION_TOKENS.bearer as Redacted;
        } else if (
          k === 'x-du-signature' ||
          k === 'X-DU-Signature' ||
          k === 'x-hub-signature-256' ||
          k === 'X-Hub-Signature-256'
        ) {
          out[k] = REDACTION_TOKENS.webhook_signature as Redacted;
        } else if (k === 'vault_path' || k === 'vaultPath') {
          out[k] = REDACTION_TOKENS.vault_path as Redacted;
        } else if (k === 'webhook_payload' || k === 'webhookPayload') {
          out[k] = REDACTION_TOKENS.webhook_payload as Redacted;
        } else if (k === 'token' || k === 'jwt') {
          out[k] = REDACTION_TOKENS.jwt as Redacted;
        } else {
          out[k] = REDACTION_TOKENS.connector_credential as Redacted;
        }
        continue;
      }
      if (typeof v === 'string' && looksLikeSignedUrl(v)) {
        out[k] = REDACTION_TOKENS.signed_url as Redacted;
        continue;
      }
      if (typeof v === 'string' && v.length >= MAX_BYTES && looksLikeBase64(v)) {
        out[k] = `[REDACTED:bytes:${Buffer.byteLength(v, 'utf8')}]` as Redacted;
        continue;
      }
      out[k] = redactValue(v, depth + 1, seen);
    }
    return out;
  }
  return null;
}

function looksLikeSignedUrl(value: string): boolean {
  if (!value.startsWith('http://') && !value.startsWith('https://')) return false;
  return /[?&](?:signature|sig|X-Amz-Signature|X-Amz-Credential)=/i.test(value);
}

function looksLikeBase64(value: string): boolean {
  if (value.length < MAX_BYTES) return false;
  // Lenient: allow URL-safe + standard; reject obvious JSON bodies (no '='-padded
  // tail, but allow '=' padding). Pure-whitespace early-out prevents walking a
  // formatted string. The check is a heuristic — the real protection is the
  // schema-level field-name sensitivity above.
  if (/[\s{}[\]":,]/.test(value)) return false;
  return /^[A-Za-z0-9+/_-]+=*$/.test(value);
}

// ────────────────────────────────────────────────────────────────────────────
// Truncation + schema-shape helpers
// ────────────────────────────────────────────────────────────────────────────

export function truncateRedactedBody(body: Redacted, maxBytes = MAX_BODY_BYTES): string {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return json;
  // Iteratively shrink the prefix until the final envelope (which re-stringifies
  // the prefix — adding escape overhead for embedded `"`) fits in maxBytes.
  const bytesTotal = Buffer.byteLength(json, 'utf8');
  let prefix = json;
  while (prefix.length > 0) {
    const envelope = JSON.stringify({
      __truncated__: true,
      bytes: bytesTotal,
      prefix,
    });
    if (Buffer.byteLength(envelope, 'utf8') <= maxBytes) return envelope;
    // Drop a chunk and re-trim to the last complete string boundary.
    prefix = prefix.slice(0, Math.max(0, prefix.length - 256));
    const lastQuote = prefix.lastIndexOf('"');
    if (lastQuote >= 0) prefix = prefix.slice(0, lastQuote);
  }
  return JSON.stringify({ __truncated__: true, bytes: bytesTotal, prefix: '' });
}

export const REQUIRED_SCHEMA_KEYS = ['ts', 'level', 'service', 'version', 'environment', 'message'] as const;

export type LogLine = {
  ts: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  service: string;
  version: string;
  environment: 'dev' | 'test' | 'staging' | 'prod';
  message: string;
  correlation_id?: string;
  request_id?: string;
  task_id?: string;
  operation_id?: string;
  invocation_id?: string;
  tenant_id?: string;
  duration_ms?: number;
  exit_code?: number;
  error?: { kind: string; message: string; stack?: string };
};

export function isValidIso8601Utc(s: string): boolean {
  // YYYY-MM-DDTHH:MM:SS(.fff)?Z — strict shape, no timezone other than 'Z'.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s);
}

export function assertSchema(line: unknown): asserts line is LogLine {
  if (typeof line !== 'object' || line === null) {
    throw new Error('log line is not an object');
  }
  for (const k of REQUIRED_SCHEMA_KEYS) {
    if (!(k in line)) throw new Error(`log line missing required key: ${k}`);
  }
  if (!isValidIso8601Utc((line as LogLine).ts)) throw new Error('log line ts is not ISO 8601 UTC');
  const levels: ReadonlyArray<string> = ['trace', 'debug', 'info', 'warn', 'error'];
  if (!levels.includes((line as LogLine).level)) throw new Error(`log line level invalid: ${(line as LogLine).level}`);
  const envs: ReadonlyArray<string> = ['dev', 'test', 'staging', 'prod'];
  if (!envs.includes((line as LogLine).environment)) throw new Error(`log line environment invalid: ${(line as LogLine).environment}`);
}

export const MUST_NOT_APPEAR: ReadonlyArray<RegExp> = SENTINEL_PATTERNS.map(({ re }) => re);

export function findSentMatches(json: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SENTINEL_PATTERNS) {
    re.lastIndex = 0;
    const m = json.match(re);
    if (m) hits.push(`${name}:${m[0]}`);
  }
  return hits;
}