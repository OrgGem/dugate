"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unavailable = exports.tooManyRequests = exports.unprocessable = exports.gone = exports.conflict = exports.notFound = exports.forbidden = exports.unauthorized = exports.badRequest = exports.HttpError = void 0;
exports.isHttpError = isHttpError;
exports.zodIssuesToProblem = zodIssuesToProblem;
exports.errorClassOf = errorClassOf;
exports.safeTransportErrorText = safeTransportErrorText;
exports.safeInternalErrorProblem = safeInternalErrorProblem;
const contracts_1 = require("@du/contracts");
/**
 * Domain error carrying an HTTP status + contract error code. Handlers convert
 * these to application/problem+json via toProblem(). Keeps services free of
 * HTTP concerns: a service throws HttpError, the route layer serializes.
 */
class HttpError extends Error {
    status;
    code;
    extra;
    constructor(status, code, message, extra) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
        this.name = 'HttpError';
    }
    toProblem(correlationId) {
        return (0, contracts_1.problem)(this.status, this.code, this.message, undefined, {
            correlationId,
            ...this.extra,
        });
    }
}
exports.HttpError = HttpError;
/**
 * SEC-INT-01 (Tester-1 live finding): class-instance identity SPLITS when the same class
 * is loaded through two module graphs (src via ts-jest vs dist via package main) —
 * 'err instanceof HttpError' is then false for a genuine HttpError and the route
 * boundary answers 500 where a 404 problem+json is owed. Duck-typing on the FULL
 * public shape (status band + contract code + toProblem projection + name) is the
 * cross-graph-safe discriminator; instanceof stays as the fast path.
 */
function isHttpError(err) {
    if (err instanceof HttpError)
        return true;
    if (typeof err !== 'object' || err === null)
        return false;
    const e = err;
    return (typeof e.status === 'number' &&
        e.status >= 400 &&
        e.status <= 599 &&
        typeof e.code === 'string' &&
        typeof e.toProblem === 'function' &&
        e.name === 'HttpError');
}
const badRequest = (msg, extra) => new HttpError(400, 'INVALID_ARGUMENT', msg, extra);
exports.badRequest = badRequest;
const unauthorized = (msg = 'missing or invalid api key') => new HttpError(401, 'UNAUTHENTICATED', msg);
exports.unauthorized = unauthorized;
const forbidden = (msg = 'action not permitted') => new HttpError(403, 'PERMISSION_DENIED', msg);
exports.forbidden = forbidden;
const notFound = (msg) => new HttpError(404, 'NOT_FOUND', msg);
exports.notFound = notFound;
const conflict = (code, msg, extra) => new HttpError(409, code, msg, extra);
exports.conflict = conflict;
const gone = (msg) => new HttpError(410, 'TASK_TERMINAL', msg);
exports.gone = gone;
const unprocessable = (code, msg, extra) => new HttpError(422, code, msg, extra);
exports.unprocessable = unprocessable;
const tooManyRequests = (msg) => new HttpError(429, 'CAPACITY', msg);
exports.tooManyRequests = tooManyRequests;
const unavailable = (msg = 'temporarily unavailable') => new HttpError(503, 'TEMPORARY_UNAVAILABLE', msg);
exports.unavailable = unavailable;
/** Zod issue list → 422 problem with JSON pointers (no secret echo). */
function zodIssuesToProblem(issues) {
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
function errorClassOf(err) {
    return err instanceof Error ? err.name || 'Error' : typeof err;
}
/** Fixed transport-failure copy — replaces every `${prefix}: ${err.message}`. */
function safeTransportErrorText(prefix) {
    return `${prefix}. Details redacted (see server log).`;
}
/**
 * 500 problem+json for non-HttpError throws. Shape is pinned by the W46-C2
 * live sentinel test (stable code + correlationId, nothing else).
 */
function safeInternalErrorProblem(correlationId) {
    return {
        type: 'urn:du:error:temporary_unavailable',
        title: 'internal error',
        status: 500,
        code: 'TEMPORARY_UNAVAILABLE',
        detail: `internal error (correlationId ${correlationId})`,
        correlationId,
    };
}
