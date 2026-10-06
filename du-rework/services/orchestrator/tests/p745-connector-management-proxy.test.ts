import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import { handleAdminRoutes } from '../src/http/routes/admin';
import type { RouteContext } from '../src/http/route-context';
import type { ConnectorManagementStore } from '../src/modules/connectors/connector-management-store';

/**
 * CONNECTOR-WIRE-A — management proxy + thin admin reads.
 *
 * Offline: a scripted fetch stands in for the Connector service. Pins the
 * proxy's contract: redaction preserved ([REDACTED] header values), unknown
 * connector fields DROPPED (the platform DTO is .strict()), transport→503,
 * unexpected→502 with no upstream body echoed, 404→undefined, CAS 409→false,
 * and the admin routes' composition-derived behavior (capabilities booleans,
 * list 503 without the store, real ledger when composed).
 */

const REVISION = {
  connectorId: 'mock-connector',
  revision: 3,
  adapter: 'mock-openai',
  state: 'ACTIVE',
  config: { headers: { authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' }, model: 'gpt-4o-mini' },
  credentialRef: 'connectors/mock-connector/credentials',
  credentialSource: { kind: 'vault-kv2', mount: 'kv', path: 'du/tenants/t1/connectors/mock-connector/accounts/a1', key: 'api_key' },
  tenantId: 't1',
  accountId: 'a1',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as unknown as Response;
}

function scriptedFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string; body?: unknown; headers?: Record<string, string> }[];
} {
  const calls: { url: string; method: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? undefined,
    });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function store(fetchImpl: typeof fetch, authorizationForRequest: () => string = () => 'Bearer offline-management-token'): ConnectorManagementStore {
  return createConnectorManagementStore({
    baseUrlFor: (connectorId?: string) =>
      connectorId === undefined
        ? 'http://connector.test'
        : connectorId === 'mock-connector'
          ? 'http://connector.test'
          : (() => {
              throw new Error('unknown connector');
            })(),
    authorizationForRequest,
    fetchImpl,
  });
}

function ctx(overrides: Record<string, unknown> = {}): RouteContext {
  return {
    method: 'GET',
    pathname: '/api/v1/admin/connectors',
    searchParams: new URLSearchParams(),
    headers: { authorization: 'Bearer cw-admin-token' },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'cw-test-1',
    config: { adminToken: 'cw-admin-token' },
    ...overrides,
  } as unknown as RouteContext;
}

describe('CONNECTOR-WIRE-A management store', () => {
  it('list: passthrough keeps redaction; unknown connector fields FAIL CLOSED (strict DTO, never widen)', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => jsonResponse(200, [REVISION]));
    const items = await store(fetchImpl).list();
    expect(calls[0]!.url).toBe('http://connector.test/connectors');
    expect(calls[0]!.method).toBe('GET');
    expect(items).toHaveLength(1);
    expect(items[0]!.config.headers).toEqual({ authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' });
    expect(items[0]!.credentialRef).toBe('connectors/mock-connector/credentials');

    // A connector that grew an unknown field is refused (502), not relayed:
    // the platform DTO is the closing contract, not a best-effort filter.
    const widened = scriptedFetch(() =>
      jsonResponse(200, [{ ...REVISION, FUTURE_FIELD: 'must-not-leak', credentialSecretValue: 's3cr3t' }]),
    );
    await expect(store(widened.fetchImpl).list()).rejects.toMatchObject({ status: 502, code: 'CONNECTOR_API_ERROR' });
  });

  it('fresh Bearer authorization rides every management call', async () => {
    const withHeaders = scriptedFetch((url) =>
      url.endsWith('/revisions/3') ? jsonResponse(200, REVISION) : jsonResponse(200, [REVISION]),
    );
    let issued = 0;
    const authorizationForRequest = () => 'Bearer offline-management-' + (++issued);
    await store(withHeaders.fetchImpl, authorizationForRequest).list();
    await store(withHeaders.fetchImpl, authorizationForRequest).getRevision('mock-connector', 3);
    expect(withHeaders.calls).toHaveLength(2);
    expect(withHeaders.calls[0]?.headers?.authorization).toBe('Bearer offline-management-1');
    expect(withHeaders.calls[1]?.headers?.authorization).toBe('Bearer offline-management-2');
    expect(withHeaders.calls.some((call) => call.headers?.['x-service-identity'] !== undefined)).toBe(false);
  });

  it('transport failure is 503 TEMPORARY_UNAVAILABLE (reconcile — never assume no-write)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(store(fetchImpl).activate('mock-connector', 3, 2)).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_UNAVAILABLE',
    });
  });

  it('unexpected status is 502 with the upstream body NOT echoed', async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse(500, { error: { message: 'internal detail that must not leak' } }));
    await expect(store(fetchImpl).list()).rejects.toMatchObject({ status: 502, code: 'CONNECTOR_API_ERROR' });
    // 502 (status) is the whole answer; the body text never rides along.
    await store(fetchImpl)
      .list()
      .catch((err: { message?: string }) => {
        expect(String(err.message)).not.toContain('internal detail');
      });
  });

  it('a 200 that violates the platform DTO is a 502 (never best-effort passthrough)', async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse(200, { connectorId: 'mock-connector' }));
    await expect(store(fetchImpl).getRevision('mock-connector', 3)).rejects.toMatchObject({
      status: 502,
      code: 'CONNECTOR_API_ERROR',
    });
  });

  it('getRevision 404 → undefined; activate CAS 409 → false; 200 → true; retire/disable 204 → void', async () => {
    {
      const { fetchImpl } = scriptedFetch(() => jsonResponse(404, { error: { code: 'NOT_FOUND' } }));
      await expect(store(fetchImpl).getRevision('mock-connector', 9)).resolves.toBeUndefined();
    }
    {
      const { fetchImpl } = scriptedFetch(() => jsonResponse(409, { activated: false }));
      await expect(store(fetchImpl).activate('mock-connector', 4, 3)).resolves.toBe(false);
    }
    {
      const { fetchImpl } = scriptedFetch(() => jsonResponse(200, { activated: true }));
      await expect(store(fetchImpl).activate('mock-connector', 4, 3)).resolves.toBe(true);
    }
    {
      const { fetchImpl, calls } = scriptedFetch(() => new Response(null, { status: 204 }) as unknown as Response);
      await expect(store(fetchImpl).retire('mock-connector', 3)).resolves.toBeUndefined();
      await expect(store(fetchImpl).disable('mock-connector')).resolves.toBeUndefined();
      expect(calls.map((c) => c.url)).toEqual([
        'http://connector.test/connectors/mock-connector/revisions/3/retire',
        'http://connector.test/connectors/mock-connector/disable',
      ]);
    }
  });

  it('test: result narrowed to the masked pair — probe detail never rides through', async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse(200, { ok: true, errorCode: undefined, providerBody: { secret: 'x' }, latencyMs: 42 }),
    );
    await expect(store(fetchImpl).test('mock-connector')).resolves.toEqual({ ok: true });
  });
});

describe('CONNECTOR-WIRE-A admin routes (thin reads + capability advertisement)', () => {
  const okStore = store(scriptedFetch(() => jsonResponse(200, [REVISION])).fetchImpl);

  it('capabilities are composition-derived booleans and flip together with the store', async () => {
    const without = await handleAdminRoutes(ctx({ pathname: '/api/v1/admin/connectors/capabilities' }));
    expect(without).toEqual({ status: 200, body: { management: false, credentialWorkflow: false, test: false } });

    const with_ = await handleAdminRoutes(
      ctx({ pathname: '/api/v1/admin/connectors/capabilities', connectorManagement: okStore, credentialWorkflow: {} }),
    );
    expect(with_).toEqual({ status: 200, body: { management: true, credentialWorkflow: true, test: true } });
  });

  it('list: 503 without the store (fail closed); {items} passthrough with it', async () => {
    await expect(handleAdminRoutes(ctx())).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });

    const res = await handleAdminRoutes(ctx({ connectorManagement: okStore }));
    expect(res?.status).toBe(200);
    const items = (res?.body as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
    expect((items[0] as { config: { headers: Record<string, string> } }).config.headers.authorization).toBe('[REDACTED]');
  });

  it('revision read: real ledger when composed (latest → current; digits → revision), 404 when missing', async () => {
    const calls: string[] = [];
    const realStore = store(
      scriptedFetch((url) => {
        calls.push(url);
        if (url.endsWith('/revisions/current')) return jsonResponse(200, { ...REVISION, revision: 5 });
        if (url.endsWith('/revisions/3')) return jsonResponse(200, REVISION);
        return jsonResponse(404, { error: { code: 'NOT_FOUND' } });
      }).fetchImpl,
    );
    const latest = await handleAdminRoutes(
      ctx({ pathname: '/api/v1/admin/connectors/mock-connector/revisions/latest', connectorManagement: realStore }),
    );
    expect((latest?.body as { revision: number }).revision).toBe(5);
    const exact = await handleAdminRoutes(
      ctx({ pathname: '/api/v1/admin/connectors/mock-connector/revisions/3', connectorManagement: realStore }),
    );
    expect((exact?.body as { revision: number }).revision).toBe(3);
    await expect(
      handleAdminRoutes(ctx({ pathname: '/api/v1/admin/connectors/mock-connector/revisions/9', connectorManagement: realStore })),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([
      'http://connector.test/connectors/mock-connector/revisions/current',
      'http://connector.test/connectors/mock-connector/revisions/3',
      'http://connector.test/connectors/mock-connector/revisions/9',
    ]);
  });

  it('revision read without the store keeps the honest placeholder (no fabricated ledger)', async () => {
    const res = await handleAdminRoutes(
      ctx({
        pathname: '/api/v1/admin/connectors/mock-connector/revisions/1',
        config: { adminToken: 'cw-admin-token', connectorBaseUrls: { 'mock-connector': 'http://user:pw@connector.test:9003' } },
      }),
    );
    expect(res?.status).toBe(200);
    const body = res?.body as { adapter: string; state: string; capabilities: unknown[] };
    expect(body.adapter).toBe('unknown');
    expect(body.state).toBe('disabled');
    expect(body.capabilities).toEqual([]);
  });
});
