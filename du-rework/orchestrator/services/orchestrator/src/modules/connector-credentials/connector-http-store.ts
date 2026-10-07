import {
  ConnectorCredentialSourceSchema,
  matchesVaultAccountPath,
  type ConnectorCredentialSource,
} from '@du/contracts';
import { HttpError } from '../../http/errors';
import type { ConnectorRevisionStore, PinnedSource, RevisionRow } from './workflow';
import type { ConnectorManagementAuthorizationProvider } from '../connectors/management-service-identity';

/**
 * VAULT-06: HTTP adapter binding the Orchestrator credential workflow's
 * ConnectorRevisionStore port to the Connector management API (drafted with
 * this cycle): GET /connectors/:id/revisions/current, POST .../revisions
 * (PENDING cloned from CURRENT), POST .../revisions/:rev/activate (CAS —
 * 409 when the chain moved on), POST .../revisions/:rev/retire.
 *
 * Fail-closed by construction: transport problems are 503 TEMPORARY_UNAVAILABLE
 * (the caller must NOT assume the write/revoke did not happen — reconcile is
 * the repair path), unexpected statuses are 502 with the connector's body
 * DELIBERATELY NOT forwarded (it could echo config data). 200/409 on activate
 * map to true/false; 404 on current maps to undefined exactly like the port.
 */

export interface ConnectorRevisionHttpAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Produces a fresh signed service identity for every outbound request. */
  authorizationForRequest: ConnectorManagementAuthorizationProvider;
}

interface RevisionWire {
  connectorId?: string;
  tenantId?: string;
  accountId?: string;
  revision: number;
  adapter: string;
  state: string;
  credentialSource: unknown;
}

const STATES = ['PENDING', 'ACTIVE', 'RETIRED'] as const;

function toRow(wire: RevisionWire): RevisionRow {
  const state = (STATES as readonly string[]).includes(wire.state)
    ? (wire.state as (typeof STATES)[number])
    : (() => {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'connector returned an unknown revision state');
      })();
  const credentialSource = ConnectorCredentialSourceSchema.safeParse(wire.credentialSource);
  if (!credentialSource.success) {
    throw new HttpError(502, 'CONNECTOR_API_ERROR', 'connector returned an invalid credential source');
  }
  return {
    revision: wire.revision,
    adapter: wire.adapter,
    state,
    credentialSource: credentialSource.data as ConnectorCredentialSource,
    ...(wire.tenantId === undefined ? {} : { tenantId: wire.tenantId }),
    ...(wire.accountId === undefined ? {} : { accountId: wire.accountId }),
  };
}

export function createConnectorRevisionHttpAdapter(
  options: ConnectorRevisionHttpAdapterOptions,
): ConnectorRevisionStore {
  if (!/^https?:\/\//.test(options.baseUrl)) {
    throw new Error('connector revision adapter requires an absolute http(s) baseUrl');
  }
  const base = options.baseUrl.replace(/\/+$/, '');
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: () => Promise<unknown> }> => {
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

  return {
    async get(connectorId, scope) {
      // W-VAULT-LEGACY-TRANSITION-1: an explicit tenant selector reads that
      // chain; absent selector keeps the historical unbound-chain GET exact
      // (wire-compatible for every existing caller).
      const query = scope?.tenantId ? `?tenant=${encodeURIComponent(scope.tenantId)}` : '';
      const res = await call('GET', `/connectors/${encodeURIComponent(connectorId)}/revisions/current${query}`);
      if (res.status === 404) return undefined;
      if (res.status !== 200) throw new HttpError(502, 'CONNECTOR_API_ERROR', 'unexpected status from connector');
      return toRow((await res.json()) as RevisionWire);
    },
    async createPending(connectorId, source) {
      const parsedSource = ConnectorCredentialSourceSchema.safeParse(source);
      if (!parsedSource.success || parsedSource.data.kind !== 'vault-kv2') {
        throw new HttpError(422, 'INVALID_SCHEMA', 'pending revisions require a vault-kv2 credential source');
      }
      if (!matchesVaultAccountPath(parsedSource.data, { connectorId })) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'credential source is outside the connector account path');
      }
      // Migration 008 stores these coordinates as trusted revision columns.
      // Send them as independent fields so Connector never has to treat the
      // credential source path as its binding authority.
      const pathSegments = parsedSource.data.path.split('/');
      const tenantId = pathSegments[2];
      const accountId = parsedSource.data.account;
      if (!tenantId || !accountId) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'credential source has no independent revision binding');
      }
      const res = await call(
        'POST',
        `/connectors/${encodeURIComponent(connectorId)}/revisions`,
        { credentialSource: parsedSource.data, tenantId, accountId },
      );
      if (res.status !== 201) throw new HttpError(502, 'CONNECTOR_API_ERROR', 'connector rejected the PENDING revision');
      return toRow((await res.json()) as RevisionWire);
    },
    async bootstrap(connectorId, source) {
      // W-VAULT-LEGACY-TRANSITION-1: first-bound chain creation. The
      // connector refuses this endpoint unless an unbound legacy revision
      // exists to transition, so it can never mint a fresh chain out of
      // thin air through the rotation workflow.
      const parsedSource = ConnectorCredentialSourceSchema.safeParse(source);
      if (!parsedSource.success || parsedSource.data.kind !== 'vault-kv2') {
        throw new HttpError(422, 'INVALID_SCHEMA', 'bootstrap requires a vault-kv2 credential source');
      }
      if (!matchesVaultAccountPath(parsedSource.data, { connectorId })) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'credential source is outside the connector account path');
      }
      const pathSegments = parsedSource.data.path.split('/');
      const tenantId = pathSegments[2];
      const accountId = parsedSource.data.account;
      if (!tenantId || !accountId) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'credential source has no independent revision binding');
      }
      const res = await call(
        'POST',
        `/connectors/${encodeURIComponent(connectorId)}/revisions/bootstrap`,
        { credentialSource: parsedSource.data, tenantId, accountId },
      );
      if (res.status !== 201) throw new HttpError(502, 'CONNECTOR_API_ERROR', 'connector rejected the bootstrap revision');
      return toRow((await res.json()) as RevisionWire);
    },
    async activate(connectorId, revision, expectedCurrentRevision) {
      const res = await call(
        'POST',
        `/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}/activate`,
        { expectedCurrentRevision },
      );
      if (res.status === 200) {
        const body = (await res.json()) as { activated?: unknown };
        return body?.activated === true;
      }
      if (res.status === 409) return false;
      throw new HttpError(502, 'CONNECTOR_API_ERROR', 'unexpected status from connector activation');
    },
    async retire(connectorId, revision) {
      const res = await call(
        'POST',
        `/connectors/${encodeURIComponent(connectorId)}/revisions/${revision}/retire`,
      );
      if (res.status === 204 || res.status === 404) return;
      throw new HttpError(502, 'CONNECTOR_API_ERROR', 'unexpected status from connector retire');
    },
    async revokeAll(connectorId) {
      // VAULT-04 emergency revoke = connector disable (every row RETIRED).
      const res = await call('POST', `/connectors/${encodeURIComponent(connectorId)}/disable`);
      if (res.status === 204 || res.status === 404) return;
      throw new HttpError(502, 'CONNECTOR_API_ERROR', 'unexpected status from connector disable');
    },
  };
}
