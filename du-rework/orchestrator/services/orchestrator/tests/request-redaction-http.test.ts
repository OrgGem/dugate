import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';
import { HttpError } from '../src/http/errors';

const original = { email: 'private@example.com', phone: '0901234567' };
let queries = 0;
let corrupt = false;
let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const ctx = {
      method: 'GET', pathname: '/api/v1/operations/privacy-op', searchParams: new URLSearchParams(), headers: req.headers,
      config: { adminToken: 'platform', tenantAdminTokens: { operator: 'tenant-a', foreign: 'tenant-b' } },
      runtime: { getOperation: async () => ({ id: 'privacy-op', state: 'RUNNING', tenant_id: 'tenant-a', profile_id: 'profile', profile_revision: 1, input_ref: original }) },
      db: { query: async () => { queries++; return { rows: [{ is_current: true, is_pinned: true, request_redaction: corrupt ? [{ pattern: '(' }] : [{ pattern: '[^ ]+@[^ ]+' }, { pattern: '(090)1234567', replacement: '$1*******' }] }] }; } },
    } as unknown as RouteContext;
    void handlePublicRoutes(ctx).then(result => { res.writeHead(result?.status ?? 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(result?.body)); }, error => {
      res.writeHead(error instanceof HttpError ? error.status : 500); res.end(JSON.stringify({ code: error instanceof HttpError ? error.code : 'INTERNAL' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { queries = 0; corrupt = false; });

for (const token of ['platform', 'operator']) {
  test(`${token} HTTP response masks input before it leaves the server`, async () => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(original.email);
    expect(text).not.toContain(original.phone);
    expect(JSON.parse(text).requestInput).toMatchObject({ status: 'REDACTED', data: { email: '[REDACTED]', phone: '090*******' } });
    expect(original).toEqual({ email: 'private@example.com', phone: '0901234567' });
  });
}
test('foreign tenant receives 404 without loading input policy', async () => {
  const response = await fetch(url, { headers: { authorization: 'Bearer foreign' } });
  expect(response.status).toBe(404);
  expect(queries).toBe(0);
  expect(await response.text()).not.toContain('private@example.com');
});
test('corrupt stored policy returns fully hidden input over HTTP', async () => {
  corrupt = true;
  const response = await fetch(url, { headers: { authorization: 'Bearer platform' } });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(JSON.parse(text).requestInput).toMatchObject({ status: 'HIDDEN', data: '[REDACTED]' });
  expect(text).not.toContain('private@example.com');
});
