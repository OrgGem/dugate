import { InvocationRequestSchema, InvocationResponseSchema } from '@du/contracts';
import type { ConnectorErrorCode, InvocationGrant, InvocationResponse } from '@du/contracts';
import type { ConnectorInvocationPayload } from './task-context';

/**
 * Minimal connector invocation client (P4-07). The full typed client with
 * replay/poll lives in @du/connector-client (Copilot lane); the SDK ships
 * this thin transport so worker-sdk has no cross-lane build dependency.
 * Once connector-client is published against frozen contracts, businesses
 * may inject their own invoke function via WorkerConfig.
 */

export interface ConnectorClientOptions {
  baseUrl: string;
  /** Short-lived Bearer identity issued for this worker by the service identity authority. */
  serviceToken?: string | (() => string);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ConnectorTransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: ConnectorErrorCode,
    message?: string
  ) {
    super(message ?? `connector error ${status} ${code}`);
    this.name = 'ConnectorTransportError';
  }
}

const CONNECTOR_CONFLICT_ERROR_CODES = new Set<string>([
  'INPUT_HASH_MISMATCH',
  'CANCELLED',
  'CONNECTOR_DISABLED',
  'INVOCATION_UNKNOWN',
]);
const CONNECTOR_AUTH_ERROR_CODES = new Set<string>(['GRANT_INVALID', 'BINDING_DENIED']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Connector's invocation endpoint uses the { error: { code, message } } wire
 * envelope. Only the documented 409 codes are trusted; an unknown or malformed
 * conflict cannot establish whether this invocation was accepted.
 */
function parseConflictCode(text: string): ConnectorErrorCode | null {
  return parseAllowedErrorCode(text, CONNECTOR_CONFLICT_ERROR_CODES);
}

function parseAllowedErrorCode(text: string, allowedCodes: ReadonlySet<string>): ConnectorErrorCode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const code = parsed.error.code;
  if (
    typeof code !== 'string'
    || !allowedCodes.has(code)
    || typeof parsed.error.message !== 'string'
  ) return null;
  return code as ConnectorErrorCode;
}

function statusErrorCode(status: number): ConnectorErrorCode {
  return status === 429
    ? 'PROVIDER_RATE_LIMITED'
    : status >= 500
      ? 'PROVIDER_UNAVAILABLE'
      : 'INVALID_INPUT';
}

export function createConnectorInvoker(opts: ConnectorClientOptions) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return async function invokeConnector(
    _grant: InvocationGrant,
    payload: ConnectorInvocationPayload
  ): Promise<InvocationResponse> {
    // Validate outgoing payload against the frozen wire contract before send.
    const request = InvocationRequestSchema.parse(payload);
    let serviceToken: string | undefined;
    try {
      serviceToken = typeof opts.serviceToken === 'function' ? opts.serviceToken() : opts.serviceToken;
    } catch {
      throw new ConnectorTransportError(401, 'GRANT_INVALID', 'connector service identity is unavailable');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (typeof serviceToken === 'string' && serviceToken.trim().length > 0) {
      headers.authorization = `Bearer ${serviceToken}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/invocations`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      // Transport failure with unknown outcome: surface as UNKNOWN so the
      // runtime/business reconcile instead of blind-retrying the provider.
      throw new ConnectorTransportError(
        0,
        'INVOCATION_UNKNOWN',
        'connector transport failed; invocation outcome requires reconciliation'
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        let text = '';
        try {
          text = await response.text();
        } catch {
          // Fall back to the status-derived, bounded service identity code.
        }
        const fallback: ConnectorErrorCode = response.status === 401 ? 'GRANT_INVALID' : 'BINDING_DENIED';
        const code = parseAllowedErrorCode(text, CONNECTOR_AUTH_ERROR_CODES) ?? fallback;
        throw new ConnectorTransportError(response.status, code);
      }
      if (response.status === 409) {
        let text: string;
        try {
          text = await response.text();
        } catch {
          throw new ConnectorTransportError(
            409,
            'INVOCATION_UNKNOWN',
            'connector conflict response was interrupted; invocation outcome requires reconciliation'
          );
        }
        const code = parseConflictCode(text) ?? 'INVOCATION_UNKNOWN';
        throw new ConnectorTransportError(409, code);
      }
      throw new ConnectorTransportError(response.status, statusErrorCode(response.status));
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ConnectorTransportError(
        0,
        'INVOCATION_UNKNOWN',
        'connector response was interrupted; invocation outcome requires reconciliation'
      );
    }

    let raw: unknown;
    try {
      raw = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new ConnectorTransportError(
        0,
        'INVOCATION_UNKNOWN',
        'connector response was unreadable; invocation outcome requires reconciliation'
      );
    }
    return InvocationResponseSchema.parse(raw);
  };
}
