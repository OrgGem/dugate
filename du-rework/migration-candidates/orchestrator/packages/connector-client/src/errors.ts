export interface ConnectorClientErrorMeta {
  /** HTTP status when the failure came from a response (0 = transport-level). */
  status?: number;
  /** Whether the runtime may retry the delivery (transport/5xx/429). */
  retryable?: boolean;
}

export class ConnectorClientError extends Error {
  public readonly code: string;
  public readonly retryAfterMs?: number;
  /** Additive (W39-CC2): transport metadata for SDK failure classification. */
  public readonly status?: number;
  public readonly retryable?: boolean;

  public constructor(code: string, message: string, retryAfterMs?: number, meta?: ConnectorClientErrorMeta) {
    super(message);
    this.name = 'ConnectorClientError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.status = meta?.status;
    this.retryable = meta?.retryable;
  }
}
