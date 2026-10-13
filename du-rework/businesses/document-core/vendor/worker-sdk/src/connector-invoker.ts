import { ConnectorErrorCodes, InvocationRequestSchema, InvocationResponseSchema } from '@du/contracts';
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

/**
 * Codes that classifyFailure (worker.ts:510-514) treats as non-retryable whatever the
 * status says. They are deliberately NOT adopted from the envelope here: this path is
 * diagnostics-only, and adopting one of them would silently turn a retryable failure
 * into a non-retryable one, which is a retry-semantics change wearing a diagnostic hat.
 * Excluding them costs nothing in practice — by the connector's own status mapping all
 * four are returned only at 409, and 409 is handled on its own branch above.
 */
const CONNECTOR_RETRY_DECISION_CODES = new Set<string>([
  'INPUT_HASH_MISMATCH',
  'CANCELLED',
  'CONNECTOR_DISABLED',
  'INVOCATION_UNKNOWN',
]);

/** Upper bound on a remote message before it reaches a log or an error detail. */
const MAX_REPORTED_MESSAGE = 1024;

/**
 * Read the connector's own { error: { code, message } } so the failure is reported as the
 * connector described it.
 *
 * Returning null is the safe default and sends the caller back to the status-derived code:
 * the body must parse, carry a code this worker recognises, carry a non-empty message, and
 * not be one of the retry-decision codes above. An unrecognised code is treated as no code
 * at all rather than passed through — a caller switching on a string it has never heard of
 * is exactly the ambiguity this change exists to remove.
 */
function parseReportedErrorCode(text: string): { code: ConnectorErrorCode; message: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const { code, message } = parsed.error;
  if (typeof code !== 'string') return null;
  if (!(ConnectorErrorCodes as readonly string[]).includes(code)) return null;
  if (CONNECTOR_RETRY_DECISION_CODES.has(code)) return null;
  if (typeof message !== 'string' || message.length === 0) return null;
  return {
    code: code as ConnectorErrorCode,
    // Remote text: bound it and flatten line breaks so it cannot forge log lines.
    message: message.slice(0, MAX_REPORTED_MESSAGE).replace(/[\r\n]+/g, ' '),
  };
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
    payload: ConnectorInvocationPayload,
    signal?: AbortSignal
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
    // A REAL cancellation must reach the CONNECTOR too: aborting only this socket
    // would leave the provider call running there - exactly the work the caller
    // asked to stop. The cancel call is best-effort and never changes this
    // request's own outcome. It is sent for a cancellation ONLY: a lease-lost
    // abort fences this delivery (the task is redelivered under a new epoch and
    // replays the same stable invocationId), so terminalising the ledger row
    // there would make the recovered workflow replay a CANCELLED invocation and
    // fail with no provider call to blame (WFA-T26).
    const notifyConnectorCancel = (): void => {
      const invocationId = typeof request.invocationId === 'string' ? request.invocationId : '';
      if (invocationId === '') return;
      const cancelHeaders: Record<string, string> = { 'content-type': 'application/json' };
      if (typeof serviceToken === 'string' && serviceToken.trim().length > 0) {
        cancelHeaders.authorization = `Bearer ${serviceToken}`;
      }
      cancelHeaders['x-invocation-grant'] = _grant.grant;
      void fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/invocations/${encodeURIComponent(invocationId)}/cancel`, {
        method: 'POST',
        headers: cancelHeaders,
        body: JSON.stringify({ reason: 'task cancelled or lease lost' }),
      }).catch(() => undefined);
    };
    const onAbort = (): void => {
      if (signal?.reason === 'cancel') notifyConnectorCancel();
      controller.abort(signal?.reason);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let response: Response;
    try {
      response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/invocations`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) {
        throw new ConnectorTransportError(409, 'CANCELLED', 'connector invocation was cancelled before it completed');
      }
      // Transport failure with unknown outcome: surface as UNKNOWN so the
      // runtime/business reconcile instead of blind-retrying the provider.
      throw new ConnectorTransportError(
        0,
        'INVOCATION_UNKNOWN',
        'connector transport failed; invocation outcome requires reconciliation'
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
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
      // Everything else is reported as the connector described it. The status is still
      // what decides retryability downstream (classifyFailure keys off err.status), so
      // adopting the connector's code here changes what an operator reads, never whether
      // the task is retried.
      let reportedText = '';
      try {
        reportedText = await response.text();
      } catch {
        // Body unreadable: fall back to the status-derived code, as the 401/403 branch
        // already does. The status is the only signal left in that case.
      }
      const reported = parseReportedErrorCode(reportedText);
      throw new ConnectorTransportError(
        response.status,
        reported?.code ?? statusErrorCode(response.status),
        reported?.message ?? `connector error ${response.status}`,
      );
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
