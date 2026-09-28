import { ProblemDetails, problem } from '@du/contracts';

/**
 * Domain error carrying an HTTP status + contract error code. Handlers convert
 * these to application/problem+json via toProblem(). Keeps services free of
 * HTTP concerns: a service throws HttpError, the route layer serializes.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Partial<ProblemDetails>
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toProblem(correlationId?: string): ProblemDetails {
    return problem(this.status, this.code, this.message, undefined, {
      correlationId,
      ...this.extra,
    });
  }
}

/**
 * SEC-INT-01 (Tester-1 live finding): class-instance identity SPLITS when the same class
 * is loaded through two module graphs (src via ts-jest vs dist via package main) —
 * 'err instanceof HttpError' is then false for a genuine HttpError and the route
 * boundary answers 500 where a 404 problem+json is owed. Duck-typing on the FULL
 * public shape (status band + contract code + toProblem projection + name) is the
 * cross-graph-safe discriminator; instanceof stays as the fast path.
 */
export function isHttpError(err: unknown): err is HttpError {
  if (err instanceof HttpError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Partial<HttpError>;
  return (
    typeof e.status === 'number' &&
    e.status >= 400 &&
    e.status <= 599 &&
    typeof e.code === 'string' &&
    typeof e.toProblem === 'function' &&
    (e as { name?: unknown }).name === 'HttpError'
  );
}

export const badRequest = (msg: string, extra?: Partial<ProblemDetails>) =>
  new HttpError(400, 'INVALID_ARGUMENT', msg, extra);
export const unauthorized = (msg = 'missing or invalid api key') =>
  new HttpError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'action not permitted') => new HttpError(403, 'PERMISSION_DENIED', msg);
export const notFound = (msg: string) => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
  new HttpError(409, code, msg, extra);
export const gone = (msg: string) => new HttpError(410, 'TASK_TERMINAL', msg);
export const unprocessable = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
  new HttpError(422, code, msg, extra);
export const tooManyRequests = (msg: string) => new HttpError(429, 'CAPACITY', msg);
export const unavailable = (msg = 'temporarily unavailable') =>
  new HttpError(503, 'TEMPORARY_UNAVAILABLE', msg);

/** Zod issue list → 422 problem with JSON pointers (no secret echo). */
export function zodIssuesToProblem(
  issues: { path: (string | number)[]; message: string }[]
): HttpError {
  return new HttpError(422, 'INVALID_SCHEMA', 'request validation failed', {
    errors: issues.slice(0, 50).map((i) => ({
      pointer: '/' + i.path.join('/'),
      message: i.message,
    })),
  });
}

/**
 * ADM-BASE-03 (tasks/SEC-OIDC-VAULT-2026-09-24.md): the one text policy for
 * surfaces that show UNEXPECTED errors (HTTP problem bodies, rendered Admin
 * pages, logs). Raw `err.message`/`String(err)` must never enter any of
 * them — DB drivers, HTTP clients and (once VAULT/OIDC land) upstream
 * Vault/IdP errors can echo DSNs with passwords, filesystem paths or bearer
 * tokens. Only stable codes, fixed safe text and correlation IDs cross the
 * boundary; operators join a wire correlationId to the class-only log line.
 */
export function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.name || 'Error' : typeof err;
}

/** Fixed transport-failure copy — replaces every `${prefix}: ${err.message}`. */
export function safeTransportErrorText(prefix: string): string {
  return `${prefix}. Details redacted (see server log).`;
}

/**
 * 500 problem+json for non-HttpError throws. Shape is pinned by the W46-C2
 * live sentinel test (stable code + correlationId, nothing else).
 */
export function safeInternalErrorProblem(correlationId: string): Record<string, unknown> {
  return {
    type: 'urn:du:error:temporary_unavailable',
    title: 'internal error',
    status: 500,
    code: 'TEMPORARY_UNAVAILABLE',
    detail: `internal error (correlationId ${correlationId})`,
    correlationId,
  };
}
