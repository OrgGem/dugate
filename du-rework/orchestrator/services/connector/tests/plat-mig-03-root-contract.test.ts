import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createConnectorServer, type ConnectorHttpStore } from '../src/http/server';
import { HmacServiceIdentityVerifier } from '../src/identity';
import type { ConnectorRevision } from '../src/db/repository';

const secret = Buffer.alloc(32, 7); // Offline fixture key only.
function token(scopes: string[], overrides: Record<string, unknown> = {}, key = secret): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'orchestrator-management', aud: 'connector', scopes,
    exp: Math.floor(Date.now() / 1000) + 60, ...overrides,
  })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
}

const revision: ConnectorRevision = {
  connectorId: 'c1', revision: 1, adapter: 'json-http',
  config: { baseUrl: 'https://provider.example', path: '/infer', headers: { authorization: 'provider-private' }, timeoutMs: 1000 },
  credentialRef: 'credential-1', state: 'ACTIVE', tenantId: '',
  credentialSource: { kind: 'legacy-db', credentialRef: 'credential-1' },
};
const list = jest.fn(async () => [revision]);
const management: ConnectorHttpStore = {
  list,
  get: async () => revision,
  getRevision: async () => revision,
  getCurrentRevision: async () => revision,
  createRevision: async () => revision,
  createPendingRevision: async () => ({ ...revision, revision: 2, state: 'PENDING' }),
  bootstrapRevision: async () => ({ revision, replayed: false }),
  activateRevision: async () => true,
  retireRevision: async () => {},
  rotateCredential: async () => {},
  disable: async () => {},
  test: async () => ({ ok: true }),
};
const invoke = jest.fn(async (_body: unknown) => ({ invocationId: 'inv-1', state: 'completed' as const }));
const get = jest.fn(async (invocationId: string, _grant?: string) => ({ invocationId, state: 'completed' as const }));
const cancel = jest.fn(async (invocationId: string, _reason: string, _grant?: string) => ({ invocationId, state: 'cancelled' as const }));
const server = createConnectorServer({
  management, runtime: { invoke, get, cancel },
  capabilities: () => ({ adapters: ['json-http'] }), ready: async () => true,
  identityVerifier: new HmacServiceIdentityVerifier(secret),
});
let base: string;
async function request(path: string, bearer?: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
}

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => jest.clearAllMocks());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
});

describe('PLAT-MIG-03 real Connector router and signed identity', () => {
  test('root management list accepts signed manage identity and redacts provider headers', async () => {
    const response = await request('/connectors', token(['connector:manage']));
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
    expect(response.text).toContain('[REDACTED]');
    expect(response.text).not.toContain('provider-private');
  });

  test.each([
    ['missing', undefined, 401],
    ['wrong signature', token(['connector:manage'], {}, Buffer.alloc(32, 8)), 401],
    ['expired', token(['connector:manage'], { exp: Math.floor(Date.now() / 1000) - 1 }), 401],
    ['wrong audience', token(['connector:manage'], { aud: 'platform' }), 403],
    ['invoke-only scope', token(['connector:invoke']), 403],
  ])('management rejects %s identity before store access', async (_label, bearer, status) => {
    const response = await request('/connectors', bearer);
    expect(response.status).toBe(status);
    expect(list).not.toHaveBeenCalled();
  });

  test('adapter capabilities requires invoke scope, distinct from platform admin capabilities', async () => {
    expect((await request('/capabilities', token(['connector:manage']))).status).toBe(403);
    const allowed = await request('/capabilities', token(['connector:invoke']));
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ adapters: ['json-http'] });
  });

  test.each(['/internal/v1/connectors', '/management/connectors', '/management/capabilities', '/connectors/c1'])('%s is not a supported alias', async (path) => {
    expect((await request(path, token(['connector:manage', 'connector:invoke']))).status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  test.each(['/health/live', '/health/ready'])('%s is a health probe without Bearer auth', async (path) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  test.each([
    ['POST', '/connectors', { connectorId: 'c1', adapter: 'json-http', config: revision.config, credentialRef: 'credential-1' }, 201],
    ['GET', '/connectors/c1/revisions/current', undefined, 200],
    ['GET', '/connectors/c1/revisions/1', undefined, 200],
    ['POST', '/connectors/c1/revisions', { credentialSource: { kind: 'legacy-db', credentialRef: 'credential-1' }, tenantId: 'tenant-1', accountId: 'account-1' }, 201],
    ['POST', '/connectors/c1/revisions/bootstrap', { credentialSource: { kind: 'legacy-db', credentialRef: 'credential-1' }, tenantId: 'tenant-1', accountId: 'account-1' }, 201],
    ['POST', '/connectors/c1/revisions/2/activate', { expectedCurrentRevision: 1 }, 200],
    ['POST', '/connectors/c1/revisions/1/retire', undefined, 204],
    ['POST', '/connectors/c1/test', undefined, 200],
    ['POST', '/connectors/c1/credentials/rotate', { secret: 'offline-rotation-fixture' }, 204],
    ['POST', '/connectors/c1/disable', undefined, 204],
  ])('%s %s preserves management status', async (method, path, body, status) => {
    expect((await request(path, token(['connector:manage']), method, body)).status).toBe(status);
  });

  test('invoke/get/cancel use root paths, invoke identity and separate runtime grant', async () => {
    const bearer = token(['connector:invoke']);
    const body = {
      contractVersion: '1', invocationId: 'inv-1', grant: 'runtime-grant',
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      stepKey: 'extract', bindingSlot: 'reasoning', input: { text: 'fixture' },
      options: {}, deadlineAt: '2099-01-01T00:00:00.000Z',
    };
    expect((await request('/invocations', bearer, 'POST', body)).body?.state).toBe('SUCCEEDED');
    expect(invoke).toHaveBeenCalledWith(body);
    expect((await request('/invocations/inv-1', bearer, 'GET', undefined, { 'x-invocation-grant': 'read-grant' })).status).toBe(200);
    expect(get).toHaveBeenCalledWith('inv-1', 'read-grant');
    expect((await request('/invocations/inv-1/cancel', bearer, 'POST', { reason: 'fixture' }, { 'x-invocation-grant': 'cancel-grant' })).status).toBe(202);
    expect(cancel).toHaveBeenCalledWith('inv-1', 'fixture', 'cancel-grant');
  });

  test('manage-only identity cannot read an invocation', async () => {
    expect((await request('/invocations/inv-1', token(['connector:manage']))).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  test('generated OpenAPI preserves root paths, origin and JWT scope matrix', () => {
    const spec = JSON.parse(readFileSync(resolve(__dirname, '../../../../docs/21-openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { security?: unknown; servers?: { url: string }[]; 'x-required-service-scope'?: string; parameters?: { name: string; required: boolean }[] }>>;
    };
    expect(Object.keys(spec.paths).some((path) => /^\/(internal\/v1|management\/)/.test(path))).toBe(false);
    for (const [path, method, scope] of [
      ['/connectors', 'get', 'connector:manage'],
      ['/connectors/{id}/revisions/current', 'get', 'connector:manage'],
      ['/capabilities', 'get', 'connector:invoke'],
      ['/invocations', 'post', 'connector:invoke'],
      ['/invocations/{id}', 'get', 'connector:invoke'],
      ['/invocations/{id}/cancel', 'post', 'connector:invoke'],
    ]) {
      const operation = spec.paths[path!]![method!]!;
      expect(operation['x-required-service-scope']).toBe(scope);
      expect(operation.servers).toEqual(expect.arrayContaining([expect.objectContaining({ url: 'http://localhost:8080' })]));
      expect(operation.security).toEqual([{ Svc: [] }]);
    }
    expect(spec.paths['/invocations/{id}']!['get']!.parameters).toContainEqual(expect.objectContaining({ name: 'x-invocation-grant', required: true }));
    expect(spec.paths['/health/ready']!['get']!.security).toEqual([]);
  });
});
