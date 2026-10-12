import {
  ConnectorParityActivationResultSchema,
  ConnectorParityRetirementRequestSchema,
  ConnectorParityRetirementResultSchema,
  ConnectorDraftUpsertSchema,
  ConnectorParityDraftResultSchema,
  ConnectorParityRevisionSchema,
  ConnectorManagementRevisionSchema,
  ConnectorTestResultSchema,
  ConnectorProviderTestEvidenceSchema,
  ConnectorProviderTestEvidenceQuerySchema,
  ConnectorSignalSnapshotQuerySchema,
  ConnectorSignalSnapshotSchema,
  TenantActiveConnectorCatalogPageSchema,
  TenantActiveConnectorCatalogQuerySchema,
  ProviderTestInvocationRequestSchema,
  ProviderTestResultSchema,
  type ConnectorManagementRevision,
  type ConnectorParityDraftResult,
  type ConnectorParityRevision,
  type ConnectorParityRetirementRequest,
  type ConnectorParityRetirementResult,
  type ConnectorTestResult,
  type ConnectorProviderTestEvidence,
  type ConnectorProviderTestEvidenceQuery,
  type ConnectorSignalSnapshot,
  type ConnectorSignalSnapshotQuery,
  type TenantActiveConnectorCatalogPage,
  type TenantActiveConnectorCatalogQuery,
  type ProviderTestInvocationRequest,
  type ProviderTestResult,
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

/** Private Orchestrator→Connector provenance; never part of the public DTO. */
export interface ConnectorCredentialImportSource {
  catalogVersionRef: string;
  catalogKeyVersion: string;
}

export interface ConnectorResolvedCredentialDraftInput {
  tenantId: string;
  connectorId: string;
  expectedHeadRevision: number;
  recipe: unknown;
  credentialChange: { action: 'replace'; secret: string };
  credentialImportSource: ConnectorCredentialImportSource;
  idempotencyKey: string;
}

export interface ConnectorRecipeDraftClaimInput {
  tenantId: string;
  connectorId: string;
  expectedHeadRevision: number;
  idempotencyKey: string;
}

export interface ConnectorRecipeDraftClaimResult {
  claimed: boolean;
  expectedHeadRevision: number;
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
  /** Typed tenant-owned immutable recipe revision management. */
  getRecipeRevision(input: { tenantId: string; connectorId: string; revision: number }): Promise<ConnectorParityRevision | undefined>;
  upsertRecipeDraft(input: {
    tenantId: string;
    connectorId: string;
    expectedHeadRevision: number;
    recipe: unknown;
    credentialChange: unknown;
    idempotencyKey: string;
  }): Promise<ConnectorParityDraftResult>;
  /** Durable tenant ownership/head check before any imported credential is resolved or sent. */
  claimRecipeDraft(input: ConnectorRecipeDraftClaimInput): Promise<ConnectorRecipeDraftClaimResult>;
  /** Server-resolved Catalog secret import. The public vault-ref DTO is never forwarded. */
  upsertResolvedRecipeDraft(input: ConnectorResolvedCredentialDraftInput): Promise<ConnectorParityDraftResult>;
  activateRecipeRevision(input: {
    tenantId: string;
    connectorId: string;
    revision: number;
    expectedCurrentRevision: number;
  }): Promise<{ activated: boolean; currentRevision: number | null }>;
  /** Retire an exact typed revision only after the Orchestrator verifies that
   * no active Profile or in-flight operation still depends on its pin. */
  retireRecipeRevision(input: ConnectorParityRetirementRequest & { connectorId: string; revision: number }): Promise<ConnectorParityRetirementResult>;
  createRollbackRecipeDraft(input: {
    tenantId: string;
    connectorId: string;
    sourceRevision: number;
    expectedHeadRevision: number;
    idempotencyKey: string;
  }): Promise<ConnectorParityDraftResult>;
  /** Exact signed provider invocation; never a health/readiness probe. */
  invokeProviderTest(input: ProviderTestInvocationRequest): Promise<ProviderTestResult>;
  /** Source-of-truth recovery read; caller cannot provide outcome or amount. */
  getProviderTestEvidence(input: ConnectorProviderTestEvidenceQuery): Promise<ConnectorProviderTestEvidence | undefined>;
  /** Tenant-fenced source snapshot of real invocation and usage-outbox state. */
  getConnectorSignalSnapshot(input: ConnectorSignalSnapshotQuery): Promise<ConnectorSignalSnapshot | undefined>;
  /** Bounded safe metadata page of exact tenant-owned ACTIVE typed revisions. */
  listActiveRecipeRevisions(input: TenantActiveConnectorCatalogQuery): Promise<TenantActiveConnectorCatalogPage>;
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
    scope: Parameters<ConnectorManagementAuthorizationProvider>[0] = 'connector:manage',
    timeoutMs?: number,
  ): Promise<{ status: number; json: () => Promise<unknown> }> => {
    const base = (connectorId === undefined ? options.baseUrlFor(undefined) : options.baseUrlFor(connectorId)).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: options.authorizationForRequest(scope) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs ?? options.timeoutMs ?? 5_000),
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
    async getRecipeRevision(input) {
      const path = `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/${input.revision}?tenantId=${encodeURIComponent(input.tenantId)}`;
      const res = await call(input.connectorId, 'GET', path, undefined, 'connector:management');
      if (res.status === 404) return undefined;
      if (res.status !== 200) unexpected();
      const parsed = ConnectorParityRevisionSchema.safeParse(await res.json());
      if (!parsed.success || parsed.data.tenantId !== input.tenantId || parsed.data.connectorId !== input.connectorId || parsed.data.revision !== input.revision) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned a recipe revision outside the requested tenant pin');
      }
      return parsed.data;
    },
    async claimRecipeDraft(input) {
      const res = await call(input.connectorId, 'POST',
        `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/claim`, {
          tenantId: input.tenantId,
          expectedHeadRevision: input.expectedHeadRevision,
          idempotencyKey: input.idempotencyKey,
        }, 'connector:management');
      if (res.status === 409) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Connector draft claim key was reused with different input');
      }
      if (res.status !== 200) unexpected();
      const body = await res.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) unexpected();
      const value = body as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'claimed,expectedHeadRevision'
          || typeof value.claimed !== 'boolean'
          || value.expectedHeadRevision !== input.expectedHeadRevision) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid draft claim result');
      }
      return { claimed: value.claimed, expectedHeadRevision: input.expectedHeadRevision };
    },
    async upsertRecipeDraft(input) {
      const parsedInput = ConnectorDraftUpsertSchema.safeParse({
        tenantId: input.tenantId,
        expectedHeadRevision: input.expectedHeadRevision,
        recipe: input.recipe,
        credentialChange: input.credentialChange,
        idempotencyKey: input.idempotencyKey,
      });
      if (!parsedInput.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Connector recipe draft is invalid');
      const res = await call(input.connectorId, 'PUT', `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/draft`, parsedInput.data, 'connector:management');
      if (res.status !== 200 && res.status !== 201) unexpected();
      const result = ConnectorParityDraftResultSchema.safeParse(await res.json());
      if (!result.success || result.data.revision.tenantId !== input.tenantId || result.data.revision.connectorId !== input.connectorId) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid recipe draft result');
      }
      return result.data;
    },
    async upsertResolvedRecipeDraft(input) {
      const parsedInput = ConnectorDraftUpsertSchema.safeParse({
        tenantId: input.tenantId,
        expectedHeadRevision: input.expectedHeadRevision,
        recipe: input.recipe,
        credentialChange: input.credentialChange,
        idempotencyKey: input.idempotencyKey,
      });
      const source = input.credentialImportSource;
      if (!parsedInput.success || parsedInput.data.credentialChange.action !== 'replace'
          || !source || !/^([0-9a-f-]{36})@[1-9][0-9]{0,8}$/i.test(source.catalogVersionRef)
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source.catalogKeyVersion)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'resolved Connector credential import is invalid');
      }
      const body = { ...parsedInput.data, credentialImportSource: source };
      const res = await call(input.connectorId, 'PUT', `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/draft`, body, 'connector:management');
      if (res.status !== 200 && res.status !== 201) unexpected();
      const result = ConnectorParityDraftResultSchema.safeParse(await res.json());
      if (!result.success || result.data.revision.tenantId !== input.tenantId || result.data.revision.connectorId !== input.connectorId) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid imported credential draft result');
      }
      return result.data;
    },
    async activateRecipeRevision(input) {
      const res = await call(input.connectorId, 'POST', `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/${input.revision}/activate`, {
        tenantId: input.tenantId,
        expectedCurrentRevision: input.expectedCurrentRevision,
      }, 'connector:management');
      if (res.status === 409) return { activated: false, currentRevision: null };
      if (res.status !== 200) unexpected();
      const parsed = ConnectorParityActivationResultSchema.safeParse(await res.json());
      if (!parsed.success) throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid activation result');
      return parsed.data;
    },
    async retireRecipeRevision(input) {
      const parsedInput = ConnectorParityRetirementRequestSchema.safeParse({
        tenantId: input.tenantId,
        expectedCurrentRevision: input.expectedCurrentRevision,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
      });
      if (!parsedInput.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Connector retirement request is invalid');
      const res = await call(input.connectorId, 'POST',
        `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/${input.revision}/retire`,
        parsedInput.data, 'connector:management');
      if (res.status !== 200 && res.status !== 409) unexpected();
      const parsed = ConnectorParityRetirementResultSchema.safeParse(await res.json());
      if (!parsed.success) throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid retirement result');
      if (res.status === 409 && parsed.data.retired) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned a retired result with conflict status');
      }
      return parsed.data;
    },
    async createRollbackRecipeDraft(input) {
      const res = await call(input.connectorId, 'POST', `/internal/admin/connector-revisions/${encodeURIComponent(input.connectorId)}/rollback/draft`, {
        tenantId: input.tenantId,
        sourceRevision: input.sourceRevision,
        expectedHeadRevision: input.expectedHeadRevision,
        idempotencyKey: input.idempotencyKey,
      }, 'connector:management');
      if (res.status !== 200 && res.status !== 201) unexpected();
      const parsed = ConnectorParityDraftResultSchema.safeParse(await res.json());
      if (!parsed.success || parsed.data.revision.tenantId !== input.tenantId || parsed.data.revision.connectorId !== input.connectorId) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid rollback draft');
      }
      return parsed.data;
    },
    async invokeProviderTest(input) {
      const parsedInput = ProviderTestInvocationRequestSchema.safeParse(input);
      if (!parsedInput.success) throw new HttpError(422, 'INVALID_SCHEMA', 'provider test invocation is invalid');
      const connectorId = readProviderTestConnectorId(parsedInput.data.grant);
      if (!connectorId) throw new HttpError(422, 'INVALID_SCHEMA', 'provider test grant has no Connector audience identity');
      const remaining = Date.parse(parsedInput.data.deadlineAt) - Date.now();
      const res = await call(connectorId, 'POST', '/internal/admin/provider-tests', parsedInput.data, 'connector:provider-test', Math.max(1_000, Math.min(65_000, remaining + 3_000)));
      if (res.status !== 200) unexpected();
      const result = ProviderTestResultSchema.safeParse(await res.json());
      if (!result.success) throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned an invalid provider test result');
      return result.data;
    },
    async getProviderTestEvidence(input) {
      const query = ConnectorProviderTestEvidenceQuerySchema.safeParse(input);
      if (!query.success) throw new HttpError(422, 'INVALID_SCHEMA', 'provider test evidence query is invalid');
      const search = new URLSearchParams({
        tenantId: query.data.tenantId,
        operationId: query.data.operationId,
        taskId: query.data.taskId,
        connectorId: query.data.connectorId,
        revision: String(query.data.revision),
      });
      const res = await call(query.data.connectorId, 'GET', `/internal/admin/provider-test-invocations/${encodeURIComponent(query.data.invocationId)}?${search.toString()}`, undefined, 'connector:provider-test');
      if (res.status === 404) return undefined;
      if (res.status !== 200) unexpected();
      const evidence = ConnectorProviderTestEvidenceSchema.safeParse(await res.json());
      if (!evidence.success
          || evidence.data.tenantId !== query.data.tenantId
          || evidence.data.operationId !== query.data.operationId
          || evidence.data.taskId !== query.data.taskId
          || evidence.data.invocationId !== query.data.invocationId
          || evidence.data.connectorId !== query.data.connectorId
          || evidence.data.revision !== query.data.revision) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned evidence outside the requested invocation pins');
      }
      return evidence.data;
    },
    async getConnectorSignalSnapshot(input) {
      const query = ConnectorSignalSnapshotQuerySchema.safeParse(input);
      if (!query.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Connector signal query is invalid');
      const search = new URLSearchParams({
        tenantId: query.data.tenantId,
        from: query.data.from,
        to: query.data.to,
      });
      const res = await call(undefined as unknown as string, 'GET', `/internal/admin/signals/usage?${search.toString()}`, undefined, 'connector:signals:read');
      if (res.status === 404) return undefined;
      if (res.status !== 200) unexpected();
      const snapshot = ConnectorSignalSnapshotSchema.safeParse(await res.json());
      if (!snapshot.success
          || snapshot.data.tenantId !== query.data.tenantId
          || snapshot.data.from !== query.data.from
          || snapshot.data.to !== query.data.to
          || snapshot.data.sourceRef !== `connector-ledger:${query.data.tenantId}`) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned a signal snapshot outside the requested tenant and window');
      }
      return snapshot.data;
    },
    async listActiveRecipeRevisions(input) {
      const query = TenantActiveConnectorCatalogQuerySchema.safeParse(input);
      if (!query.success) throw new HttpError(422, 'INVALID_SCHEMA', 'tenant Connector catalog query is invalid');
      const search = new URLSearchParams({ tenantId: query.data.tenantId, limit: String(query.data.limit) });
      if (query.data.q !== undefined) search.set('q', query.data.q);
      if (query.data.cursor !== undefined) search.set('cursor', query.data.cursor);
      const res = await call(undefined as unknown as string, 'GET',
        `/internal/admin/connector-revisions/active?${search.toString()}`, undefined, 'connector:management');
      if (res.status !== 200) unexpected();
      const page = TenantActiveConnectorCatalogPageSchema.safeParse(await res.json());
      if (!page.success || page.data.tenantId !== query.data.tenantId
          || page.data.limit !== query.data.limit
          || page.data.items.some((item) => item.tenantId !== query.data.tenantId)) {
        throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector returned a catalog page outside the requested tenant scope');
      }
      return page.data;
    },
  };
}

function readProviderTestConnectorId(grant: string): string | null {
  try {
    const payload = grant.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return claims['audience'] === 'connector' && claims['purpose'] === 'admin-provider-test' && typeof claims['connectorId'] === 'string'
      ? claims['connectorId']
      : null;
  } catch {
    return null;
  }
}
