import {
  InvocationGrant,
  InvocationRequestSchema,
  InvocationResponse,
  InvocationResponseSchema,
} from '@du/contracts';
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
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ConnectorTransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? `connector error ${status} ${code}`);
    this.name = 'ConnectorTransportError';
  }
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      // Transport failure with unknown outcome: surface as UNKNOWN so the
      // runtime/business reconcile instead of blind-retrying the provider.
      throw new ConnectorTransportError(0, 'INVOCATION_UNKNOWN', `transport failure: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    const raw: unknown = text.length > 0 ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const code =
        response.status === 409
          ? 'INVOCATION_UNKNOWN'
          : response.status === 429
            ? 'PROVIDER_RATE_LIMITED'
            : response.status >= 500
              ? 'PROVIDER_UNAVAILABLE'
              : 'INVALID_INPUT';
      throw new ConnectorTransportError(response.status, code, text.slice(0, 512));
    }
    return InvocationResponseSchema.parse(raw);
  };
}