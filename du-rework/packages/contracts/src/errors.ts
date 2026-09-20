import { z } from 'zod';

/**
 * Standard error taxonomy (RFC 9457 application/problem+json) shared across
 * public/admin/runtime/connector boundaries. Codes follow the catalogs in
 * docs 06–08.
 */

export const STATUS_CODES = {
  NOT_AUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  GATEWAY: 502,
  TIMEOUT: 504,
} as const;

/** Public/admin API error codes (docs 06). */
export const PublicErrorCodes = [
  'INVALID_API_KEY',
  'INVALID_AUTH',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'STATE_CONFLICT',
  'ARTIFACT_EXPIRED',
  'TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'INVALID_SCHEMA',
  'BUSINESS_VALIDATION',
  'CLIENT_QUOTA',
  'ADMISSION_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
] as const;
export type PublicErrorCode = (typeof PublicErrorCodes)[number];

/** Runtime API error codes (docs 07). */
export const RuntimeErrorCodes = [
  'LEASE_LOST',
  'STATE_CONFLICT',
  'INPUT_HASH_MISMATCH',
  'TASK_TERMINAL',
  'INVALID_SCHEMA',
  'UNREGISTERED_HANDLER',
  'CAPACITY',
  'TEMPORARY_UNAVAILABLE',
  'UNKNOWN_CONTRACT_MAJOR',
  'MANIFEST_DIGEST_MISMATCH',
] as const;
export type RuntimeErrorCode = (typeof RuntimeErrorCodes)[number];

/** Connector error taxonomy (docs 08). */
export const ConnectorErrorCodes = [
  'INVALID_INPUT',
  'CAPABILITY_UNSUPPORTED',
  'GRANT_INVALID',
  'BINDING_DENIED',
  'CREDENTIAL_INVALID',
  'CONNECTOR_DISABLED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'INVALID_PROVIDER_RESPONSE',
  'INVOCATION_UNKNOWN',
  'INPUT_HASH_MISMATCH',
  'QUOTA_EXHAUSTED',
  'CANCELLED',
] as const;
export type ConnectorErrorCode = (typeof ConnectorErrorCodes)[number];

export type AnyErrorCode = PublicErrorCode | RuntimeErrorCode | ConnectorErrorCode;

export const ProblemSchema = z.object({
  type: z.string().url().or(z.string().startsWith('urn:')),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string(),
  detail: z.string().optional(),
  /**
   * Same charset as CORRELATION_ID_REGEX (operations.ts): server-generated IDs
   * are UUIDs, client-echoed IDs may be any [A-Za-z0-9._-]{8,128} token.
   * Widened 2026-09-20 (non-breaking: all previously valid values still parse).
   */
  correlationId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{8,128}$/)
    .optional(),
  /** Field-level violations: JSON pointer → description. Never echoes secrets. */
  errors: z.array(z.object({ pointer: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemSchema>;

export function problem(
  status: number,
  code: AnyErrorCode | (string & {}),
  title: string,
  detail?: string,
  opts: { correlationId?: string; errors?: { pointer: string; message: string }[] } = {}
): ProblemDetails {
  return {
    type: `urn:du:error:${code.toLowerCase()}`,
    title,
    status,
    code,
    detail,
    correlationId: opts.correlationId,
    errors: opts.errors,
  };
}