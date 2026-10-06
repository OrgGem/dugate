import type { ConnectorErrorCode } from './types';

/**
 * Which connector error codes a caller may safely retry unchanged.
 *
 * This is the single place the retry policy is written down. invokeAdapter uses
 * it when it throws, the HTTP error envelope forwards the value, and the stored
 * invocation record re-derives it on the read path, so the three cannot drift.
 *
 * Only codes that are transient in the strict sense belong here: the identical
 * request can succeed later without anyone changing it. A provider that REFUSED
 * the request is deliberately absent, because the request itself is the problem
 * and a retry only burns budget reproducing it. So is INVOCATION_UNKNOWN, whose
 * outcome must be reconciled against the ledger rather than replayed.
 */
const RETRYABLE_CONNECTOR_ERROR_CODES: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>([
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
]);

export function isRetryableErrorCode(code: ConnectorErrorCode): boolean {
  return RETRYABLE_CONNECTOR_ERROR_CODES.has(code);
}

export class ConnectorError extends Error {
  public readonly code: ConnectorErrorCode;
  public readonly retryAfterMs?: number;
  public readonly safeToRetry: boolean;

  public constructor(
    code: ConnectorErrorCode,
    message: string,
    options: { retryAfterMs?: number; safeToRetry?: boolean } = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.safeToRetry = options.safeToRetry ?? false;
  }
}
