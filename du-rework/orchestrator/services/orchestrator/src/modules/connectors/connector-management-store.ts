import {
  ConnectorManagementRevisionSchema,
  ConnectorTestResultSchema,
  type ConnectorManagementRevision,
  type ConnectorTestResult,
} from '@du/contracts';
import { HttpError } from '../../http/errors';
import type { ConnectorManagementAuthorizationProvider } from './management-service-identity';

/**
 * CONNECTOR-WIRE-A: the Orchestrator's connector MANAGEMENT proxy.
 *
 * The Connector service owns the revision ledger (list / create / clone /
 * activate-CAS / retire / disable / test). The platform fronts it so admin
 * callers never hold Connector service identity, and so every response is
 * re-validated against the platform DTO before it leaves the platform — a
 * connector that grew a new field cannot leak it through this proxy
 * (`.strict()` drops it).
 *
 * Fail-closed by construction, same discipline as `connector-http-store.ts`:
 * transport problems are 503 TEMPORARY_UNAVAILABLE (mutation may have
 * happened — reconcile, never assume); unexpected statuses are 502 with the
 * connector's body DELIBERATELY NOT forwarded; a 200 that does not satisfy
 * the DTO is 502 (never best-effort passthrough). Redaction is upstream
 * (connector header values are `[REDACTED]`); this layer must not widen it.
 */

export interface ConnectorManagementStoreOptions {
  /**
   * Platform configuration only — never caller input (no open proxy).
   * `undefined` requests the SERVICE-level base (the list route is not
   * connector-scoped); the composition supplies its first configured URL.
   */
  baseUrlFor: (connectorId?: string) => string;
  /** Produces a fresh signed service identity for every outbound request. */
  authorizationForRequest: ConnectorManagementAuthorizationProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ConnectorCreateInput {
  connectorId: string;
  adapter: string;
  config: Record<string, unknown>;
  credentialRef: string;
  state?: 'ACTIVE' | 'PENDING';
}

export interface ConnectorRevisionInput {
  credentialSource: Record<string, unknown>;
  tenantId: string;
  accountId: string;
}

export interface ConnectorManagementStore {
  list(): Promise<ConnectorManagementRevision[]>;
  getRevision(connectorId: string, revision: number): Promise<ConnectorManagementRevision | undefined>;
  getCurrent(connectorId: string): Promise<ConnectorManagementRevision | undefined>;
  create(input: ConnectorCreateInput): Promise<ConnectorManagementRevision>;
  createPending(connectorId: string, input: ConnectorRevisionInput): Promise<ConnectorManagementRevision>;
  /**
   * D2: first-bound-chain creation for a legacy unbound connector. The
   * connector refuses unless a legacy revision exists to transition; the
   * response may carry `replayed` (idempotent bootstrap), which is stripped
   * before the platform DTO is parsed.
   */
  bootstrap(
    connectorId: string,
    input: ConnectorRevisionInput,
  ): Promise<{ revision: ConnectorManagementRevision; replayed?: boolean }>;
  /** CAS: true when this call activated; false when the chain moved on (409). */
  activate(connectorId: string, revision: number, expectedCurrentRevision: number): Promise<boolean>;
  retire(connectorId: string, revision: number): Promise<void>;
  disable(connectorId: string): Promise<void>;
  test(connectorId: string): Promise<ConnectorTestResult>;
}

function parseRevision(wire: unknown): ConnectorManagementRevision {
  const parsed = ConnectorManagementRevisionSchema.safeParse(wire);
  if (!parsed.success) {
    throw new HttpError(502, 'CONNECTOR_API_ERROR', 'connector returned a revision outside the platform contract');
  }
  return parsed.data;
}

export function createConnectorManagementStore(
  options: ConnectorManagementStoreOptions,
): ConnectorManagementStore {
  const call = async (
    connectorId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: () => Promise<unknown> }> => {
    const base = (connectorId === undefined ? options.baseUrlFor(undefined) : options.baseUrlFor(connectorId)).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: options.authorizationForRequest() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      return { status: res.status, json: () => res.json().catch(() => undefined) };
    } catch (err) {
      void err;
      throw new HttpError(
        503,
        'TEMPORARY_UNAVAILABLE',
        'connector management API unreachable; reconcile before assuming the operation did not happen',
      );
    }
  };

  function unexpected(): never {
    throw new HttpError(502, 'CONNECTOR_API_ERROR', 'unexpected status from connector');
  }

  return {
    async list() {
      // Service-level route: the base URL resolves through the composition's
      // service selector (first configured connector), never caller input.
      const res = await call(undefined as unknown as string, 'GET', '/connectors');
      if (res.status !== 200) unexpected();
      const body = await res.json();
      if (!Array.isArray(body)) unexpected();
      return (body as unknown[]).map((revision) => parseRevision(revision));
    },
    async getRevision(connectorId, revision) {
      const res = await call(connectorId, 'GET', `/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}`);
      if (res.status === 404) return undefined;
      if (res.status !== 200) unexpected();
      return parseRevision(await res.json());
    },
    async getCurrent(connectorId) {
      const res = await call(connectorId, 'GET', `/connectors/${encodeURIComponent(connectorId)}/revisions/current`);
      if (res.status === 404) return undefined;
      if (res.status !== 200) unexpected();
      return parseRevision(await res.json());
    },
    async create(input) {
      const res = await call(input.connectorId, 'POST', '/connectors', {
        connectorId: input.connectorId,
        adapter: input.adapter,
        config: input.config,
        credentialRef: input.credentialRef,
        ...(input.state === undefined ? {} : { state: input.state }),
      });
      if (res.status !== 201) unexpected();
      return parseRevision(await res.json());
    },
    async createPending(connectorId, input) {
      const res = await call(connectorId, 'POST', `/connectors/${encodeURIComponent(connectorId)}/revisions`, {
        credentialSource: input.credentialSource,
        tenantId: input.tenantId,
        accountId: input.accountId,
      });
      if (res.status !== 201) unexpected();
      return parseRevision(await res.json());
    },
    async bootstrap(connectorId, input) {
      const res = await call(connectorId, 'POST', `/connectors/${encodeURIComponent(connectorId)}/revisions/bootstrap`, {
        credentialSource: input.credentialSource,
        tenantId: input.tenantId,
        accountId: input.accountId,
      });
      if (res.status !== 201) unexpected();
      const body = await res.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) unexpected();
      const { replayed, ...view } = body as Record<string, unknown>;
      return {
        revision: parseRevision(view),
        ...(typeof replayed === 'boolean' ? { replayed } : {}),
      };
    },
    async activate(connectorId, revision, expectedCurrentRevision) {
      const res = await call(
        connectorId,
        'POST',
        `/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}/activate`,
        { expectedCurrentRevision },
      );
      if (res.status === 200) {
        const body = (await res.json()) as { activated?: unknown } | undefined;
        return body?.activated === true;
      }
      if (res.status === 409) return false;
      unexpected();
    },
    async retire(connectorId, revision) {
      const res = await call(connectorId, 'POST', `/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}/retire`);
      if (res.status === 204 || res.status === 404) return;
      unexpected();
    },
    async disable(connectorId) {
      const res = await call(connectorId, 'POST', `/connectors/${encodeURIComponent(connectorId)}/disable`);
      if (res.status === 204 || res.status === 404) return;
      unexpected();
    },
    async test(connectorId) {
      const res = await call(connectorId, 'POST', `/connectors/${encodeURIComponent(connectorId)}/test`);
      if (res.status !== 200) unexpected();
      const parsed = ConnectorTestResultSchema.safeParse(await res.json());
      if (!parsed.success) unexpected();
      // Narrowed to the masked pair — a probe detail must never smuggle
      // provider payloads or credential material through this proxy.
      return {
        ok: parsed.data.ok,
        ...(parsed.data.errorCode === undefined ? {} : { errorCode: parsed.data.errorCode }),
      };
    },
  };
}
