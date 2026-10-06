/**
 * Same-origin Admin BFF client (AWEB-02).
 *
 * - Talks ONLY to `/admin/api/*` with the session cookie; no token ever
 *   enters the bundle or a header it should not (the platform bearer lives
 *   server-side in the BFF).
 * - Carries the server-issued `X-CSRF-Token` on mutations and forwards an
 *   `Idempotency-Key` when the caller provides one.
 * - Maps every failure to the typed problem envelope; nothing throws for an
 *   HTTP-level failure (transport failures fold into an `ok:false` result
 *   with status 0).
 */
import type {
  AdminApiProblem,
  AdminApiResult,
  AdminWebSession,
  ApiKeyPage,
  BusinessPage,
  BusinessVersions,
  ConnectorActivateParams,
  ConnectorRevision,
  ConnectorRevisionTarget,
  ConnectorUpsertParams,
  OperationDetail,
  OperationsPage,
  PolicyUpsertBody,
  ProfileDetail,
  ProfileMutationResult,
  ProfilePublishBody,
  ProfileRollbackBody,
  SecretCatalogCreateBody,
  SecretCatalogDisableBody,
  SecretCatalogEntryRead,
  SecretCatalogListPage,
  SecretCatalogRotateBody,
  SecretProbeResult,
  UsageSummary,
} from './types';

export interface AdminApiClientOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Same-origin BFF base path. */
  basePath?: string;
}

export interface ActionOptions {
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface PostActionResult {
  action: string;
  [key: string]: unknown;
}

export interface AdminApiClient {
  getSession(): Promise<AdminApiResult<AdminWebSession>>;
  listAudit(query?: Record<string, string>): Promise<AdminApiResult<unknown>>;
  listApiKeys(query?: Record<string, string>): Promise<AdminApiResult<ApiKeyPage>>;
  getApiKey(keyId: string): Promise<AdminApiResult<ApiKeyPage>>;
  getConnectorRevision(
    connectorId: string,
    revision: string,
  ): Promise<AdminApiResult<ConnectorRevision>>;
  /**
   * CONNECTOR-WIRE-B reads. Both answer `unknown`: the list has two honest
   * shapes (real ledger / placeholder) and the reader in
   * `features/connectors/state.ts` is the only validator — typing them here
   * would assert a shape the browser has not checked.
   */
  listConnectors(): Promise<AdminApiResult<unknown>>;
  getConnectorCapabilities(): Promise<AdminApiResult<unknown>>;
  upsertConnector(
    params: ConnectorUpsertParams,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  activateConnector(
    params: ConnectorActivateParams,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  disableConnector(
    connectorId: string,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  retireConnector(
    target: ConnectorRevisionTarget,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<PostActionResult>>;
  testConnector(connectorId: string, idempotencyKey?: string): Promise<AdminApiResult<PostActionResult>>;
  getProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
  ): Promise<AdminApiResult<ProfileDetail>>;
  upsertProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
    body: PolicyUpsertBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileMutationResult>>;
  publishProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
    body: ProfilePublishBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileMutationResult>>;
  rollbackProfile(
    businessId: string,
    businessVersion: string,
    profileName: string,
    body: ProfileRollbackBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<ProfileMutationResult>>;
  testProfileEndpoint(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  listOperations(query?: Record<string, string>): Promise<AdminApiResult<OperationsPage>>;
  operationAction(operationId: string, action: 'cancel' | 'retry', idempotencyKey: string): Promise<AdminApiResult<Record<string, unknown>>>;
  getOperation(operationId: string): Promise<AdminApiResult<OperationDetail>>;
  getUsage(query: Record<string, string>): Promise<AdminApiResult<UsageSummary>>;
  listBusinesses(query?: Record<string, string>): Promise<AdminApiResult<BusinessPage>>;
  getBusinessVersions(businessId: string): Promise<AdminApiResult<BusinessVersions>>;
  businessVersionAction(
    businessId: string,
    version: string,
    action: 'enable' | 'activate' | 'deactivate',
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  getCryptoConfig(tenantId?: string): Promise<AdminApiResult<Record<string, unknown>>>;
  updateCryptoConfig(
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<Record<string, unknown>>>;
  /** SC-03: catalog list; metadata only, never a value. */
  listSecrets(query?: Record<string, string>): Promise<AdminApiResult<SecretCatalogListPage>>;
  createSecret(
    body: SecretCatalogCreateBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<SecretCatalogEntryRead>>;
  rotateSecret(
    secretId: string,
    body: SecretCatalogRotateBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<SecretCatalogEntryRead>>;
  disableSecret(
    secretId: string,
    body: SecretCatalogDisableBody,
    idempotencyKey?: string,
  ): Promise<AdminApiResult<SecretCatalogEntryRead>>;
  /** Safe probe: availability/error code only, never a value. */
  testSecret(secretId: string): Promise<AdminApiResult<SecretProbeResult>>;
  postAction(
    action: string,
    params: Record<string, unknown>,
    options?: ActionOptions,
  ): Promise<AdminApiResult<PostActionResult>>;
}

const TRANSPORT_PROBLEM: AdminApiProblem = {
  status: 0,
  code: 'TRANSPORT_ERROR',
  title: 'The admin API could not be reached.',
};

export function createAdminApiClient(options: AdminApiClientOptions = {}): AdminApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basePath = options.basePath ?? '/admin/api';
  let csrfToken: string | null = null;

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    init: { query?: Record<string, string>; body?: unknown; csrf?: boolean; idempotencyKey?: string },
  ): Promise<AdminApiResult<T>> {
    const url = basePath + path + buildQuery(init.query);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.csrf === true && csrfToken !== null) headers['x-csrf-token'] = csrfToken;
    if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return { ok: false, status: 0, problem: TRANSPORT_PROBLEM };
    }

    if (!response.ok) {
      const problem = await parseProblem(response);
      return { ok: false, status: response.status, problem };
    }
    const data = (await response.json().catch(() => null)) as T | null;
    if (data === null) {
      return {
        ok: false,
        status: response.status,
        problem: {
          status: 502,
          code: 'UNREADABLE_RESPONSE',
          title: 'The admin API returned an unreadable response.',
        },
      };
    }
    return { ok: true, status: response.status, data };
  }

  /**
   * POST /admin/api/actions — the one mutation wire. The BFF wraps a
   * successful upstream body in `{ data: … }`; unwrap it here so callers see
   * the action result directly (rawKey on issue, revision on connector.upsert).
   */
  async function runAction(
    action: string,
    params: Record<string, unknown>,
    actionOptions?: ActionOptions,
  ): Promise<AdminApiResult<PostActionResult>> {
    const body: Record<string, unknown> = { action, params };
    if (actionOptions?.expectedRevision !== undefined) {
      body.expectedRevision = actionOptions.expectedRevision;
    }
    const result = await request<{ data?: PostActionResult }>('POST', '/actions', {
      body,
      csrf: true,
      idempotencyKey: actionOptions?.idempotencyKey,
    });
    if (!result.ok) return result;
    const inner = result.data.data;
    return {
      ok: true,
      status: result.status,
      data:
        typeof inner === 'object' && inner !== null ? inner : (result.data as unknown as PostActionResult),
    };
  }

  return {
    async getSession() {
      const result = await request<AdminWebSession>('GET', '/session', {});
      if (result.ok) csrfToken = result.data.csrfToken;
      return result;
    },
    listAudit(query) {
      return request<unknown>('GET', '/audit', { query });
    },
    listApiKeys(query) {
      return request<ApiKeyPage>('GET', '/api-keys', { query });
    },
    getApiKey(keyId) {
      return request<ApiKeyPage>('GET', `/api-keys/${encodeURIComponent(keyId)}`, {});
    },
    getConnectorRevision(connectorId, revision) {
      return request<ConnectorRevision>(
        'GET',
        `/connectors/${encodeURIComponent(connectorId)}/revisions/${encodeURIComponent(revision)}`,
        {},
      );
    },
    listConnectors() {
      return request<unknown>('GET', '/connectors', {});
    },
    getConnectorCapabilities() {
      // Static segment: the BFF matches it before `/connectors/:id/...`.
      return request<unknown>('GET', '/connectors/capabilities', {});
    },
    upsertConnector(params, idempotencyKey) {
      return runAction('connector.upsert', params as unknown as Record<string, unknown>, {
        idempotencyKey,
      });
    },
    activateConnector(params, idempotencyKey) {
      return runAction('connector.activate', params as unknown as Record<string, unknown>, {
        idempotencyKey,
      });
    },
    disableConnector(connectorId, idempotencyKey) {
      return runAction('connector.disable', { connectorId }, { idempotencyKey });
    },
    retireConnector(target, idempotencyKey) {
      const params = { connectorId: target.connectorId, revision: target.revision };
      return runAction('connector.retire', params, { idempotencyKey });
    },
    testConnector(connectorId, idempotencyKey) {
      return runAction('connector.test', { connectorId }, { idempotencyKey });
    },
    getProfile(businessId, businessVersion, profileName) {
      return request<ProfileDetail>(
        'GET',
        `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}`,
        {},
      );
    },
    async upsertProfile(businessId, businessVersion, profileName, body, idempotencyKey) {
      return unwrapMutation(
        await request<{ data?: ProfileMutationResult }>(
          'POST',
          `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/upsert`,
          { body, csrf: true, idempotencyKey },
        ),
      );
    },
    async publishProfile(businessId, businessVersion, profileName, body, idempotencyKey) {
      return unwrapMutation(
        await request<{ data?: ProfileMutationResult }>(
          'POST',
          `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/publish`,
          { body, csrf: true, idempotencyKey },
        ),
      );
    },
    async rollbackProfile(businessId, businessVersion, profileName, body, idempotencyKey) {
      return unwrapMutation(
        await request<{ data?: ProfileMutationResult }>(
          'POST',
          `/profiles/${encodeURIComponent(businessId)}/${encodeURIComponent(businessVersion)}/${encodeURIComponent(profileName)}/rollback`,
          { body, csrf: true, idempotencyKey },
        ),
      );
    },
    async testProfileEndpoint(payload, idempotencyKey) {
      return request<Record<string, unknown>>('POST', '/profiles/test-endpoint', {
        body: payload,
        csrf: true,
        idempotencyKey,
      });
    },
    listOperations(query) {
      return request<OperationsPage>('GET', '/operations', { query });
    },
    operationAction(operationId, action, idempotencyKey) {
      return request<Record<string, unknown>>('POST', `/operations/${encodeURIComponent(operationId)}/${action}`, { body: {}, csrf: true, idempotencyKey });
    },
    getOperation(operationId) {
      return request<OperationDetail>('GET', `/operations/${encodeURIComponent(operationId)}`, {});
    },
    getUsage(query) {
      return request<UsageSummary>('GET', '/usage', { query });
    },
    listBusinesses(query) {
      return request<BusinessPage>('GET', '/businesses', { query });
    },
    getBusinessVersions(businessId) {
      return request<BusinessVersions>('GET', `/businesses/${encodeURIComponent(businessId)}/versions`, {});
    },
    businessVersionAction(businessId, version, action) {
      return request<Record<string, unknown>>(
        'PUT',
        `/businesses/${encodeURIComponent(businessId)}/versions/${encodeURIComponent(version)}/${action}`,
        { csrf: true },
      );
    },
    getCryptoConfig(tenantId) {
      return request<Record<string, unknown>>('GET', '/crypto-config', {
        ...(tenantId !== undefined && tenantId.length > 0 ? { query: { tenantId } } : {}),
      });
    },
    async updateCryptoConfig(body, idempotencyKey) {
      return request<Record<string, unknown>>('POST', '/crypto-config', {
        body,
        csrf: true,
        idempotencyKey,
      });
    },
    listSecrets(query) {
      return request<SecretCatalogListPage>('GET', '/secrets', { query });
    },
    createSecret(body, idempotencyKey) {
      return request<SecretCatalogEntryRead>('POST', '/secrets', {
        body,
        csrf: true,
        idempotencyKey,
      });
    },
    rotateSecret(secretId, body, idempotencyKey) {
      return request<SecretCatalogEntryRead>(
        'POST',
        `/secrets/${encodeURIComponent(secretId)}/rotate`,
        { body, csrf: true, idempotencyKey },
      );
    },
    disableSecret(secretId, body, idempotencyKey) {
      return request<SecretCatalogEntryRead>(
        'POST',
        `/secrets/${encodeURIComponent(secretId)}/disable`,
        { body, csrf: true, idempotencyKey },
      );
    },
    testSecret(secretId) {
      return request<SecretProbeResult>(
        'POST',
        `/secrets/${encodeURIComponent(secretId)}/test`,
        { body: {}, csrf: true },
      );
    },
    postAction(action, params, actionOptions) {
      return runAction(action, params, actionOptions);
    },
  };
}

/** Unwrap the BFF `{ data: … }` envelope for profile mutations. */
function unwrapMutation(
  result: AdminApiResult<{ data?: ProfileMutationResult }>,
): AdminApiResult<ProfileMutationResult> {
  if (!result.ok) return result;
  const inner = result.data.data;
  return {
    ok: true,
    status: result.status,
    data: typeof inner === 'object' && inner !== null ? inner : (result.data as unknown as ProfileMutationResult),
  };
}

function buildQuery(query: Record<string, string> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value.length > 0) params.set(name, value);
  }
  const encoded = params.toString();
  return encoded.length > 0 ? '?' + encoded : '';
}

async function parseProblem(response: Response): Promise<AdminApiProblem> {
  const fallback: AdminApiProblem = {
    status: response.status,
    code: 'HTTP_' + response.status,
    title: 'The admin API rejected the request.',
  };
  const parsed = (await response.json().catch(() => null)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
  const candidate = parsed as Partial<AdminApiProblem>;
  const status = typeof candidate.status === 'number' ? candidate.status : response.status;
  return {
    ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
    ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.correlationId === 'string' ? { correlationId: candidate.correlationId } : {}),
    ...(Array.isArray(candidate.errors) ? { errors: candidate.errors } : {}),
    status,
  };
}
