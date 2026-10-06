import type { Db } from '../src/db/db';
import { dispatchAdminAction, ADMIN_ACTIONS_ROUTE } from '../src/modules/admin-actions/dispatcher';
import { canonicalPayloadHash } from '../src/modules/idempotency/idempotency';
import type { ConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import type { AuditService } from '../src/modules/audit/audit';

/**
 * CONNECTOR-WIRE-A — the connector.* admin actions.
 *
 * Offline, direct at the dispatcher seam. Pins: admin-only RBAC (every other
 * role 403/401 with ZERO store calls), CSRF before role, 503 fail-closed
 * without the composed store, exact store inputs for the two upsert modes,
 * CAS loss → 409 without audit, audit rows on the four mutations, the masked
 * test response, and Idempotency-Key replay (one store call, one audit row,
 * second response byte-identical). Pin safety: the action paths must never
 * touch operation pin columns — asserted by capturing every SQL statement.
 */

const VIEW = {
  connectorId: 'mock-connector',
  revision: 4,
  adapter: 'mock-openai',
  state: 'ACTIVE' as const,
  config: { headers: { authorization: '[REDACTED]' } },
};

function makeStore(overrides: Partial<Record<keyof ConnectorManagementStore, jest.Mock>> = {}): ConnectorManagementStore {
  return {
    list: jest.fn(async () => [VIEW]),
    getRevision: jest.fn(async () => VIEW),
    getCurrent: jest.fn(async () => VIEW),
    create: jest.fn(async () => VIEW),
    createPending: jest.fn(async () => ({ ...VIEW, revision: 5, state: 'PENDING' })),
    activate: jest.fn(async () => true),
    retire: jest.fn(async () => undefined),
    disable: jest.fn(async () => undefined),
    test: jest.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as ConnectorManagementStore;
}

function makeDb() {
  const markers = new Map<string, { route: string; payload_hash: string; response_code: number; response_body: unknown }>();
  const sql: string[] = [];
  const client = {
    query: async (s: string, p: unknown[] = []) => {
      sql.push(s.replace(/\s+/g, ' ').trim());
      if (/INSERT INTO admin_idempotency/.test(s)) {
        markers.set(String(p[0]), {
          route: String(p[1]),
          payload_hash: String(p[2]),
          response_code: Number(p[3]),
          response_body: typeof p[4] === 'string' ? JSON.parse(p[4]) : p[4],
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error('unexpected client query: ' + s);
    },
  };
  const db = {
    query: async (s: string, p: unknown[] = []) => {
      sql.push(s.replace(/\s+/g, ' ').trim());
      if (/FROM admin_idempotency/.test(s)) {
        const hit = markers.get(String(p[0]));
        return hit ? { rows: [{ key: String(p[0]), ...hit }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error('unexpected pool query: ' + s);
    },
    tx: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  } as unknown as Db;
  return { db, sql, markers, client };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const { db, sql } = makeDb();
  const audit = { record: jest.fn(async () => undefined) };
  const deps = {
    db,
    audit: audit as unknown as AuditService,
    registry: {} as never,
    profiles: {} as never,
    lifecycle: {} as never,
    runtime: {} as never,
    hashApiKey: (raw: string) => 'hash:' + raw,
    correlationId: 'cw-actions-1',
    connectorManagement: makeStore(),
    ...overrides,
  };
  return { deps: deps as never, audit, sql };
}

const PLATFORM = { kind: 'bearer' as const, principal: { role: 'platform' as const } };

function call(action: string, params: Record<string, unknown>, idempotencyKey?: string) {
  return { action, params, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

describe('CONNECTOR-WIRE-A connector.* actions — RBAC + fail-closed', () => {
  it('admin-only: viewer/operator cookies and anonymous are denied with ZERO store calls', async () => {
    const store = makeStore();
    const { deps } = makeDeps({ connectorManagement: store });

    await expect(dispatchAdminAction(deps, null, call('connector.upsert', {}))).rejects.toMatchObject({ status: 401 });
    await expect(
      dispatchAdminAction(deps, { kind: 'cookie', role: 'viewer', csrfOk: true } as never, call('connector.upsert', {}))
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      dispatchAdminAction(
        deps,
        { kind: 'cookie', role: 'operator', csrfOk: true, tenantId: 't1' } as never,
        call('connector.activate', {})
      )
    ).rejects.toMatchObject({ status: 403 });

    expect(store.list).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
  });

  it('CSRF is checked before the role: a token-less admin cookie cannot probe', async () => {
    const store = makeStore();
    const { deps } = makeDeps({ connectorManagement: store });
    await expect(
      dispatchAdminAction(deps, { kind: 'cookie', role: 'admin', csrfOk: false } as never, call('connector.disable', { connectorId: 'x' }))
    ).rejects.toMatchObject({ status: 403 });
    expect(store.disable).not.toHaveBeenCalled();
  });

  it('absent store → 503 before any side effect, for every connector.* action', async () => {
    const { deps } = makeDeps({ connectorManagement: undefined });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['connector.upsert', { mode: 'create', connectorId: 'c', adapter: 'a', config: {}, credentialRef: 'r' }],
      ['connector.activate', { connectorId: 'c', revision: 2, expectedCurrentRevision: 1 }],
      ['connector.disable', { connectorId: 'c' }],
      ['connector.retire', { connectorId: 'c', revision: 2 }],
      ['connector.test', { connectorId: 'c' }],
    ];
    for (const [action, params] of cases) {
      await expect(dispatchAdminAction(deps, PLATFORM, call(action, params))).rejects.toMatchObject({
        status: 503,
        code: 'TEMPORARY_UNAVAILABLE',
      });
    }
  });

  it('upsert invalid params → 422; unknown mode rejected by the discriminated union', async () => {
    const { deps } = makeDeps();
    await expect(
      dispatchAdminAction(deps, PLATFORM, call('connector.upsert', { mode: 'create', connectorId: 'c' }))
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    await expect(
      dispatchAdminAction(deps, PLATFORM, call('connector.upsert', { mode: 'nonsense', connectorId: 'c' }))
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('CONNECTOR-WIRE-A connector.* actions — happy paths + audit + pin safety', () => {
  it('upsert create: exact store input, 201 view, audit row with principal fields', async () => {
    const store = makeStore();
    const { deps, audit, sql } = makeDeps({ connectorManagement: store });
    const res = await dispatchAdminAction(
      deps,
      PLATFORM,
      call('connector.upsert', {
        mode: 'create',
        connectorId: 'mock-connector',
        adapter: 'mock-openai',
        config: { model: 'gpt-4o-mini' },
        credentialRef: 'connectors/mock-connector/credentials',
        state: 'PENDING',
      })
    );
    expect(res.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith({
      connectorId: 'mock-connector',
      adapter: 'mock-openai',
      config: { model: 'gpt-4o-mini' },
      credentialRef: 'connectors/mock-connector/credentials',
      state: 'PENDING',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'connector.upsert',
        resource: 'connector:mock-connector@rev4',
        actorRole: 'platform',
        severity: 'success',
      }),
      expect.anything()
    );
    // Pin safety: the action never touches operation pin columns.
    expect(sql.some((s) => /operations|connector_bindings|profile_policy_snapshot/i.test(s))).toBe(false);
  });

  it('upsert revision mode: createPending with independent binding coordinates', async () => {
    const store = makeStore();
    const { deps } = makeDeps({ connectorManagement: store });
    const res = await dispatchAdminAction(
      deps,
      PLATFORM,
      call('connector.upsert', {
        mode: 'revision',
        connectorId: 'mock-connector',
        credentialSource: { kind: 'vault-kv2', mount: 'kv', path: 'p', key: 'k' },
        tenantId: 't1',
        accountId: 'a1',
      })
    );
    expect(res.status).toBe(201);
    expect((res.body as { revision: number }).revision).toBe(5);
    expect(store.createPending).toHaveBeenCalledWith('mock-connector', {
      credentialSource: { kind: 'vault-kv2', mount: 'kv', path: 'p', key: 'k' },
      tenantId: 't1',
      accountId: 'a1',
    });
  });

  it('activate: CAS loss → 409 STATE_CONFLICT with NO audit row; win → 200 + audit', async () => {
    {
      const store = makeStore({ activate: jest.fn(async () => false) });
      const { deps, audit } = makeDeps({ connectorManagement: store });
      await expect(
        dispatchAdminAction(deps, PLATFORM, call('connector.activate', { connectorId: 'c', revision: 4, expectedCurrentRevision: 3 }))
      ).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
      expect(audit.record).not.toHaveBeenCalled();
    }
    {
      const store = makeStore();
      const { deps, audit } = makeDeps({ connectorManagement: store });
      const res = await dispatchAdminAction(
        deps,
        PLATFORM,
        call('connector.activate', { connectorId: 'c', revision: 4, expectedCurrentRevision: 3 })
      );
      expect(res.status).toBe(200);
      expect(store.activate).toHaveBeenCalledWith('c', 4, 3);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'connector.activate', resource: 'connector:c@rev4' }),
        expect.anything()
      );
    }
  });

  it('disable/retire: store calls + warning audits, still zero operation-pin SQL', async () => {
    const store = makeStore();
    const { deps, audit, sql } = makeDeps({ connectorManagement: store });
    await dispatchAdminAction(deps, PLATFORM, call('connector.disable', { connectorId: 'c' }));
    await dispatchAdminAction(deps, PLATFORM, call('connector.retire', { connectorId: 'c', revision: 2 }));
    expect(store.disable).toHaveBeenCalledWith('c');
    expect(store.retire).toHaveBeenCalledWith('c', 2);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector.disable', severity: 'warning' }), expect.anything());
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector.retire', severity: 'warning' }), expect.anything());
    expect(sql.some((s) => /operations|connector_bindings|profile_policy_snapshot/i.test(s))).toBe(false);
  });

  it('test: masked response only, not audited (probe mutates nothing)', async () => {
    const store = makeStore({ test: jest.fn(async () => ({ ok: false, errorCode: 'CONNECTOR_DISABLED' })) });
    const { deps, audit } = makeDeps({ connectorManagement: store });
    const res = await dispatchAdminAction(deps, PLATFORM, call('connector.test', { connectorId: 'c' }));
    expect(res).toEqual({ status: 200, body: { connectorId: 'c', ok: false, errorCode: 'CONNECTOR_DISABLED' } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('Idempotency-Key replay: one store call, one audit row, second response byte-identical', async () => {
    const store = makeStore();
    const { deps, audit } = makeDeps({ connectorManagement: store });
    const params = {
      mode: 'create',
      connectorId: 'mock-connector',
      adapter: 'mock-openai',
      config: { model: 'm' },
      credentialRef: 'r',
    };
    const first = await dispatchAdminAction(deps, PLATFORM, call('connector.upsert', params, 'cw-idem-key-1'));
    const second = await dispatchAdminAction(deps, PLATFORM, call('connector.upsert', params, 'cw-idem-key-1'));
    expect(second).toEqual(first);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);

    // A different payload under the same key is a 409, never a silent overwrite.
    await expect(
      dispatchAdminAction(deps, PLATFORM, call('connector.upsert', { ...params, adapter: 'other' }, 'cw-idem-key-1'))
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
});

void canonicalPayloadHash;
