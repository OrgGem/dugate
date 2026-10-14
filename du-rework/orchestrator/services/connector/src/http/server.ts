import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { redactConnectorRevision } from '../config';
import type { ConnectorRevision, NewConnectorRevision, RevisionScope } from '../db/repository';
import { ConnectorError } from '../errors';
import { requireServiceIdentity } from '../identity';
import type { ServiceIdentityVerifier } from '../types';
import { parseContractInvocationRequest, toContractInvocationResponse } from '../contracts';
import type { DrainableConnectorServer } from '../lifecycle';
import {
  CONNECTOR_INVOCATION_MAX_BODY_BYTES,
  ConnectorDraftUpsertSchema,
  ConnectorParityDraftResultSchema,
  ConnectorParityActivationResultSchema,
  ConnectorParityRetirementRequestSchema,
  ConnectorParityRetirementResultSchema,
  ConnectorParityRevisionSchema,
  ConnectorProviderTestEvidenceSchema,
  ConnectorProviderTestEvidenceQuerySchema,
  type ConnectorProviderTestEvidence,
  type ConnectorProviderTestEvidenceQuery,
  ProviderTestResultSchema,
  ConnectorSignalSnapshotQuerySchema,
  ConnectorSignalSnapshotSchema,
  ConnectorReplicaControlCommandSchema,
  ConnectorReplicaRuntimeObservationSchema,
  ConnectorReplicaRuntimeReadRequestSchema,
  ConnectorBackupEffectFenceCommandSchema,
  ConnectorBackupEffectFenceObservationRequestSchema,
  ConnectorBackupEffectFenceObservationSchema,
  TenantActiveConnectorCatalogQuerySchema,
  TenantActiveConnectorCatalogPageSchema,
  TenantConnectorRecipeCatalogQuerySchema,
  TenantConnectorRecipeCatalogPageSchema,
  isTenantUuid,
  type ConnectorRevisionBinding,
  type ConnectorReplicaControlAck,
  type ConnectorReplicaControlCommand,
  type ConnectorReplicaIdentity,
  type ConnectorReplicaRuntimeObservation,
  type ConnectorBackupEffectFenceCommand,
  type ConnectorBackupEffectFenceObservation,
  type ConnectorBackupEffectFenceObservationRequest,
  type ConnectorSignalSnapshot,
  type ConnectorSignalSnapshotQuery,
} from '@du/contracts';
import type { ConnectorInternalRollbackDraft, ConnectorInternalDraftUpsert, ConnectorParityManagementPort } from '../modules/parity-management';

export interface HttpInvocationResult {
  invocationId: string;
  state: 'completed' | 'pending' | 'unknown' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  providerRequestId?: string;
  error?: { code: string; message: string; retryAfterMs?: number };
  nextPollAt?: string;
  /**
   * CR06-04: invocation continuation session. PENDING responses carry the
   * provider-issued session persisted on the pending record; SUCCEEDED
   * responses carry the result-side session (the pending one when the final
   * provider response omitted it). Additive/optional.
   */
  sessionRef?: string | null;
}

export interface ConnectorHttpStore {
  list(): Promise<ConnectorRevision[]>;
  get(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined>;
  getRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<ConnectorRevision | undefined>;
  /** VAULT-06: highest-numbered ACTIVE — the CURRENT routable revision of the scope's chain. */
  getCurrentRevision(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined>;
  createRevision(input: NewConnectorRevision): Promise<ConnectorRevision>;
  /** VAULT-06: clone CURRENT (adapter/config/credentialRef) into a new PENDING revision. */
  createPendingRevision(
    connectorId: string,
    credentialSource: unknown,
    binding: ConnectorRevisionBinding,
  ): Promise<ConnectorRevision>;
  /** W-VAULT-LEGACY-TRANSITION-1: open the bound chain from a legacy unbound CURRENT. */
  bootstrapRevision(
    connectorId: string,
    credentialSource: unknown,
    binding: ConnectorRevisionBinding,
  ): Promise<{ revision: ConnectorRevision; replayed: boolean }>;
  /** VAULT-06: CAS activate; false when the chain moved on. Never two ACTIVE. */
  activateRevision(connectorId: string, revision: number, expectedCurrentRevision: number, scope?: RevisionScope): Promise<boolean>;
  retireRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<void>;
  rotateCredential(connectorId: string, secret: string, scope?: RevisionScope): Promise<void>;
  disable(connectorId: string, scope?: RevisionScope): Promise<void>;
  test(connectorId: string, scope?: RevisionScope): Promise<{ ok: boolean; errorCode?: string }>;
}

export interface ConnectorRuntime {
  invoke(body: unknown): Promise<HttpInvocationResult>;
  get(invocationId: string, invocationGrant?: string): Promise<HttpInvocationResult | undefined>;
  cancel(invocationId: string, reason: string, invocationGrant?: string): Promise<HttpInvocationResult>;
  testExactRevision?(body: unknown): Promise<unknown>;
  getProviderTestEvidence?(query: ConnectorProviderTestEvidenceQuery): Promise<ConnectorProviderTestEvidence | undefined>;
  getSignalSnapshot?(query: ConnectorSignalSnapshotQuery): Promise<ConnectorSignalSnapshot>;
}

export interface ConnectorReplicaRuntimeControlPort {
  observe(
    expected: ConnectorReplicaIdentity,
    isReady: () => Promise<boolean>,
    dependencyHealth?: () => Promise<{
      observedAt: string;
      postgres: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
      redis: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
    }>,
    externalEffects?: ConnectorReplicaRuntimeObservation['externalEffects'],
  ): Promise<ConnectorReplicaRuntimeObservation>;
  requestDrain(command: ConnectorReplicaControlCommand): Promise<ConnectorReplicaControlAck>;
  requestResume(command: ConnectorReplicaControlCommand): Promise<ConnectorReplicaControlAck>;
}

export interface ConnectorBackupEffectFencePort {
  hold(command: ConnectorBackupEffectFenceCommand): Promise<ConnectorBackupEffectFenceObservation>;
  release(command: ConnectorBackupEffectFenceCommand): Promise<{ released: true; fenceRevision: number }>;
  observe(request: ConnectorBackupEffectFenceObservationRequest): Promise<ConnectorBackupEffectFenceObservation>;
}

export interface ConnectorHttpDependencies {
  management: ConnectorHttpStore;
  parityManagement?: ConnectorParityManagementPort;
  runtime: ConnectorRuntime;
  replicaRuntimeControl?: ConnectorReplicaRuntimeControlPort;
  /** Independent dependency probes used only by trusted runtime-control observation. */
  runtimeHealth?: () => Promise<{
    observedAt: string;
    postgres: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
    redis: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
  }>;
  /** Live isolated-mode control state; absent for ordinary Connector processes. */
  restoreExternalEffects?: () => NonNullable<ConnectorReplicaRuntimeObservation['externalEffects']>;
  backupEffectFence?: ConnectorBackupEffectFencePort;
  capabilities: () => unknown;
  ready: () => Promise<boolean>;
  identityVerifier?: ServiceIdentityVerifier;
  /**
   * CR06-05 test-only carve-out. Unauthenticated non-health traffic is allowed
   * only when this flag is explicitly `true`, no `identityVerifier` is wired,
   * and the process runs under a recognized test runner (Jest/Vitest); the
   * carve-out also logs a warning on activation. This is the explicit
   * allowlist: a test harness opts in visibly instead of a missing verifier
   * silently opening the server. Production composition never sets it.
   */
  allowUnauthenticatedTestTraffic?: boolean;
  acceptingInvocations?: () => boolean;
  /** Restore-only listener: GETs and exact control observations are allowed;
   * every other mutation is rejected before any route side effect. */
  isolatedReadOnly?: boolean;
  maxBodyBytes?: number;
}

/**
 * CR06-05: service identity is fail-closed on every composition path.
 * Resolves the verifier that must guard the server, or `null` for the
 * test-only unauthenticated carve-out. Construction fails closed when neither
 * a verifier nor the explicitly gated carve-out is configured; the carve-out
 * itself is rejected outside a recognized test runner.
 */
export function resolveIdentityVerifier(
  dependencies: Pick<ConnectorHttpDependencies, 'identityVerifier' | 'allowUnauthenticatedTestTraffic'>,
): ServiceIdentityVerifier | null {
  if (dependencies.identityVerifier) return dependencies.identityVerifier;
  if (dependencies.allowUnauthenticatedTestTraffic === true) {
    if (!isRecognizedTestRuntime()) {
      throw new Error(
        'Connector test-only unauthenticated traffic is only allowed under a test runner; '
        + 'wire an identityVerifier instead.',
      );
    }
    console.warn(
      '[connector] CR06-05 test-only carve-out active: serving non-health routes without service identity; '
      + 'this must never happen in production.',
    );
    return null;
  }
  throw new Error(
    'Connector service identity verification is required; provide identityVerifier or explicitly opt into the '
    + 'test-only allowUnauthenticatedTestTraffic carve-out.',
  );
}

function isRecognizedTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test'
    || process.env.JEST_WORKER_ID !== undefined
    || process.env.VITEST !== undefined;
}

export function createConnectorServer(dependencies: ConnectorHttpDependencies): DrainableConnectorServer {
  const identityVerifier = resolveIdentityVerifier(dependencies);
  let activeRequests = 0;
  const requestDrainWaiters = new Set<() => void>();
  const server = createServer((request, response) => {
    activeRequests += 1;
    void route(request, response, dependencies, identityVerifier)
      .catch((error: unknown) => {
        const connectorError = error instanceof ConnectorError
          ? error
          : new ConnectorError('INVALID_INPUT', 'Request could not be processed.');
        try {
          if (response.destroyed || response.writableEnded) return;
          writeJson(response, errorStatus(connectorError), {
            // retryable/retryAfterMs are already declared on the wire error shape
            // (W39-CC2 passthrough); sending them lets a client stop inferring
            // retryability from the HTTP status, which cannot tell a 502 that
            // rejected the request from a 502 that is a genuine upstream outage.
            error: {
              code: connectorError.code,
              message: connectorError.message,
              retryable: connectorError.safeToRetry,
              retryAfterMs: connectorError.retryAfterMs,
            },
          });
        } catch {
          response.destroy();
        }
      })
      .finally(() => {
        activeRequests -= 1;
        if (activeRequests === 0) {
          for (const resolve of requestDrainWaiters) resolve();
          requestDrainWaiters.clear();
        }
      });
  });

  return Object.assign(server, {
    drainRequests(timeoutMs: number): Promise<boolean> {
      if (activeRequests === 0) return Promise.resolve(true);
      if (timeoutMs <= 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (drained: boolean): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          requestDrainWaiters.delete(onIdle);
          resolve(drained);
        };
        const onIdle = (): void => finish(true);
        requestDrainWaiters.add(onIdle);
        timer = setTimeout(() => finish(false), timeoutMs);
      });
    },
  });
}

/** A restore-rehearsal process remains queryable for read/decrypt probes but
 * cannot invoke, poll, cancel, test providers, or mutate Connector state. */
export function isolatedConnectorRequestAllowed(method: string, path: string): boolean {
  // GET invocation is a state-advancing poll: it may contact the provider and
  // settle a pending result. Restore rehearsal keeps durable invocation
  // history readable through the Orchestrator, but never polls this service.
  if (method === 'GET' && path.startsWith('/invocations/')) return false;
  return method === 'GET'
    || (method === 'POST' && (path === '/internal/admin/runtime-control/observe'
      || path === '/internal/admin/runtime-control/backup-effect-fence/observe'));
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ConnectorHttpDependencies,
  identityVerifier: ServiceIdentityVerifier | null,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://connector.local');
  const path = url.pathname;
  if (identityVerifier && path !== '/health/live' && path !== '/health/ready') {
    const requiredScope = requiredInternalScope(path);
    await requireServiceIdentity(
      {
        authorization: request.headers.authorization,
        'x-service-scope': headerValue(request.headers['x-service-scope']),
      },
      identityVerifier,
      requiredScope,
    );
  }
  if (dependencies.isolatedReadOnly === true && !isolatedConnectorRequestAllowed(method, path)) {
    throw new ConnectorError('CONNECTOR_DISABLED', 'Connector is in isolated restore read-only mode.');
  }

  function headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  // W-VAULT01-BIND-1R: management scope selector. Absent = unbound legacy
  // chain (wire-compatible); a named tenant selects only rows whose trusted
  // binding (storage, migration 008) is that tenant.
  function managementScope(body?: Record<string, unknown>): RevisionScope | undefined {
    const raw = body && body.tenantId !== undefined ? body.tenantId : url.searchParams.get('tenant');
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string' || raw.length > 64 || (raw.length > 0 && !/^[a-z0-9][a-z0-9._-]*$/.test(raw))) {
      throw new ConnectorError('INVALID_INPUT', 'Tenant scope is invalid.');
    }
    return raw.length > 0 ? { tenantId: raw } : {};
  }

  if (method === 'GET' && path === '/health/live') return writeJson(response, 200, { ok: true });
  if (method === 'GET' && path === '/health/ready') {
    const ready = await dependencies.ready();
    return writeJson(response, ready ? 200 : 503, { ok: ready });
  }
  if (method === 'GET' && path === '/capabilities') return writeJson(response, 200, dependencies.capabilities());
  if (method === 'GET' && path === '/internal/admin/connector-capabilities') {
    return writeJson(response, 200, dependencies.capabilities());
  }
  if (method === 'GET' && path === '/internal/admin/signals/usage') {
    if (!dependencies.runtime.getSignalSnapshot) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector signal projection is not configured.');
    }
    const query = ConnectorSignalSnapshotQuerySchema.safeParse({
      tenantId: singleQueryValue(url, 'tenantId'),
      from: singleQueryValue(url, 'from'),
      to: singleQueryValue(url, 'to'),
    });
    if (!query.success) throw new ConnectorError('INVALID_INPUT', 'Connector signal query is invalid.');
    const snapshot = await dependencies.runtime.getSignalSnapshot(query.data);
    const parsed = ConnectorSignalSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector signal projection is invalid.');
    return writeJson(response, 200, parsed.data);
  }
  if (method === 'POST' && path === '/internal/admin/runtime-control/observe') {
    if (!dependencies.replicaRuntimeControl) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector replica runtime-control is not configured.');
    }
    const expected = ConnectorReplicaRuntimeReadRequestSchema.safeParse(
      await readJson(request, dependencies.maxBodyBytes ?? 16_384),
    );
    if (!expected.success) throw new ConnectorError('INVALID_INPUT', 'Connector replica identity is invalid.');
    const restoreExternalEffects = dependencies.isolatedReadOnly === true
      ? dependencies.restoreExternalEffects?.()
      : undefined;
    if (dependencies.isolatedReadOnly === true && !restoreExternalEffects) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Isolated Connector effect observations are unavailable.');
    }
    const observation = await dependencies.replicaRuntimeControl.observe(
      expected.data,
      dependencies.ready,
      dependencies.runtimeHealth,
      restoreExternalEffects,
    );
    const parsed = ConnectorReplicaRuntimeObservationSchema.safeParse(observation);
    if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector replica observation is invalid.');
    return writeJson(response, 200, parsed.data);
  }
  if (method === 'POST' && path === '/internal/admin/runtime-control/backup-effect-fence/observe') {
    if (!dependencies.backupEffectFence) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup effect-fence observer is not configured.');
    }
    const requestBody = ConnectorBackupEffectFenceObservationRequestSchema.safeParse(
      await readJson(request, dependencies.maxBodyBytes ?? 16_384),
    );
    if (!requestBody.success) throw new ConnectorError('INVALID_INPUT', 'Connector backup effect-fence observation request is invalid.');
    const result = await dependencies.backupEffectFence.observe(requestBody.data);
    const parsed = ConnectorBackupEffectFenceObservationSchema.safeParse(result);
    if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector backup effect-fence observation is invalid.');
    return writeJson(response, 200, parsed.data);
  }
  if (method === 'POST' && path === '/internal/admin/runtime-control/backup-effect-fence/hold') {
    if (!dependencies.backupEffectFence) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup effect-fence controller is not configured.');
    }
    const command = ConnectorBackupEffectFenceCommandSchema.safeParse(
      await readJson(request, dependencies.maxBodyBytes ?? 16_384),
    );
    if (!command.success || command.data.action !== 'HOLD') throw new ConnectorError('INVALID_INPUT', 'Connector backup effect-fence hold command is invalid.');
    const result = await dependencies.backupEffectFence.hold(command.data);
    const parsed = ConnectorBackupEffectFenceObservationSchema.safeParse(result);
    if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector backup effect-fence hold response is invalid.');
    return writeJson(response, 200, parsed.data);
  }
  if (method === 'POST' && path === '/internal/admin/runtime-control/backup-effect-fence/release') {
    if (!dependencies.backupEffectFence) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup effect-fence controller is not configured.');
    }
    const command = ConnectorBackupEffectFenceCommandSchema.safeParse(
      await readJson(request, dependencies.maxBodyBytes ?? 16_384),
    );
    if (!command.success || command.data.action !== 'RELEASE') throw new ConnectorError('INVALID_INPUT', 'Connector backup effect-fence release command is invalid.');
    const result = await dependencies.backupEffectFence.release(command.data);
    return writeJson(response, 200, result);
  }
  if (method === 'POST' && path === '/internal/admin/runtime-control/drain') {
    if (!dependencies.replicaRuntimeControl) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector replica runtime-control is not configured.');
    }
    const command = ConnectorReplicaControlCommandSchema.safeParse(
      await readJson(request, dependencies.maxBodyBytes ?? 16_384),
    );
    if (!command.success) throw new ConnectorError('INVALID_INPUT', 'Connector drain command is invalid.');
    const ack = await dependencies.replicaRuntimeControl.requestDrain(command.data);
    return writeJson(response, 200, ack);
  }
  if (method === 'POST' && path === '/internal/admin/runtime-control/resume') {
    if (!dependencies.replicaRuntimeControl) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector replica runtime-control is not configured.');
    }
    const command = ConnectorReplicaControlCommandSchema.safeParse(
      await readJson(request, dependencies.maxBodyBytes ?? 16_384),
    );
    if (!command.success) throw new ConnectorError('INVALID_INPUT', 'Connector resume command is invalid.');
    const ack = await dependencies.replicaRuntimeControl.requestResume(command.data);
    return writeJson(response, 200, ack);
  }
  if (method === 'GET' && path === '/internal/admin/connector-revisions/active') {
    if (!dependencies.parityManagement) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector recipe management is not configured.');
    }
    const queryValues = (name: string): string | undefined => {
      const values = url.searchParams.getAll(name);
      if (values.length > 1) throw new ConnectorError('INVALID_INPUT', `Connector catalog query parameter ${name} must appear once.`);
      return values[0];
    };
    const rawQuery: Record<string, unknown> = { tenantId: queryValues('tenantId') };
    const q = queryValues('q');
    const cursor = queryValues('cursor');
    const limit = queryValues('limit');
    if (q !== undefined) rawQuery['q'] = q;
    if (cursor !== undefined) rawQuery['cursor'] = cursor;
    if (limit !== undefined) rawQuery['limit'] = limit;
    const parsedQuery = TenantActiveConnectorCatalogQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) throw new ConnectorError('INVALID_INPUT', 'Tenant Connector catalog query is invalid.');
    const page = await dependencies.parityManagement.listActiveConnectorRevisions(parsedQuery.data);
    const parsedPage = TenantActiveConnectorCatalogPageSchema.safeParse(page);
    if (!parsedPage.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Tenant Connector catalog response is invalid.');
    return writeJson(response, 200, parsedPage.data);
  }
  if (method === 'GET' && path === '/internal/admin/connector-revisions/catalog') {
    if (!dependencies.parityManagement) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector recipe management is not configured.');
    }
    const queryValues = (name: string): string | undefined => {
      const values = url.searchParams.getAll(name);
      if (values.length > 1) throw new ConnectorError('INVALID_INPUT', `Typed Connector catalog query parameter ${name} must appear once.`);
      return values[0];
    };
    const rawQuery: Record<string, unknown> = { tenantId: queryValues('tenantId') };
    const q = queryValues('q');
    const cursor = queryValues('cursor');
    const limit = queryValues('limit');
    if (q !== undefined) rawQuery['q'] = q;
    if (cursor !== undefined) rawQuery['cursor'] = cursor;
    if (limit !== undefined) rawQuery['limit'] = limit;
    for (const name of url.searchParams.keys()) {
      if (!['tenantId', 'q', 'cursor', 'limit'].includes(name)) {
        throw new ConnectorError('INVALID_INPUT', 'Typed Connector catalog query contains an unsupported parameter.');
      }
    }
    const parsedQuery = TenantConnectorRecipeCatalogQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) throw new ConnectorError('INVALID_INPUT', 'Tenant typed Connector catalog query is invalid.');
    const page = await dependencies.parityManagement.listConnectorRecipeCatalog(parsedQuery.data);
    const parsedPage = TenantConnectorRecipeCatalogPageSchema.safeParse(page);
    if (!parsedPage.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Tenant typed Connector catalog response is invalid.');
    return writeJson(response, 200, parsedPage.data);
  }
  if (method === 'POST' && path === '/internal/admin/provider-tests') {
    if (dependencies.acceptingInvocations && !dependencies.acceptingInvocations()) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector is draining and is not accepting provider tests.');
    }
    if (!dependencies.runtime.testExactRevision) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider-test runtime is not configured.');
    }
    const result = await dependencies.runtime.testExactRevision(
      await readJson(request, dependencies.maxBodyBytes ?? CONNECTOR_INVOCATION_MAX_BODY_BYTES),
    );
    const parsed = ProviderTestResultSchema.safeParse(result);
    if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider-test runtime returned an invalid result.');
    return writeJson(response, 200, parsed.data);
  }
  {
    const base = /^\/internal\/admin\/connector-revisions\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (base) {
      if (!dependencies.parityManagement) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector recipe management is not configured.');
      }
      let connectorId: string;
      try { connectorId = decodeURIComponent(base[1] ?? ''); }
      catch { throw new ConnectorError('INVALID_INPUT', 'Connector identifier is invalid.'); }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectorId) || connectorId.includes('..')) {
        throw new ConnectorError('INVALID_INPUT', 'Connector identifier is invalid.');
      }
      const tail = base[2] ?? '';
      if (method === 'GET' && tail === 'chain') {
        const tenantId = singleQueryValue(url, 'tenantId');
        if (!isTenantUuid(tenantId)) {
          throw new ConnectorError('INVALID_INPUT', 'Tenant scope is invalid.');
        }
        const hasTypedChain = await dependencies.parityManagement.hasTypedChain(tenantId, connectorId);
        return writeJson(response, 200, { hasTypedChain });
      }
      if (method === 'POST' && tail === 'claim') {
        const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384);
        if (!isRecord(body) || !hasExactly(body, ['tenantId', 'expectedHeadRevision', 'idempotencyKey'])
          || typeof body.tenantId !== 'string'
          || !isTenantUuid(body.tenantId)
          || typeof body.expectedHeadRevision !== 'number'
          || !Number.isSafeInteger(body.expectedHeadRevision) || body.expectedHeadRevision < 0
          || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 200) {
          throw new ConnectorError('INVALID_INPUT', 'Connector draft claim is invalid.');
        }
        const result = await dependencies.parityManagement.claimRecipeDraft({
          tenantId: body.tenantId,
          connectorId,
          expectedHeadRevision: body.expectedHeadRevision,
          idempotencyKey: body.idempotencyKey,
        });
        return writeJson(response, 200, result);
      }
      if (method === 'GET' && /^\d+$/.test(tail)) {
        const tenantId = singleQueryValue(url, 'tenantId');
        if (!isTenantUuid(tenantId)) {
          throw new ConnectorError('INVALID_INPUT', 'Tenant scope is invalid.');
        }
        const revision = Number(tail);
        const value = await dependencies.parityManagement.getRevision(tenantId, connectorId, revision);
        if (!value) return writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Connector recipe revision was not found.' } });
        const parsed = ConnectorParityRevisionSchema.safeParse(value);
        if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector recipe revision is invalid.');
        return writeJson(response, 200, parsed.data);
      }
      if (method === 'PUT' && tail === 'draft') {
        const raw = await readJson(request, dependencies.maxBodyBytes ?? CONNECTOR_INVOCATION_MAX_BODY_BYTES);
        if (!isRecord(raw) || !hasOnly(raw, ['tenantId', 'expectedHeadRevision', 'recipe', 'credentialChange', 'idempotencyKey', 'credentialImportSource'])) {
          throw new ConnectorError('INVALID_INPUT', 'Connector recipe draft request is invalid.');
        }
        const credentialImportSource = raw.credentialImportSource;
        const publicBody = { ...raw };
        delete publicBody.credentialImportSource;
        const parsed = ConnectorDraftUpsertSchema.safeParse(publicBody);
        if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Connector recipe draft request is invalid.');
        if (credentialImportSource !== undefined) {
          if (!isRecord(credentialImportSource) || !hasExactly(credentialImportSource, ['catalogVersionRef', 'catalogKeyVersion'])
            || typeof credentialImportSource.catalogVersionRef !== 'string'
            || !/^[0-9a-f-]{36}@[1-9][0-9]{0,8}$/i.test(credentialImportSource.catalogVersionRef)
            || typeof credentialImportSource.catalogKeyVersion !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(credentialImportSource.catalogKeyVersion)
            || parsed.data.credentialChange.action !== 'replace') {
            throw new ConnectorError('INVALID_INPUT', 'Catalog import provenance is invalid.');
          }
        }
        const input: ConnectorInternalDraftUpsert = {
          tenantId: parsed.data.tenantId,
          connectorId,
          expectedHeadRevision: parsed.data.expectedHeadRevision,
          recipe: parsed.data.recipe,
          credentialChange: parsed.data.credentialChange,
          ...(credentialImportSource === undefined ? {} : {
            credentialImportSource: {
              catalogVersionRef: credentialImportSource.catalogVersionRef as string,
              catalogKeyVersion: credentialImportSource.catalogKeyVersion as string,
            },
          }),
          idempotencyKey: parsed.data.idempotencyKey,
        };
        const result = await dependencies.parityManagement.upsertDraft(input);
        const checked = ConnectorParityDraftResultSchema.safeParse(result);
        if (!checked.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector draft result is invalid.');
        return writeJson(response, 201, checked.data);
      }
      const activate = /^(\d+)\/activate$/.exec(tail);
      if (method === 'POST' && activate) {
        const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384);
        if (!isRecord(body) || !hasExactly(body, ['tenantId', 'expectedCurrentRevision'])
          || typeof body.tenantId !== 'string'
          || !isTenantUuid(body.tenantId)
          || typeof body.expectedCurrentRevision !== 'number'
          || !Number.isSafeInteger(body.expectedCurrentRevision) || body.expectedCurrentRevision < 0) {
          throw new ConnectorError('INVALID_INPUT', 'Connector activation request is invalid.');
        }
        const result = await dependencies.parityManagement.activateRevision(
          body.tenantId,
          connectorId,
          Number(activate[1]),
          body.expectedCurrentRevision,
        );
        const checked = ConnectorParityActivationResultSchema.safeParse(result);
        if (!checked.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector activation result is invalid.');
        return writeJson(response, checked.data.activated ? 200 : 409, checked.data);
      }
      const retire = /^(\d+)\/retire$/.exec(tail);
      if (method === 'POST' && retire) {
        const raw = await readJson(request, dependencies.maxBodyBytes ?? 16_384);
        const parsed = ConnectorParityRetirementRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Connector recipe retirement request is invalid.');
        const result = await dependencies.parityManagement.retireRevision({
          ...parsed.data,
          connectorId,
          revision: Number(retire[1]),
        });
        const checked = ConnectorParityRetirementResultSchema.safeParse(result);
        if (!checked.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector retirement result is invalid.');
        return writeJson(response, checked.data.retired ? 200 : 409, checked.data);
      }
      if (method === 'POST' && tail === 'rollback/draft') {
        const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384);
        if (!isRecord(body) || !hasExactly(body, ['tenantId', 'sourceRevision', 'expectedHeadRevision', 'idempotencyKey'])
          || typeof body.tenantId !== 'string'
          || !isTenantUuid(body.tenantId)
          || typeof body.sourceRevision !== 'number' || !Number.isSafeInteger(body.sourceRevision) || body.sourceRevision < 1
          || typeof body.expectedHeadRevision !== 'number' || !Number.isSafeInteger(body.expectedHeadRevision) || body.expectedHeadRevision < 0
          || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 200) {
          throw new ConnectorError('INVALID_INPUT', 'Connector rollback request is invalid.');
        }
        const input: ConnectorInternalRollbackDraft = {
          tenantId: body.tenantId,
          connectorId,
          sourceRevision: body.sourceRevision,
          expectedHeadRevision: body.expectedHeadRevision,
          idempotencyKey: body.idempotencyKey,
        };
        const result = await dependencies.parityManagement.createRollbackDraft(input);
        const checked = ConnectorParityDraftResultSchema.safeParse(result);
        if (!checked.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Connector rollback result is invalid.');
        return writeJson(response, 201, checked.data);
      }
      return writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    }
  }
  const providerTestEvidencePath = /^\/internal\/admin\/provider-test-invocations\/([^/]+)$/.exec(path);
  if (method === 'GET' && providerTestEvidencePath) {
    if (!dependencies.runtime.getProviderTestEvidence) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider-test evidence is not configured.');
    }
    const rawInvocationId = decodeURIComponent(providerTestEvidencePath[1] ?? '');
    const rawRevision = singleQueryValue(url, 'revision');
    const revision = rawRevision === null ? Number.NaN : Number(rawRevision);
    const query = ConnectorProviderTestEvidenceQuerySchema.safeParse({
      tenantId: singleQueryValue(url, 'tenantId'),
      operationId: singleQueryValue(url, 'operationId'),
      taskId: singleQueryValue(url, 'taskId'),
      invocationId: rawInvocationId,
      connectorId: singleQueryValue(url, 'connectorId'),
      revision,
    });
    if (!query.success) throw new ConnectorError('INVALID_INPUT', 'Provider-test evidence query is invalid.');
    const evidence = await dependencies.runtime.getProviderTestEvidence(query.data);
    if (!evidence) return writeJson(response, 404, { error: { code: 'INVOCATION_UNKNOWN', message: 'Provider-test evidence was not found.' } });
    const parsed = ConnectorProviderTestEvidenceSchema.safeParse(evidence);
    if (!parsed.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider-test evidence is invalid.');
    return writeJson(response, 200, parsed.data);
  }
  if (method === 'GET' && path === '/connectors') {
    const revisions = await dependencies.management.list();
    return writeJson(response, 200, revisions.map(redactConnectorRevision));
  }
  if (method === 'POST' && path === '/connectors') {
    const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as Record<string, unknown>;
    if (
      typeof body.connectorId !== 'string'
      || typeof body.adapter !== 'string'
      || typeof body.credentialRef !== 'string'
      || (body.state !== undefined && body.state !== 'ACTIVE' && body.state !== 'PENDING')
      || (body.credentialSource !== undefined
        && (body.credentialSource === null || typeof body.credentialSource !== 'object' || Array.isArray(body.credentialSource)))
      || body.config === null
      || typeof body.config !== 'object'
      || Array.isArray(body.config)
      || (body.accountId !== undefined && typeof body.accountId !== 'string')
    ) {
      throw new ConnectorError('INVALID_INPUT', 'Connector revision fields are invalid.');
    }
    if (body.tenantId !== undefined && typeof body.tenantId !== 'string') {
      throw new ConnectorError('INVALID_INPUT', 'Connector revision fields are invalid.');
    }
    const revision = await dependencies.management.createRevision({
      connectorId: body.connectorId,
      adapter: body.adapter,
      config: body.config as ConnectorRevision['config'],
      credentialRef: body.credentialRef,
      state: body.state === 'PENDING' ? 'PENDING' : 'ACTIVE',
      ...(body.tenantId === undefined ? {} : { tenantId: body.tenantId as string }),
      ...(body.accountId === undefined ? {} : { accountId: body.accountId as string }),
      ...(body.credentialSource === undefined ? {} : { credentialSource: body.credentialSource as ConnectorRevision['credentialSource'] }),
    });
    return writeJson(response, 201, redactConnectorRevision(revision));
  }
  // VAULT-06 lifecycle routes: PENDING creation cloned from CURRENT,
  // CAS activation, and reconcile-retire. Masked metadata only in bodies.
  {
    const pending = /^\/connectors\/([^/]+)\/revisions$/.exec(path);
    if (pending && method === 'POST') {
      const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as {
        credentialSource?: unknown;
        tenantId?: unknown;
        accountId?: unknown;
      };
      if (
        body.credentialSource === undefined
        || body.credentialSource === null
        || typeof body.credentialSource !== 'object'
        || Array.isArray(body.credentialSource)
        || typeof body.tenantId !== 'string'
        || typeof body.accountId !== 'string'
      ) {
        throw new ConnectorError('INVALID_INPUT', 'credentialSource and independent revision binding are required.');
      }
      const connectorId = decodeURIComponent(pending[1]!);
      const created = await dependencies.management.createPendingRevision(
        connectorId,
        body.credentialSource,
        { tenantId: body.tenantId, connectorId, accountId: body.accountId },
      );
      return writeJson(response, 201, redactConnectorRevision(created));
    }
    // W-VAULT-LEGACY-TRANSITION-1: first-bound-chain creation is its own
    // route; the ordinary /revisions clone path structurally cannot create
    // revision 1 of a bound chain (CAS activate needs a prior ACTIVE row).
    const bootstrapped = /^\/connectors\/([^/]+)\/revisions\/bootstrap$/.exec(path);
    if (bootstrapped && method === 'POST') {
      const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as {
        credentialSource?: unknown;
        tenantId?: unknown;
        accountId?: unknown;
      };
      if (
        body.credentialSource === undefined
        || body.credentialSource === null
        || typeof body.credentialSource !== 'object'
        || Array.isArray(body.credentialSource)
        || typeof body.tenantId !== 'string'
        || typeof body.accountId !== 'string'
      ) {
        throw new ConnectorError('INVALID_INPUT', 'credentialSource and independent revision binding are required.');
      }
      const connectorId = decodeURIComponent(bootstrapped[1]!);
      const { revision, replayed } = await dependencies.management.bootstrapRevision(
        connectorId,
        body.credentialSource,
        { tenantId: body.tenantId, connectorId, accountId: body.accountId },
      );
      return writeJson(response, 201, { ...redactConnectorRevision(revision), replayed });
    }
    const activated = /^\/connectors\/([^/]+)\/revisions\/(\d+)\/activate$/.exec(path);
    if (activated && method === 'POST') {
      const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as { expectedCurrentRevision?: unknown };
      if (
        typeof body.expectedCurrentRevision !== 'number'
        || !Number.isInteger(body.expectedCurrentRevision)
        || body.expectedCurrentRevision < 1
      ) {
        throw new ConnectorError('INVALID_INPUT', 'expectedCurrentRevision must be a positive integer.');
      }
      const ok = await dependencies.management.activateRevision(
        decodeURIComponent(activated[1]!),
        Number(activated[2]),
        body.expectedCurrentRevision,
        managementScope(body),
      );
      return writeJson(response, ok ? 200 : 409, { activated: ok });
    }
    const retired = /^\/connectors\/([^/]+)\/revisions\/(\d+)\/retire$/.exec(path);
    if (retired && method === 'POST') {
      await dependencies.management.retireRevision(
        decodeURIComponent(retired[1]!),
        Number(retired[2]),
        managementScope(),
      );
      return writeJson(response, 204, undefined);
    }
    const current = /^\/connectors\/([^/]+)\/revisions\/current$/.exec(path);
    if (current && method === 'GET') {
      const revision = await dependencies.management.getCurrentRevision(decodeURIComponent(current[1]!), managementScope());
      if (!revision) return writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'No current revision.' } });
      return writeJson(response, 200, redactConnectorRevision(revision));
    }
    const one = /^\/connectors\/([^/]+)\/revisions\/(\d+)$/.exec(path);
    if (one && method === 'GET') {
      const revision = await dependencies.management.getRevision(
        decodeURIComponent(one[1]!),
        Number(one[2]),
        managementScope(),
      );
      if (!revision) return writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Revision not found.' } });
      return writeJson(response, 200, redactConnectorRevision(revision));
    }
  }
  if (method === 'GET' && path.startsWith('/invocations/')) {
    const result = await dependencies.runtime.get(
      path.slice('/invocations/'.length),
      headerValue(request.headers['x-invocation-grant']),
    );
    return writeJson(
      response,
      result ? 200 : 404,
      result
        ? toContractInvocationResponse(result.invocationId, result)
        : { error: { code: 'NOT_FOUND', message: 'Invocation not found.' } },
    );
  }
  if (method === 'POST' && path === '/invocations') {
    if (dependencies.acceptingInvocations && !dependencies.acceptingInvocations()) {
      throw new ConnectorError('CONNECTOR_DISABLED', 'Connector is draining.');
    }
    const invocation = parseContractInvocationRequest(
      await readJson(request, dependencies.maxBodyBytes ?? CONNECTOR_INVOCATION_MAX_BODY_BYTES),
    );
    const result = await dependencies.runtime.invoke(invocation);
    return writeJson(response, result.state === 'pending' ? 202 : 200, toContractInvocationResponse(result.invocationId, result));
  }
  if (method === 'POST' && path.startsWith('/invocations/') && path.endsWith('/cancel')) {
    const invocationId = path.slice('/invocations/'.length, -'/cancel'.length);
    const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as { reason?: unknown };
    if (typeof body.reason !== 'string' || body.reason.length > 500) {
      throw new ConnectorError('INVALID_INPUT', 'Cancellation reason is required and must be short.');
    }
    const result = await dependencies.runtime.cancel(
      invocationId,
      body.reason,
      headerValue(request.headers['x-invocation-grant']),
    );
    return writeJson(response, 202, toContractInvocationResponse(result.invocationId, result));
  }
  if (method === 'POST' && path.startsWith('/connectors/') && path.endsWith('/credentials/rotate')) {
    const connectorId = path.slice('/connectors/'.length, -'/credentials/rotate'.length);
    const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as { secret?: unknown };
    if (typeof body.secret !== 'string' || body.secret.length === 0) {
      throw new ConnectorError('INVALID_INPUT', 'Credential secret is required.');
    }
    await dependencies.management.rotateCredential(connectorId, body.secret, managementScope(body));
    return writeJson(response, 204, undefined);
  }
  if (method === 'POST' && path.startsWith('/connectors/') && path.endsWith('/disable')) {
    const connectorId = path.slice('/connectors/'.length, -'/disable'.length);
    await dependencies.management.disable(connectorId, managementScope());
    return writeJson(response, 204, undefined);
  }
  if (method === 'POST' && path.startsWith('/connectors/') && path.endsWith('/test')) {
    const connectorId = path.slice('/connectors/'.length, -'/test'.length);
    return writeJson(response, 200, await dependencies.management.test(connectorId, managementScope()));
  }
  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

function requiredInternalScope(path: string): string {
  if (path.startsWith('/internal/admin/runtime-control/')) return 'connector:runtime-control';
  if (path === '/internal/admin/connector-capabilities') return 'connector:management';
  if (path === '/internal/admin/provider-tests' || path.startsWith('/internal/admin/provider-test-invocations/')) {
    return 'connector:provider-test';
  }
  if (path.startsWith('/internal/admin/connector-revisions/')) return 'connector:management';
  if (path.startsWith('/internal/admin/signals')) return 'connector:signals:read';
  if (path.startsWith('/connectors')) return 'connector:manage';
  return 'connector:invoke';
}

function singleQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) return null;
  return values[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allow = new Set(keys);
  return Object.keys(value).every((key) => allow.has(key));
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnly(value, keys);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new ConnectorError('INVALID_INPUT', 'Request body is too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ConnectorError('INVALID_INPUT', 'Request body must be valid JSON.');
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  if (status !== 204) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
    return;
  }

  function errorStatus(error: ConnectorError): number {
    switch (error.code) {
      case 'INVALID_INPUT':
      case 'INVALID_PROVIDER_RESPONSE':
        return 400;
      case 'GRANT_INVALID':
        return 401;
      case 'BINDING_DENIED':
        return 403;
      case 'INPUT_HASH_MISMATCH':
        return 409;
      case 'QUOTA_EXHAUSTED':
      case 'BUDGET_LIMIT_EXCEEDED':
      case 'PROVIDER_RATE_LIMITED':
        return 429;
      case 'CREDENTIAL_INVALID':
        return 401;
      case 'CONNECTOR_DISABLED':
        return 409;
      case 'PROVIDER_TIMEOUT':
        return 504;
      case 'PROVIDER_UNAVAILABLE':
        return 502;
      case 'PROVIDER_REQUEST_REJECTED':
        // The caller sent a well-formed request and the upstream refused it, so the
        // fault is the upstream hop. 400 would wrongly tell the orchestrator its own
        // request was malformed and send it looking in the wrong place.
        return 502;
      case 'INVOCATION_UNKNOWN':
        return 409;
      default:
        return 500;
    }
  }
  response.end();
}

function errorStatus(error: ConnectorError): number {
  switch (error.code) {
    case 'INVALID_INPUT':
    case 'INVALID_PROVIDER_RESPONSE':
      return 400;
    case 'GRANT_INVALID':
      return 401;
    case 'BINDING_DENIED':
      return 403;
    case 'INPUT_HASH_MISMATCH':
    case 'CANCELLED':
      return 409;
    case 'QUOTA_EXHAUSTED':
    case 'BUDGET_LIMIT_EXCEEDED':
    case 'PROVIDER_RATE_LIMITED':
      return 429;
    case 'CREDENTIAL_INVALID':
      return 401;
    case 'CONNECTOR_DISABLED':
      return 409;
    case 'PROVIDER_TIMEOUT':
      return 504;
    case 'PROVIDER_UNAVAILABLE':
      return 502;
    case 'PROVIDER_REQUEST_REJECTED':
      // The caller sent a well-formed request and the upstream refused it, so the
      // fault is the upstream hop. 400 would wrongly tell the orchestrator its own
      // request was malformed and send it looking in the wrong place.
      return 502;
    case 'INVOCATION_UNKNOWN':
      return 409;
    default:
      return 500;
  }
}
