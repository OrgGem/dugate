import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { redactConnectorRevision } from '../config';
import type { ConnectorRevision, NewConnectorRevision, RevisionScope } from '../db/repository';
import { ConnectorError } from '../errors';
import { requireServiceIdentity } from '../identity';
import type { ServiceIdentityVerifier } from '../types';
import { parseContractInvocationRequest, toContractInvocationResponse } from '../contracts';
import type { DrainableConnectorServer } from '../lifecycle';
import type { ConnectorRevisionBinding } from '@du/contracts';

export interface HttpInvocationResult {
  invocationId: string;
  state: 'completed' | 'pending' | 'unknown' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  providerRequestId?: string;
  error?: { code: string; message: string; retryAfterMs?: number };
  nextPollAt?: string;
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
}

export interface ConnectorHttpDependencies {
  management: ConnectorHttpStore;
  runtime: ConnectorRuntime;
  capabilities: () => unknown;
  ready: () => Promise<boolean>;
  identityVerifier?: ServiceIdentityVerifier;
  acceptingInvocations?: () => boolean;
  maxBodyBytes?: number;
}

export function createConnectorServer(dependencies: ConnectorHttpDependencies): DrainableConnectorServer {
  let activeRequests = 0;
  const requestDrainWaiters = new Set<() => void>();
  const server = createServer((request, response) => {
    activeRequests += 1;
    void route(request, response, dependencies)
      .catch((error: unknown) => {
        const connectorError = error instanceof ConnectorError
          ? error
          : new ConnectorError('INVALID_INPUT', 'Request could not be processed.');
        try {
          if (response.destroyed || response.writableEnded) return;
          writeJson(response, errorStatus(connectorError), {
            error: { code: connectorError.code, message: connectorError.message },
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

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ConnectorHttpDependencies,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://connector.local');
  const path = url.pathname;
  if (dependencies.identityVerifier && path !== '/health/live' && path !== '/health/ready') {
    await requireServiceIdentity(
      {
        authorization: request.headers.authorization,
        'x-service-scope': headerValue(request.headers['x-service-scope']),
      },
      dependencies.identityVerifier,
      path.startsWith('/connectors') ? 'connector:manage' : 'connector:invoke',
    );
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
    const invocation = parseContractInvocationRequest(await readJson(request, dependencies.maxBodyBytes ?? 1_048_576));
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
    case 'INVOCATION_UNKNOWN':
      return 409;
    default:
      return 500;
  }
}
