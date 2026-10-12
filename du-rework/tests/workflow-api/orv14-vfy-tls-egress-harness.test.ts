import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createPinnedFetch, DestinationDeniedError } from '../../orchestrator/packages/egress/src/pinned-fetch';

const fixtureHost = 'orv14-vfy.test';
const fixtureDirectory = `${__dirname}/orv14-vfy/https-fixture`;
const requests: Array<{ method: string; path: string; host: string; body: string }> = [];
let server: Server | undefined;
let origin = '';

beforeAll(async () => {
  server = createHttpsServer({
    key: readFileSync(`${fixtureDirectory}/server-key.pem`),
    cert: readFileSync(`${fixtureDirectory}/fixture-ca.pem`),
  }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        host: request.headers.host ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.method === 'GET' && request.url === '/artifact') {
        const body = 'synthetic-pinned-tls-fixture';
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      if (request.method === 'POST' && request.url === '/callback') {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  origin = `https://${fixtureHost}:${address.port}`;
}, 10_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
});

describe('ORV14 synthetic HTTPS fixture for pinned egress transport only', () => {
  test('rejects private answers by default, and explicit fixture opt-in uses one pinned address with verified TLS', async () => {
    const defaultResolver = jest.fn(async (_host: string) => ['127.0.0.1']);
    const deniedFetch = createPinnedFetch({ resolve: defaultResolver, timeoutMs: 5_000 });
    await expect(deniedFetch(`${origin}/artifact`)).rejects.toBeInstanceOf(DestinationDeniedError);
    expect(defaultResolver).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);

    const resolvedHosts: string[] = [];
    const pinnedFetch = createPinnedFetch({
      allowPrivateNetworks: true,
      timeoutMs: 5_000,
      resolve: async (host) => {
        resolvedHosts.push(host);
        return ['127.0.0.1'];
      },
    });
    const downloaded = await pinnedFetch(`${origin}/artifact`);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('synthetic-pinned-tls-fixture');
    expect(resolvedHosts).toEqual([fixtureHost]);
    expect(requests).toEqual([{ method: 'GET', path: '/artifact', host: new URL(origin).host, body: '' }]);

    const callback = await pinnedFetch(`${origin}/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture: 'orv14-vfy', effect: 'none' }),
    });
    expect(callback.status).toBe(204);
    expect(resolvedHosts).toEqual([fixtureHost, fixtureHost]);
    expect(requests[1]).toEqual({
      method: 'POST', path: '/callback', host: new URL(origin).host,
      body: '{"fixture":"orv14-vfy","effect":"none"}',
    });

    const beforeWrongHost = requests.length;
    const wrongHostFetch = createPinnedFetch({
      allowPrivateNetworks: true,
      timeoutMs: 5_000,
      resolve: async () => ['127.0.0.1'],
    });
    await expect(wrongHostFetch(`https://wrong-host.orv14-vfy.test:${new URL(origin).port}/artifact`)).rejects.toThrow();
    expect(requests).toHaveLength(beforeWrongHost);
  }, 15_000);
});
