import type { ConnectorErrorCode } from './types';

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
