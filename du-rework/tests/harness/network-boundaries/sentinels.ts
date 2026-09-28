/**
 * R1-C sentinel factory. Sentinels must NEVER match packages/observability/src/redaction.ts
 * pattern shapes (signed-url / Bearer / AKIA|ASIA+16) nor sit under a SENSITIVE_KEY_PATTERN
 * key name — otherwise a "no leak" green would be a redactor artifact, not evidence
 * (report qwen3.md sec.5 C2-5). Charset [a-z0-9-] guarantees no pattern can match; the
 * self-check case in each suite proves it against the real redactString (import from
 * @du/observability), which this kit deliberately does NOT re-implement.
 */
import { randomBytes } from 'node:crypto';

export const HARNESS_RUN_ID: string = randomBytes(6).toString('hex');

const SHAPE_RE = /^[a-z0-9]+-[0-9a-f]{12}-[a-z0-9]+$/;

export function mkSentinel(area: string, purpose = 'probe'): string {
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${clean(area)}-${HARNESS_RUN_ID}-${clean(purpose)}`;
}

/** Object key that SENSITIVE_KEY_PATTERN (redaction.ts:6-7) will NOT match, e.g. for header maps. */
export function mkSentinelKey(area: string): string {
  return `x-hn-${area.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/**
 * Admin-error-boundary live-twin shape
 * (services/orchestrator/tests/admin-error-boundary.test.ts:25): secret-shaped text that is
 * invisible to the pattern redactor. The offline twin reuses this exact template so both
 * suites measure the same channel.
 */
export function mkAdminShapeSentinel(): string {
  const id = randomBytes(6).toString('hex');
  // 2026-09-25 revision: the ORIGINAL live-suite shape (SENTINEL-SECRET-sk-…://…) now
  // MATCHES the strengthened observability provider-key patterns (sk-[A-Za-z0-9_-]{8,},
  // added 08:06 alongside LOG-01) — the redactor would hide it and every no-leak green
  // would be vacuous. This replacement keeps the same semantic density (secret marker +
  // credential-looking token + internal host:port + SQL fragment) while staying invisible
  // to every redaction pattern (no sk-/sk_ prefix, no whitelisted :// scheme, no key=value).
  return `SENTINEL-DBURL-${HARNESS_RUN_ID}-${id}@db.internal:5432/prod SELECT * FROM tenants`;
}

/** Self-check used as a [LOCK] case body: returns violations; empty means sentinel is redactor-invisible. */
export function sentinelShapeViolations(sentinel: string, redactString: (s: string) => string): string[] {
  const violations: string[] = [];
  if (!SHAPE_RE.test(sentinel) && !sentinel.startsWith('SENTINEL-DBURL-')) {
    violations.push('shape outside sanctioned sentinel templates');
  }
  if (redactString(sentinel) !== sentinel) {
    violations.push('redactString mutated the sentinel (redactor would hide a real leak)');
  }
  return violations;
}
