import { HttpError, isHttpError } from '../../http/errors';

/**
 * Connector management proxy (P2-07 / CON-03, W39-C).
 *
 * The platform fronts live Connector HTTP access so tenant callers never hold
 * Connector credentials or internal network addresses. The only live operation
 * in this slice is the health/test probe: `GET /api/v1/connectors/:id/test`
 * fans out to the Connector's `/health/ready` and returns a sanitized
 * `{ connectorId, ok, latencyMs, provider }` envelope.
 *
 * Hard rules (docs 06/07, §R08):
 * - The Connector base URL is a platform configuration value, never derived
 *   from caller input (no open proxy / SSRF surface through this route).
 * - No credential material is attached to the probe and none is accepted
 *   from the caller.
 * - Upstream headers are NEVER forwarded or echoed. Upstream error bodies are
 *   NEVER returned; failures surface as a sanitized ProblemDetails the
 *   platform fully controls.
 * - The probe has a hard timeout; a hung Connector degrades to a sanitized
 *   failure rather than hanging the platform request.
 */

export interface ConnectorProbeOutcome {
  connectorId: string;
  ok: boolean;
  latencyMs: number;
}

export interface ConnectorProxy {
  /** Probe the registered Connector's readiness; never throws raw upstream errors. */
  testConnector(connectorId: string): Promise<ConnectorProbeOutcome>;
}

export interface ConnectorRegistry {
  /** Resolve the platform-configured base URL for a Connector id (fail-closed 404). */
  baseUrlFor(connectorId: string): string;
}

const PROBE_TIMEOUT_MS = 5_000;

export function createConnectorProxy(
  connectors: ConnectorRegistry,
  opts?: { fetchFn?: typeof fetch; timeoutMs?: number }
): ConnectorProxy {
  const fetchFn = opts?.fetchFn ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;
  return {
    async testConnector(connectorId: string): Promise<ConnectorProbeOutcome> {
      const base = connectors.baseUrlFor(connectorId);
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // The probe carries no auth and no caller headers — deliberately a
        // bare GET against the platform-configured base URL. Anything the
        // Connector needs for its own identity terminates inside the
        // Connector, never in this proxy.
        const res = await fetchFn(`${base.replace(/\/+$/, '')}/health/ready`, {
          method: 'GET',
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;
        // The upstream body is intentionally NOT parsed or echoed: only the
        // status determines readiness.
        await res.arrayBuffer().catch(() => undefined);
        if (res.status === 200) return { connectorId, ok: true, latencyMs };
        throw new HttpError(
          502,
          'CONNECTOR_UNHEALTHY',
          `connector ${connectorId} reported unhealthy`
        );
      } catch (err) {
        if (isHttpError(err)) throw err;
        // Sanitized failure: never leak the upstream error text, URL, stack,
        // or timing internals to the caller (docs 06: no secret/input echo).
        const reason = err instanceof Error && err.name === 'AbortError' ? 'probe timed out' : 'probe failed';
        throw new HttpError(502, 'CONNECTOR_UNAVAILABLE', `connector ${connectorId} ${reason}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
