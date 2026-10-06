import { InvocationResponseSchema } from '@du/contracts';
import { ConnectorClientError } from './errors';
import { fromContractResponse, toContractRequest } from './contracts';
import type { ClientInvocationRequest, ClientInvocationResult, ConnectorTransport } from './types';

/**
 * Production HTTP transport for the connector service (P4-07 wiring).
 *
 * Wire contract (docs 08, service routes verified against the connector
 * lane's composition):
 *
 *   POST {baseUrl}/invocations              → InvocationResponse
 *   GET  {baseUrl}/invocations/:id          → InvocationResponse
 *   POST {baseUrl}/invocations/:id/cancel   → InvocationResponse (body { reason })
 *
 * This is the production extraction of the transport that the P3-07
 * real-service proof inlined in its test file — same endpoints, same
 * bearer auth, same wire parsing — now shipped as package surface with
 * timeout + typed error metadata (status/retryable) so the worker SDK's
 * failure classification can distinguish transport-retryable failures
 * (429/5xx/status 0) from permanent ones without sniffing message text.
 *
 * The transport never invents outcomes: a rejected fetch surfaces as
 * INVOCATION_UNKNOWN (status 0, retryable) so the caller reconciles via
 * the stable invocationId instead of blind-retrying the provider.
 */

export interface HttpTransportOptions {
  /** Connector internal API base, e.g. http://connector:3100/internal/v1 */
  baseUrl: string;
  /**
   * Bearer service-identity token (or a supplier for rotating tokens).
   * Sent as `authorization: Bearer <token>` on every request.
   */
  token?: string | (() => string);
  /** Injectable fetch (tests/proxies). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 120s — provider calls are slow). */
  timeoutMs?: number;
  /**
   * Resolve the current invocation-bound grant for poll/cancel. Supply this
   * when clients can be recreated or grants must be refreshed after expiry;
   * the process-local cache remains a convenience for same-process flows.
   */
  resolveInvocationGrant?: (invocationId: string) => string | undefined | Promise<string | undefined>;
}

export function createHttpTransport(opts: HttpTransportOptions): ConnectorTransport {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = opts.baseUrl.replace(/\/$/, '');
  const invocationGrants = new Map<string, string>();

  function authHeaders(json: boolean, invocationGrant?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = typeof opts.token === 'function' ? opts.token() : opts.token;
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    if (json) headers['content-type'] = 'application/json';
    if (invocationGrant) headers['x-invocation-grant'] = invocationGrant;
    return headers;
  }

  async function grantFor(invocationId: string): Promise<string | undefined> {
    const resolved = await opts.resolveInvocationGrant?.(invocationId);
    return resolved ?? invocationGrants.get(invocationId);
  }

  async function send(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    signal?: AbortSignal,
    invocationGrant?: string,
  ): Promise<ClientInvocationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Chain the caller's signal (lease loss / cancel) onto the timeout.
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    // FIX-CR-08 / WR24-06: the timeout timer and the chained caller signal must bound the
    // WHOLE request — headers AND body consumption. Pre-fix the finally cleared them the
    // moment headers resolved, leaving `await response.text()` outside every abort scope
    // (stalled body hung forever; caller abort after headers was a no-op).
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: authHeaders(body !== undefined || method === 'POST', invocationGrant),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw classifyTransportFailure(err);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw classifyTransportFailure(err);
      }
      const rawUnknown: unknown = text.length > 0 ? safeJsonParse(text) : undefined;
      return interpretResponse(response, rawUnknown);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** ADM-BASE-03 / C2-2: error class NAME only — never String(err) raw text (driver
   * failures embed DSNs/secrets in their messages, which then ride task errors). */
  function classifyTransportFailure(err: unknown): ConnectorClientError {
    if (err instanceof ConnectorClientError) return err;
    const name =
      err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err.name) ? err.name : 'Error';
    // Transport failure with unknown outcome: reconcile, never blind-retry.
    return new ConnectorClientError(
      'INVOCATION_UNKNOWN',
      `connector transport failure (${name})`,
      undefined,
      { status: 0, retryable: true }
    );
  }

  function interpretResponse(response: Response, raw: unknown): ClientInvocationResult {
    if (!response.ok) {
      const errBody = raw as { error?: { code?: unknown; message?: unknown; retryable?: unknown; retryAfterMs?: unknown }; code?: unknown; detail?: unknown } | null;
      const code = pickString(errBody?.error?.code) ?? pickString(errBody?.code) ?? defaultCodeForStatus(response.status);
      const message =
        pickString(errBody?.error?.message) ??
        pickString(errBody?.detail) ??
        `connector HTTP ${response.status}`;
      const retryAfterMs =
        typeof errBody?.error?.retryAfterMs === 'number' ? errBody.error.retryAfterMs : undefined;
      const wireRetryable =
        typeof errBody?.error?.retryable === 'boolean' ? errBody.error.retryable : undefined;
      throw new ConnectorClientError(code, message, retryAfterMs, {
        status: response.status,
        retryable: wireRetryable ?? fallbackRetryable(code, response.status),
      });
    }

    const parsed = InvocationResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // C2-3 (ADM-BASE-03): zod's invalid_enum_value messages embed the offending VALUE and
      // survive any slice limit (measured 2026-09-25). Emit pointer+issue-code only.
      const pointers = parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '$'}:${issue.code}`)
        .join(', ');
      throw new ConnectorClientError(
        'INVALID_PROVIDER_RESPONSE',
        `connector returned a malformed InvocationResponse (${pointers})`,
        undefined,
        { status: response.status, retryable: false }
      );
    }
    return fromContractResponse(parsed.data);
  }

  return {
    async invoke(request: ClientInvocationRequest, signal?: AbortSignal): Promise<ClientInvocationResult> {
      // Validate against the frozen wire contract before anything leaves
      // the process (contractVersion, UUIDs, grant, deadline). Async so a
      // validation failure surfaces as a rejected promise, never a sync throw.
      const wire = toContractRequest(request);
      invocationGrants.delete(request.invocationId);
      invocationGrants.set(request.invocationId, request.grant);
      while (invocationGrants.size > 512) {
        const oldestInvocationId = invocationGrants.keys().next().value as string | undefined;
        if (!oldestInvocationId) break;
        invocationGrants.delete(oldestInvocationId);
      }
      return send('POST', `${base}/invocations`, wire, signal, request.grant);
    },
    async get(invocationId: string, signal?: AbortSignal, invocationGrant?: string): Promise<ClientInvocationResult> {
      return send(
        'GET',
        `${base}/invocations/${encodeURIComponent(invocationId)}`,
        undefined,
        signal,
        invocationGrant ?? await grantFor(invocationId),
      );
    },
    async cancel(
      invocationId: string,
      reason: string,
      signal?: AbortSignal,
      invocationGrant?: string,
    ): Promise<ClientInvocationResult> {
      return send(
        'POST',
        `${base}/invocations/${encodeURIComponent(invocationId)}/cancel`,
        { reason },
        signal,
        invocationGrant ?? await grantFor(invocationId),
      );
    },
  };
}

/**
 * Retryability when the wire does not carry `error.retryable`.
 *
 * The status alone cannot answer this any more: the service reports a provider that
 * REFUSED the request as 502, and also reports a genuine upstream outage as 502.
 * Collapsing both into `status >= 500` marked a deterministic refusal retryable and
 * invited a caller to burn its budget reproducing it. So when the parsed code says the
 * provider refused, that answer wins over the status; every other code keeps the old
 * status heuristic, which is what a peer running the older service would need.
 */
function fallbackRetryable(code: string, status: number): boolean {
  if (code === 'PROVIDER_REQUEST_REJECTED') return false;
  return status === 429 || status >= 500;
}

function defaultCodeForStatus(status: number): string {
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status === 401 || status === 403) return 'GRANT_INVALID';
  return 'INVALID_INPUT';
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
