import { authorizeConnectorProbe } from '../src/modules/connectors/probe-authorization';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnectorProxy } from '../src/modules/connectors/connectors';
import { HttpError } from '../src/http/errors';

const principal = { id: 'key-a', tenantId: 'tenant-a' };
const own = {
  api_key_id: principal.id,
  tenant_id: principal.tenantId,
  enabled: true,
  connector_bindings: { reasoning: { connectorId: 'connector-a', revision: 1 } },
};

function database(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

describe('PLAT-MIG-02 published connector probe authorization', () => {
  it('allows an enabled published binding scoped to the caller key and tenant', async () => {
    const db = database([own]);
    await authorizeConnectorProbe(db, principal, 'connector-a');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('profile_active_revisions'), ['key-a', 'tenant-a']);
    expect(db.query.mock.calls[0]![0]).toContain('p.revision = a.revision');
    expect(db.query.mock.calls[0]![0]).toContain("k.status = 'ACTIVE'");
  });

  it.each([
    ['foreign tenant', [{ ...own, tenant_id: 'tenant-b' }]],
    ['foreign key in the same tenant', [{ ...own, api_key_id: 'key-b' }]],
    ['disabled profile', [{ ...own, enabled: false }]],
    ['unbound key or missing active pointer', []],
    ['another connector', [{ ...own, connector_bindings: { reasoning: { connectorId: 'connector-b', revision: 1 } } }]],
  ])('denies %s', async (_name, rows) => {
    await expect(authorizeConnectorProbe(database(rows), principal, 'connector-a'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('fails closed for malformed stored bindings without echoing their content', async () => {
    await expect(authorizeConnectorProbe(database([{ ...own, connector_bindings: { secret: 'sensitive-config' } }]), principal, 'connector-a'))
      .rejects.toMatchObject({ status: 503, message: 'connector probe authorization is unavailable' });
  });

  it('does not convert a database outage into authorization', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('database unavailable')) };
    await expect(authorizeConnectorProbe(db, principal, 'connector-a')).rejects.toThrow('database unavailable');
  });
});

describe('public readiness route before outbound probe', () => {
  function context(bindings: unknown[]) {
    const db = database(bindings);
    db.query.mockResolvedValueOnce({ rows: [{ id: principal.id, tenant_id: principal.tenantId }], rowCount: 1 });
    const testConnector = jest.fn().mockResolvedValue({ connectorId: 'connector-a', ok: true, latencyMs: 1 });
    const ctx = {
      method: 'GET', pathname: '/api/v1/connectors/connector-a/test',
      headers: { 'x-api-key': 'fixture-key' }, db, connectors: { testConnector },
    } as unknown as RouteContext;
    return { ctx, db, testConnector };
  }

  it('keeps the existing response shape for an authorized connector', async () => {
    const { ctx, testConnector } = context([own]);
    await expect(handlePublicRoutes(ctx)).resolves.toEqual({
      status: 200, body: { connectorId: 'connector-a', ok: true, latencyMs: 1 },
    });
    expect(testConnector).toHaveBeenCalledTimes(1);
    expect(testConnector).toHaveBeenCalledWith('connector-a');
  });

  it.each([
    ['unbound', []],
    ['foreign tenant', [{ ...own, tenant_id: 'tenant-b' }]],
    ['foreign key', [{ ...own, api_key_id: 'key-b' }]],
    ['disabled', [{ ...own, enabled: false }]],
    ['unknown connector', [{ ...own, connector_bindings: {} }]],
  ])('denies %s with zero outbound probes', async (_name, rows) => {
    const { ctx, testConnector } = context(rows);
    await expect(handlePublicRoutes(ctx)).rejects.toMatchObject({ status: 403 });
    expect(testConnector).not.toHaveBeenCalled();
  });

  it('rejects a revoked/unknown API key before binding lookup or probing', async () => {
    const { ctx, db, testConnector } = context([own]);
    db.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(handlePublicRoutes(ctx)).rejects.toMatchObject({ status: 401 });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(testConnector).not.toHaveBeenCalled();
  });
});

describe('HTTP readiness boundary with a real loopback Connector probe', () => {
  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  it.each([
    ['own binding', [own], 200, 1],
    ['unbound', [], 403, 0],
    ['foreign tenant', [{ ...own, tenant_id: 'tenant-b' }], 403, 0],
  ])('%s: enforces authorization before sending HTTP to Connector', async (_name, rows, status, expectedProbes) => {
    let probes = 0;
    const connector = createServer((_request, response) => {
      probes += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const connectorUrl = await listen(connector);
    const proxy = createConnectorProxy({ baseUrlFor: () => connectorUrl });
    const db = database(rows);
    db.query.mockResolvedValueOnce({ rows: [{ id: principal.id, tenant_id: principal.tenantId }], rowCount: 1 });
    const api = createServer((request, response) => {
      const ctx = {
        method: request.method, pathname: request.url, headers: request.headers,
        db, connectors: proxy,
      } as unknown as RouteContext;
      void handlePublicRoutes(ctx).then((result) => {
        response.writeHead(result?.status ?? 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result?.body));
      }).catch((error: unknown) => {
        response.writeHead(error instanceof HttpError ? error.status : 500);
        response.end();
      });
    });
    try {
      const apiUrl = await listen(api);
      const response = await fetch(`${apiUrl}/api/v1/connectors/connector-a/test`, {
        headers: { 'x-api-key': 'fixture-key' },
      });
      expect(response.status).toBe(status);
      if (status === 200) expect(await response.json()).toMatchObject({ connectorId: 'connector-a', ok: true });
      else await response.text();
      expect(probes).toBe(expectedProbes);
    } finally {
      if (api.listening) await close(api);
      await close(connector);
    }
  });
});
