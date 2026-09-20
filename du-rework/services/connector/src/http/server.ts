import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { redactConnectorRevision } from '../config';
import type { ConnectorRevision } from '../db/repository';
import { ConnectorError } from '../errors';
import { requireServiceIdentity } from '../identity';
import type { ServiceIdentityVerifier } from '../types';
import { parseContractInvocationRequest, toContractInvocationResponse } from '../contracts';

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
  get(connectorId: string): Promise<ConnectorRevision | undefined>;
  createRevision(input: Omit<ConnectorRevision, 'revision'>): Promise<ConnectorRevision>;
  rotateCredential(connectorId: string, secret: string): Promise<void>;
  disable(connectorId: string): Promise<void>;
  test(connectorId: string): Promise<{ ok: boolean; errorCode?: string }>;
}

export interface ConnectorRuntime {
  invoke(body: unknown): Promise<HttpInvocationResult>;
  get(invocationId: string): Promise<HttpInvocationResult | undefined>;
  cancel(invocationId: string, reason: string): Promise<HttpInvocationResult>;
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

export function createConnectorServer(dependencies: ConnectorHttpDependencies): Server {
  return createServer(async (request, response) => {
    try {
      await route(request, response, dependencies);
    } catch (error) {
      const connectorError = error instanceof ConnectorError
        ? error
        : new ConnectorError('INVALID_INPUT', 'Request could not be processed.');
      writeJson(response, errorStatus(connectorError), {
        error: { code: connectorError.code, message: connectorError.message },
      });
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ConnectorHttpDependencies,
): Promise<void> {
  const method = request.method ?? 'GET';
  const path = new URL(request.url ?? '/', 'http://connector.local').pathname;
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
      || (body.state !== undefined && body.state !== 'ACTIVE')
      || body.config === null
      || typeof body.config !== 'object'
      || Array.isArray(body.config)
    ) {
      throw new ConnectorError('INVALID_INPUT', 'Connector revision fields are invalid.');
    }
    const revision = await dependencies.management.createRevision({
      connectorId: body.connectorId,
      adapter: body.adapter,
      config: body.config as ConnectorRevision['config'],
      credentialRef: body.credentialRef,
      state: 'ACTIVE',
    });
    return writeJson(response, 201, redactConnectorRevision(revision));
  }
  if (method === 'GET' && path.startsWith('/invocations/')) {
    const result = await dependencies.runtime.get(path.slice('/invocations/'.length));
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
    const result = await dependencies.runtime.cancel(invocationId, body.reason);
    return writeJson(response, 202, toContractInvocationResponse(result.invocationId, result));
  }
  if (method === 'POST' && path.startsWith('/connectors/') && path.endsWith('/credentials/rotate')) {
    const connectorId = path.slice('/connectors/'.length, -'/credentials/rotate'.length);
    const body = await readJson(request, dependencies.maxBodyBytes ?? 16_384) as { secret?: unknown };
    if (typeof body.secret !== 'string' || body.secret.length === 0) {
      throw new ConnectorError('INVALID_INPUT', 'Credential secret is required.');
    }
    await dependencies.management.rotateCredential(connectorId, body.secret);
    return writeJson(response, 204, undefined);
  }
  if (method === 'POST' && path.startsWith('/connectors/') && path.endsWith('/disable')) {
    const connectorId = path.slice('/connectors/'.length, -'/disable'.length);
    await dependencies.management.disable(connectorId);
    return writeJson(response, 204, undefined);
  }
  if (method === 'POST' && path.startsWith('/connectors/') && path.endsWith('/test')) {
    const connectorId = path.slice('/connectors/'.length, -'/test'.length);
    return writeJson(response, 200, await dependencies.management.test(connectorId));
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
