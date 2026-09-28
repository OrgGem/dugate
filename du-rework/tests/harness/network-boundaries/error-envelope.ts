/**
 * R1-C problem+json envelope validator for the repo's profile.
 * NOT RFC 7807: this repo ships the RFC 9457 profile of @du/contracts
 * (packages/contracts/src/errors.ts:4, problem() at :106-114) — `urn:du:error:<code>` +
 * `code` + `correlationId` + `errors[].pointer`, and `stack` must never appear at any depth.
 * A 7807-shaped validator would fail the repo's valid envelopes (report qwen3.md sec.10(3)).
 */

export const PROBLEM_KEYS: readonly string[] = ['type', 'title', 'status', 'code', 'detail', 'correlationId', 'errors'];

export interface EnvelopeCheck {
  /** Wire HTTP status the envelope must agree with. */
  status: number;
  code?: string;
  requireCorrelationId?: boolean;
}

function deepFindings(value: unknown, path: string, findings: string[], seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((v, i) => deepFindings(v, `${path}[${i}]`, findings, seen));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'stack') findings.push(`${path}: forbidden key 'stack' at depth`);
    deepFindings(v, `${path}.${k}`, findings, seen);
  }
}

export function findEnvelopeViolations(value: unknown, check: EnvelopeCheck): string[] {
  const findings: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['body is not a JSON object'];
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!PROBLEM_KEYS.includes(k)) findings.push(`unexpected top-level key '${k}'`);
  }
  if (typeof obj.type !== 'string' || !(obj.type.startsWith('urn:') || /^https?:\/\/.+/.test(obj.type))) {
    findings.push('type must be a URI (urn: or http[s]:)');
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) findings.push('title must be a non-empty string');
  if (!Number.isInteger(obj.status) || obj.status !== check.status) {
    findings.push(`status must be integer ${check.status}, got ${JSON.stringify(obj.status)}`);
  }
  if (typeof obj.code !== 'string' || obj.code.length === 0) findings.push('code must be a non-empty string (repo profile)');
  if (check.code !== undefined && obj.code !== check.code) findings.push(`code must be '${check.code}'`);
  // NOTE: problem() (contracts/src/errors.ts:106-114) ALWAYS sets every key, including
  // undefined values — `in` checks misfire on raw objects; undefined === absent-on-wire.
  if (obj.detail !== undefined && typeof obj.detail !== 'string') findings.push('detail must be string when present');
  if (obj.correlationId !== undefined && !/^[A-Za-z0-9._-]{8,128}$/.test(String(obj.correlationId))) {
    findings.push('correlationId violates ^[A-Za-z0-9._-]{8,128}$');
  }
  if (check.requireCorrelationId && typeof obj.correlationId !== 'string') findings.push('correlationId required');
  if (obj.errors !== undefined) {
    if (!Array.isArray(obj.errors)) findings.push('errors must be an array');
    else {
      obj.errors.forEach((e, i) => {
        if (e === null || typeof e !== 'object' || Array.isArray(e)) {
          findings.push(`errors[${i}] must be object`);
          return;
        }
        const eo = e as Record<string, unknown>;
        const keys = Object.keys(eo);
        if (keys.length !== 2 || !keys.includes('pointer') || !keys.includes('message')) {
          findings.push(`errors[${i}] keys must be exactly {pointer,message}`);
        }
        if (typeof eo.pointer !== 'string') findings.push(`errors[${i}].pointer must be string`);
        if (typeof eo.message !== 'string') findings.push(`errors[${i}].message must be string`);
      });
    }
  }
  deepFindings(obj, '$', findings, new WeakSet<object>());
  return findings;
}

export function assertProblemEnvelope(value: unknown, check: EnvelopeCheck): void {
  const violations = findEnvelopeViolations(value, check);
  if (violations.length > 0) {
    throw new Error(`problem+json envelope violations:\n - ${violations.join('\n - ')}`);
  }
}
