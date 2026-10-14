import type { ConnectorReplicaIdentity } from '@du/contracts';
import type { SqlClient, SqlResult } from '../src/db/sql';
import { PostgresConnectorBackupEffectControl } from '../src/db/backup-effect-fences';
import { createConnectorParityManagement } from '../src/modules/parity-management';
import { createConnectorServer } from '../src/http/server';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CONNECTOR = 'tenant-sentinel-route';
const BAD_TENANT = `${TENANT}\n`;

const RECIPE = {
  adapter: 'json-http',
  method: 'POST',
  endpointUrl: 'https://api.example.invalid/v1/generate',
  auth: { kind: 'none' },
  headers: [],
  request: { promptField: 'prompt', fields: [] },
  response: { contentPath: 'choices.0.message.content' },
  session: { capture: [], inject: [] },
  timeoutMs: 10_000,
  responseBytes: 65_536,
} as const;

const REVISION = {
  tenantId: TENANT,
  connectorId: CONNECTOR,
  revision: 1,
  state: 'PENDING',
  recipe: RECIPE,
  credentialRef: null,
  credentialVersion: null,
  expectedHeadRevision: 0,
};

function identityVerifier(scopes = ['connector:management']) {
  return { verify: async () => ({ subject: 'tenant-sentinel-test', audience: 'connector', scopes }) };
}

async function withServer<T>(
  parityManagement: Record<string, jest.Mock>,
  callback: (base: string) => Promise<T>,
): Promise<T> {
  const server = createConnectorServer({
    management: {} as never,
    parityManagement: parityManagement as never,
    runtime: {} as never,
    capabilities: () => ({}),
    ready: async () => true,
    identityVerifier: identityVerifier(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Connector test server did not bind');
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function routeCases() {
  const revisionResult = { revision: REVISION, expectedHeadRevision: 0, replayed: false };
  const parityManagement = {
    hasTypedChain: jest.fn(async () => true),
    claimRecipeDraft: jest.fn(async () => ({ claimed: true, expectedHeadRevision: 0 })),
    getRevision: jest.fn(async () => REVISION),
    activateRevision: jest.fn(async () => ({ activated: false, currentRevision: null })),
    createRollbackDraft: jest.fn(async () => revisionResult),
  };
  const cases = [
    {
      label: 'chain lookup', method: 'GET', path: `/internal/admin/connector-revisions/${CONNECTOR}/chain`,
      validUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/chain?tenantId=${TENANT}`,
      invalidUrl: (base: string, tenant: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/chain?tenantId=${encodeURIComponent(tenant)}`,
      call: parityManagement.hasTypedChain,
    },
    {
      label: 'draft claim', method: 'POST', path: `/internal/admin/connector-revisions/${CONNECTOR}/claim`,
      validUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/claim`,
      invalidUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/claim`,
      body: { tenantId: TENANT, expectedHeadRevision: 0, idempotencyKey: 'tenant-sentinel-claim' },
      invalidBody: (tenant: string) => ({ tenantId: tenant, expectedHeadRevision: 0, idempotencyKey: 'tenant-sentinel-claim' }),
      call: parityManagement.claimRecipeDraft,
    },
    {
      label: 'revision lookup', method: 'GET', path: `/internal/admin/connector-revisions/${CONNECTOR}/1`,
      validUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/1?tenantId=${TENANT}`,
      invalidUrl: (base: string, tenant: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/1?tenantId=${encodeURIComponent(tenant)}`,
      call: parityManagement.getRevision,
    },
    {
      label: 'activation', method: 'POST', path: `/internal/admin/connector-revisions/${CONNECTOR}/1/activate`,
      validUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/1/activate`,
      invalidUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/1/activate`,
      body: { tenantId: TENANT, expectedCurrentRevision: 0 },
      invalidBody: (tenant: string) => ({ tenantId: tenant, expectedCurrentRevision: 0 }),
      call: parityManagement.activateRevision,
    },
    {
      label: 'rollback draft', method: 'POST', path: `/internal/admin/connector-revisions/${CONNECTOR}/rollback/draft`,
      validUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/rollback/draft`,
      invalidUrl: (base: string) => `${base}/internal/admin/connector-revisions/${CONNECTOR}/rollback/draft`,
      body: { tenantId: TENANT, sourceRevision: 1, expectedHeadRevision: 0, idempotencyKey: 'tenant-sentinel-rollback' },
      invalidBody: (tenant: string) => ({ tenantId: tenant, sourceRevision: 1, expectedHeadRevision: 0, idempotencyKey: 'tenant-sentinel-rollback' }),
      call: parityManagement.createRollbackDraft,
    },
  ];
  return { parityManagement, cases };
}

const ROUTE_FIXTURES = routeCases();

describe('default tenant UUID compatibility at Connector boundaries', () => {
  beforeEach(() => {
    for (const mock of Object.values(ROUTE_FIXTURES.parityManagement)) mock.mockClear();
  });

  test.each(ROUTE_FIXTURES.cases)('accepts the default tenant for $label', async (route) => {
    const { parityManagement } = ROUTE_FIXTURES;
    await withServer(parityManagement, async (base) => {
      const requestInit: RequestInit = { method: route.method, headers: { authorization: 'Bearer test' } };
      if ('body' in route) {
        requestInit.headers = { ...requestInit.headers, 'content-type': 'application/json' };
        requestInit.body = JSON.stringify(route.body);
      }
      const url = route.method === 'GET' ? route.validUrl(base) : `${base}${route.path}`;
      const response = await fetch(url, requestInit);
      expect([200, 201, 409]).toContain(response.status);
      expect(route.call).toHaveBeenCalled();
    });
  });

  test.each(ROUTE_FIXTURES.cases)('rejects malformed or newline-suffixed tenant for $label', async (route) => {
    const { parityManagement } = ROUTE_FIXTURES;
    await withServer(parityManagement, async (base) => {
      for (const tenant of ['not-a-uuid', BAD_TENANT]) {
        const requestInit: RequestInit = { method: route.method, headers: { authorization: 'Bearer test' } };
        let url = route.invalidUrl(base, tenant);
        if ('body' in route && 'invalidBody' in route && route.invalidBody !== undefined) {
          requestInit.headers = { ...requestInit.headers, 'content-type': 'application/json' };
          requestInit.body = JSON.stringify(route.invalidBody(tenant));
          url = `${base}${route.path}`;
        }
        const response = await fetch(url, requestInit);
        expect(response.status).toBe(400);
      }
      expect(route.call).not.toHaveBeenCalled();
    });
  });

  it('keeps the management scope check ahead of draft claim dispatch', async () => {
    const parityManagement = { claimRecipeDraft: jest.fn(async () => ({ claimed: true, expectedHeadRevision: 0 })) };
    const server = createConnectorServer({
      management: {} as never,
      parityManagement: parityManagement as never,
      runtime: {} as never,
      capabilities: () => ({}),
      ready: async () => true,
      identityVerifier: identityVerifier(['connector:invoke']),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Connector test server did not bind');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/admin/connector-revisions/${CONNECTOR}/claim`, {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: TENANT, expectedHeadRevision: 0, idempotencyKey: 'tenant-sentinel-claim' }),
      });
      expect(response.status).toBe(403);
      expect(parityManagement.claimRecipeDraft).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('accepts the sentinel through parity service scope validation and rejects a suffixed newline', async () => {
    const repository = { hasTypedChain: jest.fn(async () => true) };
    const service = createConnectorParityManagement({ repository: repository as never });
    await expect(service.hasTypedChain(TENANT, CONNECTOR)).resolves.toBe(true);
    await expect(service.hasTypedChain(BAD_TENANT, CONNECTOR)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(repository.hasTypedChain).toHaveBeenCalledTimes(1);
  });

  it('accepts the sentinel only as tenant scope when preparing a backup config effect', async () => {
    const queries: string[] = [];
    const db: SqlClient = {
      async query<Row extends object = Record<string, unknown>>(text: string): Promise<SqlResult<Row>> {
        queries.push(text);
        if (text.includes('FROM connector_backup_effect_gate')) {
          return { rows: [{ fence_id: null, fence_revision: 1, state: 'OPEN' } as unknown as Row] };
        }
        return { rows: [] };
      },
      async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> { return callback(this); },
    };
    const identity: ConnectorReplicaIdentity = {
      slot: 'green', runtimeIdentity: 'connector-green-v1', replicaId: 'connector-green-1', revision: 'build-1',
      imageDigest: `registry.example/connector@sha256:${'a'.repeat(64)}`,
    };
    const control = new PostgresConnectorBackupEffectControl(db, identity, 'boot-1');
    await expect(control.prepare(db, {
      effectId: '11111111-1111-4111-8111-111111111111', tenantId: TENANT, connectorId: CONNECTOR,
      idempotencyKey: 'sentinel-config-write',
    })).resolves.toBeUndefined();
    expect(queries.some((text) => text.includes('INSERT INTO connector_backup_effect_permits'))).toBe(true);
    await expect(control.prepare(db, {
      effectId: '11111111-1111-4111-8111-111111111111', tenantId: BAD_TENANT, connectorId: CONNECTOR,
      idempotencyKey: 'sentinel-config-write',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(control.prepare(db, {
      effectId: TENANT, tenantId: TENANT, connectorId: CONNECTOR,
      idempotencyKey: 'sentinel-config-write',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
