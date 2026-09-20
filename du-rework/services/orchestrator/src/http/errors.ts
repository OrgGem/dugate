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
