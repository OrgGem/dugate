import { buildDialOptions, createPinnedFetch, DestinationDeniedError } from '../src/pinned-fetch';
import { BoundaryListener, sleep } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * @du/egress pinned-fetch boundary (PR-Q3-09). Offline: loopback listeners only,
 * resolver always injected — the system DNS is never consulted by this suite.
 *
 * Run (cwd du-rework/): pnpm --dir packages/egress exec jest tests/egress-boundaries.boundary.test.ts --runInBand
 */

const listeners: BoundaryListener[] = [];
async function startListener(): Promise<BoundaryListener> {
  const l = await BoundaryListener.start();
  listeners.push(l);
  return l;
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

afterEach(async () => {
  while (listeners.length > 0) {
    const l = listeners.pop();
    if (l) await l.stop().catch(() => undefined);
  }
});

/**
 * Windows loopback port churn (kit README pitfall 1): after rapid stop/listen cycles a
 * SYN can vanish and the connect fails ETIMEDOUT/RST while the listener witnessed
 * NOTHING. That failure shape is an environment artifact, not production behavior —
 * retry exactly that shape once. Anything the listener saw propagates unchanged.
 */
async function withLoopbackRetry<T>(fn: () => Promise<T>, listener: BoundaryListener): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (listener.requests === 0 && ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) {
      await sleep(80);
      return await fn();
    }
    throw err;
  }
}

test('[LOCK] one resolution feeds policy AND socket (private opt-in still dials the answer)', async () => {
  const listener = await startListener();
  listener.enqueue({ kind: 'respond', status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
  let resolveCalls = 0;
  const fetcher = createPinnedFetch({
    allowPrivateNetworks: true,
    resolve: async () => {
      resolveCalls++;
      return ['127.0.0.1'];
    },
  });
  const res = await withLoopbackRetry(
    () => fetcher('http://svc.local.test:' + listener.port + '/ping', { method: 'GET' }),
    listener
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(resolveCalls).toBeGreaterThanOrEqual(1);
  expect(listener.requests).toBeGreaterThanOrEqual(1);
});

test('[LOCK] policy-ON name answering loopback is denied BEFORE connect (rebind shape)', async () => {
  const listener = await startListener();
  let resolveCalls = 0;
  const fetcher = createPinnedFetch({
    resolve: async () => {
      resolveCalls++;
      return ['127.0.0.1'];
    },
  });
  await expect(
    fetcher('http://svc.local.test:' + listener.port + '/steal', { method: 'GET' })
  ).rejects.toBeInstanceOf(DestinationDeniedError);
  expect(resolveCalls).toBe(1);
  expect(listener.requests).toBe(0);
});

test('[LOCK] exact IP-literal allowHosts opt-in dials without touching the resolver', async () => {
  const listener = await startListener();
  listener.enqueue({ kind: 'respond', status: 200, body: 'pong' });
  let resolveCalls = 0;
  const fetcher = createPinnedFetch({
    allowHosts: new Set(['127.0.0.1']),
    resolve: async () => {
      resolveCalls++;
      return [];
    },
  });
  const res = await withLoopbackRetry(() => fetcher(listener.url('/ok'), { method: 'GET' }), listener);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('pong');
  expect(resolveCalls).toBe(0);
});

test('[LOCK] abort signal destroys the request (caller cancel reaches the socket)', async () => {
  const listener = await startListener();
  listener.setDefault({ kind: 'hangForever' });
  const fetcher = createPinnedFetch({ allowPrivateNetworks: true });
  await withLoopbackRetry(async () => {
    const controller = new AbortController();
    const pending = fetcher('http://127.0.0.1:' + listener.port + '/never', { method: 'GET', signal: controller.signal });
    await waitFor(() => listener.requests >= 1, 300).catch(() => undefined);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted|AbortError|destroy/i);
    await waitFor(() => listener.closedWithoutFinish >= 1);
  }, listener);
});
// ---------- CYCLE-101 hardening ----------

test('[LOCK] buildDialOptions keeps TLS options on https ONLY (pitfall 5, structural)', () => {
  const base = { port: 443, hostNoPort: 'api.example.test', method: 'POST', path: '/x', headers: {} };
  const httpOpts = buildDialOptions({ ...base, isHttps: false, dialHost: '127.0.0.1', port: 80 });
  expect('servername' in httpOpts).toBe(false);
  expect('rejectUnauthorized' in httpOpts).toBe(false);
  const httpsOpts = buildDialOptions({ ...base, isHttps: true, dialHost: '203.0.113.10' });
  expect(httpsOpts.servername).toBe('api.example.test');
  expect(httpsOpts.rejectUnauthorized).toBe(true);
  expect(httpsOpts.host).toBe('203.0.113.10');
});

test('[LOCK] timeoutMs destroys the socket and rejects TimeoutError before headers', async () => {
  const listener = await startListener();
  listener.setDefault({ kind: 'hangForever' });
  const fetcher = createPinnedFetch({ allowPrivateNetworks: true, timeoutMs: 120 });
  const t0 = Date.now();
  await expect(
    fetcher('http://127.0.0.1:' + listener.port + '/never', { method: 'GET' })
  ).rejects.toThrow(/timeout|TimeoutError/i);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  expect(Date.now() - t0).toBeLessThan(2000);
  await waitFor(() => listener.closedWithoutFinish >= 1, 1000); // socket really released, not leaked
});

test('[LOCK] timeoutMs does not fire for a fast healthy response', async () => {
  const listener = await startListener();
  listener.enqueue({ kind: 'respond', status: 200, body: 'early' });
  const fetcher = createPinnedFetch({ allowHosts: new Set(['127.0.0.1']), timeoutMs: 5000 });
  const res = await withLoopbackRetry(() => fetcher(listener.url('/ok'), { method: 'GET' }), listener);
  expect(await res.text()).toBe('early');
});

test('[LOCK] resolver THROW is sanitized denial; connect never happened', async () => {
  const listener = await startListener();
  let resolveCalls = 0;
  const fetcher = createPinnedFetch({
    resolve: async () => {
      resolveCalls++;
      throw Object.assign(new Error('simulate dns outage'), { code: 'ENOTFOUND' });
    },
  });
  await expect(
    fetcher('http://svc.flaky.test:' + listener.port + '/x', { method: 'GET' })
  ).rejects.toBeInstanceOf(DestinationDeniedError);
  await expect(
    fetcher('http://svc.flaky.test:' + listener.port + '/x', { method: 'GET' })
  ).rejects.toThrow(/dns resolution failed \(ENOTFOUND\)/);
  expect(resolveCalls).toBe(2);
  expect(listener.requests).toBe(0);
  const nonList = createPinnedFetch({ resolve: (async () => ({ nope: true })) as never });
  await expect(nonList('http://svc.flaky.test:8080/x', { method: 'GET' })).rejects.toThrow(/non-list answer/);
});

test('[LOCK] FormData body serializes multipart OVER the pinned connection', async () => {
  const listener = await startListener();
  listener.enqueue({ kind: 'respond', status: 200, body: 'ok' });
  const fetcher = createPinnedFetch({ allowPrivateNetworks: true });
  const form = new FormData();
  form.set('prompt', 'read the invoice');
  form.set('options', JSON.stringify({ maxPages: 3 }));
  const res = await withLoopbackRetry(
    () => fetcher('http://127.0.0.1:' + listener.port + '/ocr', { method: 'POST', body: form }),
    listener
  );
  expect(res.status).toBe(200);
  await res.text();
  const rec = listener.recordedRequests[0];
  expect(rec).toBeDefined();
  expect((rec as { bodyBytes: number }).bodyBytes).toBeGreaterThan(0); // multipart payload crossed the pinned socket
});

test('[LOCK] unknown body shapes are REJECTED, never routed un-pinned (cycle-95 fence)', async () => {
  const listener = await startListener();
  const fetcher = createPinnedFetch({ allowPrivateNetworks: true });
  const exotic = { pipe: () => undefined } as unknown as ReadableStream;
  await expect(
    fetcher('http://127.0.0.1:' + listener.port + '/x', { method: 'POST', body: exotic })
  ).rejects.toThrow(/unsupported request body shape/);
  expect(listener.requests).toBe(0);
  const formWithBlob = new FormData();
  formWithBlob.set('file', new Blob(['raw']));
  await expect(
    fetcher('http://127.0.0.1:' + listener.port + '/y', { method: 'POST', body: formWithBlob })
  ).rejects.toThrow(/multipart Blob\/File parts are not supported/);
  // Rejection fires while SERIALIZING: headers may have flushed (opt-in target is a legal
  // connect), but the Blob payload never crosses the socket — fail-closed on content.
  expect(listener.recordedRequests.length).toBe(0);
});

