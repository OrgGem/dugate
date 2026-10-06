/**
 * BFF error envelope (AWEB-02).
 *
 * The Admin Web BFF answers the SAME problem+json shape as the platform JSON
 * API (`@du/contracts` `problem()`), so the browser has exactly one typed
 * decoder. Upstream bodies are NEVER echoed: only a bounded, sanitized code /
 * field-error projection crosses the boundary.
 */
import { problem, type ProblemDetails } from '@du/contracts';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** BFF-owned failure (fence, CSRF, validation) — mapped to a problem body. */
export class BffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BffError';
  }
}

const MAX_MESSAGE = 200;
const MAX_UPSTREAM_CODE = 64;

/** Trim/limit a message so no unbounded upstream text can ride the wire. */
export function boundedMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Strip control characters (log/terminal injection hygiene) and collapse.
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped.length === 0) return undefined;
  return stripped.length > MAX_MESSAGE ? stripped.slice(0, MAX_MESSAGE) : stripped;
}

export function problemBody(
  status: number,
  code: string,
  title: string,
  correlationId: string,
  errors?: { pointer: string; message: string }[],
): ProblemDetails {
  return problem(status, code, title, undefined, {
    correlationId,
    ...(errors && errors.length > 0 ? { errors } : {}),
  });
}

/**
 * Upstream (platform JSON API) failure → BFF problem.
 *  - 4xx: status + code are passed through (409 REVISION_CONFLICT, 422 …),
 *    field errors are copied through a sanitizer.
 *  - 5xx: collapsed to a fixed 502 UPSTREAM_ERROR — platform internals stay
 *    inside the platform.
 */
export function upstreamProblem(
  status: number,
  upstreamCode: unknown,
  upstreamErrors: unknown,
  correlationId: string,
): ProblemDetails {
  if (status >= 500) {
    return problemBody(502, 'UPSTREAM_ERROR', 'The admin API failed to complete the request', correlationId);
  }
  const code =
    typeof upstreamCode === 'string' && /^[A-Z0-9_]{3,64}$/.test(upstreamCode.slice(0, MAX_UPSTREAM_CODE))
      ? upstreamCode
      : 'UPSTREAM_REJECTED';
  return problemBody(status, code, 'The admin API rejected the request', correlationId, sanitizeFieldErrors(upstreamErrors));
}

function sanitizeFieldErrors(input: unknown): { pointer: string; message: string }[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: { pointer: string; message: string }[] = [];
  for (const item of input.slice(0, 50)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const pointer = (item as { pointer?: unknown }).pointer;
    const message = boundedMessage((item as { message?: unknown }).message);
    if (typeof pointer === 'string' && pointer.length > 0 && pointer.length <= 128 && message) {
      out.push({ pointer, message });
    }
  }
  return out.length > 0 ? out : undefined;
}
