export class ConnectorClientError extends Error {
  public readonly code: string;
  public readonly retryAfterMs?: number;

  public constructor(code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ConnectorClientError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
