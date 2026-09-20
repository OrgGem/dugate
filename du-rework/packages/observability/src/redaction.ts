/**
 * Redaction (docs 12): secrets, raw prompts, document content, signed URLs
 * and Authorization headers are never logged by default.
 */

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[-_]?key|secret|password|token|credential|grant|signature|cookie|x-api-key)/i;

const SIGNED_URL_PATTERN = /\bhttps?:\/\/[^\s"']*[?&](X-Amz-|x-amz-|sig=|Signature=|se=|sp=|sv=)[^\s"']*/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AWS_KEY_PATTERN = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;

export const REDACTED = '[REDACTED]';

/** Redact sensitive values inside a loggable structure (deep, bounded). */
export function redact(value: unknown, maxDepth = 8): unknown {
  if (maxDepth <= 0) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, maxDepth - 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: REDACTED };
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redact(v, maxDepth - 1);
    }
    return out;
  }
  return value;
}

/** Redact sensitive substrings inside a plain string. */
export function redactString(s: string): string {
  return s
    .replace(SIGNED_URL_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(AWS_KEY_PATTERN, REDACTED);
}

/** Keys whose values must never appear in logs/metrics even after redaction. */
export const FORBIDDEN_LOG_KEYS = [
  'rawKey',
  'apiKeySecret',
  'password',
  'encryptedValue',
  'promptContent',
  'fileContent',
] as const;