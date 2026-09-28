/**
 * Redaction is applied to every field before JSON serialization. Error values
 * use the same class-only safe taxonomy as ADM-BASE-03: exception text and
 * stacks are never serialized.
 */

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[-_]?key|provider[-_]?key|access[-_]?key|secret|password|passwd|credential|dsn|database[-_]?url|connection[-_]?string|token|grant|signature|cookie|(?:private|public|crypto)[-_]?key|(?:encryption|decryption|master|wrapped|raw)[-_]?(?:key|dek|kek)|key[-_]?(?:material|bytes|data|pem)|(?:^|[-_])(?:dek|kek)(?:$|[-_])|vault[-_]?(?:path|token)|webhook|payload|request[-_]?body|response[-_]?body|file[-_]?(?:name|filename|path|content)|artifact[-_]?(?:name|filename|path|content)|filename|stack|cause|error[-_]?(?:detail|message))/i;
const SENSITIVE_OBJECT_KEY_PATTERN = /^(?:artifacts?|files?|documents?|attachments?|body|bytes|base64|raw|content|key|dek|kek)$/i;

const URL_PATTERN = /\b(?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"'<>]+/gi;
const URL_CREDENTIALS_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]*@/i;
const SENSITIVE_QUERY_PATTERN = /[?&](?:access[_-]?token|auth(?:orization)?|api[_-]?key|bearer|client[_-]?secret|code|credential|grant|jwt|key|oauth|password|session|signature|sig|token|x-amz-[a-z0-9-]+|x-du-signature|x-hub-signature-256|se|sp|sv)=/i;
const BEARER_PATTERN = /\bBearer\s+[^\s,;"']+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PROVIDER_KEY_PATTERNS: RegExp[] = [
  /\bsk_(?:live|test)_[A-Za-z0-9_-]{4,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi,
  /\bgh[opusr]_[A-Za-z0-9]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:hvs|hvb|hvr)\.[A-Za-z0-9._-]{8,}\b/g,
  /\bs\.[A-Za-z0-9._-]{20,}\b/g,
];
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PUBLIC_KEY_PATTERN = /-----BEGIN [A-Z ]*PUBLIC KEY-----[\s\S]*?-----END [A-Z ]*PUBLIC KEY-----/g;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|credential|signature|sig|(?:private|public|crypto|encryption|decryption|master|wrapped|raw)[ _-]?(?:key|dek|kek)|dek|kek)\s*[:=]\s*([^\s,;&]+)/gi;
const ARTIFACT_NAME_ASSIGNMENT_PATTERN = /\b(file(?:name|path)|artifact(?:name|path)|document(?:name|path)|source(?:file|name))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;&]+)/gi;
const WEBHOOK_BODY_PATTERN = /\bwebhook(?:\s+(?:payload|body|event))?\s*[:=]\s*(?:\{[\s\S]*?\}|\[[\s\S]*?\]|[^\r\n;,]+)/gi;
const ARTIFACT_FILENAME_PATTERN = /\b[\w .()-]{1,160}\.(?:pdf|docx?|xlsx?|pptx?|csv|jsonl?|zip|png|jpe?g|gif|tiff?|txt|md|rtf|odt|ods|parquet|bin)\b/gi;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/](?:[^\s"'<>]+[\\/])*[^\s"'<>]*/g;
const POSIX_SENSITIVE_PATH_PATTERN = /(?:^|\s)(?:\/(?:root|home|Users|usr|var|tmp|mnt|opt|srv|etc|workspace)\/[^\s"'<>]+)/g;
const BASE64_PAYLOAD_PATTERN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{256,}={0,2}(?![A-Za-z0-9+/_=-])/g;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const REDACTED = '[REDACTED]';
export const SAFE_UNEXPECTED_ERROR_KIND = 'UNEXPECTED_ERROR';
export const SAFE_UNEXPECTED_ERROR_MESSAGE = 'Unexpected error; details redacted.';

export interface SafeLogError {
  kind: string;
  message: string;
}

/** ADM-BASE-03 class-only error record; it never inspects exception text. */
export function safeErrorForLog(_error: unknown): SafeLogError {
  return {
    kind: SAFE_UNEXPECTED_ERROR_KIND,
    message: SAFE_UNEXPECTED_ERROR_MESSAGE,
  };
}

/** Redact sensitive values inside a loggable structure (deep, bounded). */
export function redact(value: unknown, maxDepth = 8): unknown {
  return redactValue(value, maxDepth, new WeakSet<object>());
}

function redactValue(value: unknown, maxDepth: number, seen: WeakSet<object>): unknown {
  if (maxDepth <= 0) return '[REDACTED:depth]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[REDACTED:bytes:${value.byteLength}]`;
  }
  if (value instanceof Error) return safeErrorForLog(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED:circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactValue(item, maxDepth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_OBJECT_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (key.toLowerCase() === 'error' || key.toLowerCase() === 'cause') {
      out[key] = safeErrorForLog(child);
    } else {
      out[key] = redactValue(child, maxDepth - 1, seen);
    }
  }
  return out;
}

/** Redact secrets, credential URLs, payloads, paths, and artifact names in text. */
export function redactString(value: string): string {
  let safe = value.replace(PRIVATE_KEY_PATTERN, '[REDACTED:private_key]');
  safe = safe.replace(PUBLIC_KEY_PATTERN, '[REDACTED:public_key]');
  safe = safe.replace(URL_PATTERN, (url) => {
    const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
    const databaseUrl = /^(?:postgres|postgresql|mysql|mariadb|mongodb|mongodb\+srv|redis|rediss)$/.test(scheme);
    if (URL_CREDENTIALS_PATTERN.test(url) || SENSITIVE_QUERY_PATTERN.test(url)) {
      return databaseUrl ? '[REDACTED:database_url]' : '[REDACTED:url]';
    }
    return url;
  });
  safe = safe.replace(BEARER_PATTERN, 'Bearer [REDACTED:bearer]');
  safe = safe.replace(JWT_PATTERN, '[REDACTED:jwt]');
  for (const pattern of PROVIDER_KEY_PATTERNS) safe = safe.replace(pattern, '[REDACTED:provider_key]');
  safe = safe.replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[REDACTED]`);
  safe = safe.replace(
    ARTIFACT_NAME_ASSIGNMENT_PATTERN,
    (_match, key: string) => `${key}=[REDACTED:artifact_name]`,
  );
  safe = safe.replace(WEBHOOK_BODY_PATTERN, 'webhook_payload=[REDACTED:webhook_payload]');
  safe = safe.replace(ARTIFACT_FILENAME_PATTERN, '[REDACTED:artifact_name]');
  safe = safe.replace(WINDOWS_PATH_PATTERN, '[REDACTED:path]');
  safe = safe.replace(POSIX_SENSITIVE_PATH_PATTERN, ' [REDACTED:path]');
  safe = safe.replace(BASE64_PAYLOAD_PATTERN, '[REDACTED:base64]');
  return safe.replace(ANSI_PATTERN, '').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 8192);
}

/** Keys whose values must never appear in logs/metrics even after redaction. */
export const FORBIDDEN_LOG_KEYS = [
  'rawKey',
  'apiKeySecret',
  'password',
  'encryptedValue',
  'promptContent',
  'fileContent',
  'webhookPayload',
  'artifactName',
  'fileName',
  'cryptoKey',
  'encryptionKey',
  'decryptionKey',
  'wrappedDek',
  'dek',
  'kek',
  'keyMaterial',
  'privateKeyPem',
  'publicKeyPem',
] as const;
