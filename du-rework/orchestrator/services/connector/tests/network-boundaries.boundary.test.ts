/**
 * R1-C offline boundary harness - services/connector (BR-Q3-01 grant, packet R1-C).
 *
 * Canonical rows pinned here:
 *  - FIX-CR-01 - SSRF / destination adjudication in validateProviderUrl and
 *    FetchProviderTransport (services/connector/src/adapters/transport.ts): a string-matching
 *    deny list, plus the hostname-allowlist early return that skips IP adjudication entirely.
 *  - FIX-CR-08 - bounded streamed body: the transport applies maxResponseBytes only AFTER
 *    buffering the whole arrayBuffer(), so a provider streaming 8 KiB against a 1 KiB cap is
 *    fully consumed before the rejection (FR24-10 sibling).
 *  - WR24-05 - IPv6 serialization variants that reach loopback/private space while evading the
 *    current filter (::ffff:7f00:1, ::ffff:127.0.0.1, 0:0:0:0:0:0:0:1, ::, 6to4 / NAT64 /
 *    Teredo, multicast, CGNAT 100.64/10, benchmarking 198.18/15, IETF 192.0.0/24).
 *  - FR24-07 - network boundary in front of egress. Only the CONNECTOR half lives here; the
 *    webhook/callback half of that row is
 *    services/orchestrator/tests/webhook-error-boundaries.boundary.test.ts.
 *
 * Plan location: du-rework/coordination/reports/qwen3.md -> section W49-Q3-2, sec.6.3 case
 * matrix (A = SSRF/DNS adjudication, B1 = bounded body). Shared kit (single source of truth for
 * the vector table, listeners and doubles): du-rework/tests/harness/network-boundaries/.
 *
 * Run (cwd du-rework/, Windows cmd):
 *   pnpm --dir services/connector exec jest tests/network-boundaries.boundary.test.ts --runInBand
 *
 * Offline contract: no PostgreSQL :5433, no Redis :6380, no system DNS (node:dns/promises is
 * scripted - an unscripted lookup throws), no socket outside 127.0.0.1, and never a
 * globalThis.fetch rewrite (only the production fetcher seam or this suite's loopback listener).
 *
 * Labels: [LOCK] = green now, a regression pin. [LOCK:<row>] = red on purpose until that row is
 * fixed; its assertions encode the TARGET behaviour and must never be weakened.
 */
import { gzipSync } from 'node:zlib';
import { FetchProviderTransport, validateProviderUrl } from '../src/adapters/transport';
import { createPinnedFetch } from '../src/adapters/pinned-fetch';
import type { ProviderRequest } from '../src/types';
import {
  ALLOW_VECTORS,
  DENY_VECTORS,
  canonicalIpLiteral,
  urlForVector,
  type IpPolicyVector,
} from '../../../../tests/harness/network-boundaries/policy-vectors';
import {
  isIpLiteralHost,
  makeRecordingFetcher,
} from '../../../../tests/harness/network-boundaries/recording-transport';
import { DnsScript } from '../../../../tests/harness/network-boundaries/fake-resolver';
import { BoundaryListener } from '../../../../tests/harness/network-boundaries/mock-listener';
import {
  installRejectionGuard,
  type RejectionGuard,
} from '../../../../tests/harness/network-boundaries/unhandled-guard';

/**
 * Scripted resolver for the whole file (harness rule: a real DNS query in a boundary suite is
 * itself a finding). ts-jest hoists jest.mock above the imports, while the factory body only
 * builds a closure, so mockDns is initialized before any lookup call lands.
 */
const mockDns = new DnsScript();

jest.mock('node:dns/promises', () => ({
  lookup: (hostnameOrAddress: unknown, options?: unknown): Promise<unknown> =>
    mockDns.lookup(hostnameOrAddress, options),
}));

const listeners: BoundaryListener[] = [];
let guard: RejectionGuard | undefined;

/**
 * Windows loopback + undici keep-alive pool artifact: when a previous
 * listener stopped, its ephemeral port can be recycled to a new listener
 * immediately, and the first fetch may then be handed a dead pooled socket
 * (PROVIDER_UNAVAILABLE while listener.requests === 0). The FIX-CR-08
 * stream case above already documents and absorbs exactly one retry of
 * that shape; this helper applies the same refusal-only retry to the other
 * real-connect cases. Anything the listener actually witnessed is asserted
 * as-is - a refusal it saw still throws.
 */
async function sendRetryingPoolArtifact(
  transport: FetchProviderTransport,
  request: ProviderRequest,
  listener: BoundaryListener,
): Promise<Awaited<ReturnType<FetchProviderTransport['send']>>> {
  try {
    return await transport.send(request);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'PROVIDER_UNAVAILABLE' && listener.requests === 0) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return transport.send(request);
    }
    throw err;
  }
}

beforeAll(() => {
  guard = installRejectionGuard();
});

afterAll(async () => {
  for (const listener of listeners) {
    await listener.stop();
  }
  const leaked = listeners.filter((listener) => listener.openSockets !== 0);
  expect(leaked.map((listener) => listener.port)).toEqual([]);
  guard?.assertClean('network-boundaries.boundary.test.ts');
  guard?.restore();
});

/** Every recording-transport case targets TEST-NET-1: public by policy, never connected. */
const PUBLIC_URL = 'http://192.0.2.53:8080/v1/submit';

function providerRequest(url: string): ProviderRequest {
  return { url, method: 'POST', headers: {}, body: '{}' };
}

function v6Vector(input: string): IpPolicyVector {
  return { input, expect: 'DENY', why: 'canonical probe', ipFamily: 6, row: 'FIX-CR-01', origin: 'A.2' };
}

/* ------------------------------------------------------------------ *
 * A - SSRF / DNS adjudication                                        *
 * ------------------------------------------------------------------ */

test('[LOCK] A-lock-1 redirect refusal', async () => {
  for (const status of [301, 302, 307, 308]) {
    const rec = makeRecordingFetcher(
      () => new Response('x', { status, headers: { location: 'http://192.0.2.53/' } }),
    );
    const transport = new FetchProviderTransport({ fetcher: rec.fetcher });
    await expect(transport.send(providerRequest(PUBLIC_URL))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(rec.calls).toHaveLength(1);
    // The refusal must be structural (nothing to follow), not only a status check.
    expect(rec.calls[0]?.redirect).toBe('manual');
  }
});

test('[LOCK] A-lock-2 scheme/userinfo refusal', async () => {
  const rejected: readonly string[] = [
    'file:///etc/passwd',
    'gopher://127.0.0.1:1111/x',
    'data:text/plain,http://127.0.0.1',
    'http://user:pass@api.example',
    'HTTP://USER:PASS@169.254.169.254',
  ];
  for (const value of rejected) {
    await expect(validateProviderUrl(value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
});

for (const vector of DENY_VECTORS) {
  const label =
    vector.origin === 'A.2'
      ? `[LOCK:FIX-CR-01 vector ${vector.input}]`
      : `[LOCK:FIX-CR-01 ${vector.input}]`;
  test(`${label} ${vector.why}`, async () => {
    const url = urlForVector(vector);
    const host = new URL(url).hostname;
    // Harness contract, not a policy claim: IP-literal hosts short-circuit isIP() and never
    // reach the resolver, which is what makes this whole table offline-safe.
    expect(isIpLiteralHost(host)).toBe(true);
    const lookupsBefore = mockDns.calls;
    await expect(validateProviderUrl(url)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mockDns.calls).toBe(lookupsBefore);
  });
}

for (const vector of ALLOW_VECTORS) {
  test(`[LOCK] control ${vector.input} must stay ALLOW (${vector.why})`, async () => {
    const url = urlForVector(vector);
    const host = new URL(url).hostname;
    expect(isIpLiteralHost(host)).toBe(true);
    const lookupsBefore = mockDns.calls;
    await expect(validateProviderUrl(url)).resolves.toBeInstanceOf(URL);
    expect(mockDns.calls).toBe(lookupsBefore);
  });
}

test('[LOCK] canonical probe (records Node URL IPv6 serialization)', () => {
  const probeInputs: readonly string[] = [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:0:0:1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
    'fd12:3456::1',
  ];
  const canonical: string[] = [];
  for (const input of probeInputs) {
    const once = canonicalIpLiteral(v6Vector(input));
    const twice = canonicalIpLiteral(v6Vector(once));
    // Evidence line for the fix: what a byte-normalized policy must collapse each variant to.
    console.log(`CANONICAL ${input} -> ${once}`);
    canonical.push(once);
    expect(twice).toBe(once);
    expect(once.startsWith('[')).toBe(false);
  }
  // Both loopback spellings collapse to one canonical string, and the uncompressed form to ::1.
  expect(canonical[0]).toBe(canonical[1]);
  expect(canonical[2]).toBe('::1');
});

test('[LOCK:FIX-CR-01 allowlist-must-not-bypass-ip-adjudication]', async () => {
  mockDns.reset();
  mockDns.enqueue('127.0.0.1');
  // A hostname allowlist may widen which names are considered, never skip the question of
  // where they resolve. Today validateProviderUrl returns before the lookup: RED.
  await expect(
    validateProviderUrl('http://svc.internal.test:8080', {
      allowHosts: new Set(['svc.internal.test']),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(mockDns.calls).toBe(1);
});

test('[LOCK] production-defaults (no silent allowPrivateNetworks)', async () => {
  const transport = new FetchProviderTransport({});
  await expect(transport.send(providerRequest('http://127.0.0.1:8080'))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
});

test('[LOCK] allowPrivateNetworks follows shared IP policy and still adjudicates DNS answers', async () => {
  await expect(validateProviderUrl('http://127.0.0.1:8080', {
    allowPrivateNetworks: true,
  })).resolves.toBeInstanceOf(URL);
  await expect(validateProviderUrl('http://169.254.169.254:8080', {
    allowPrivateNetworks: true,
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  mockDns.reset();
  mockDns.enqueue('10.0.0.5', '192.0.2.5');
  await expect(validateProviderUrl('http://private-provider.internal.test:8080', {
    allowPrivateNetworks: true,
  })).resolves.toBeInstanceOf(URL);
  expect(mockDns.calls).toBe(1);

  mockDns.enqueue('10.0.0.5');
  await expect(validateProviderUrl('http://private-provider.internal.test:8080'))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(mockDns.calls).toBe(2);

  mockDns.enqueue('169.254.169.254');
  await expect(validateProviderUrl('http://metadata.internal.test:8080', {
    allowPrivateNetworks: true,
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(mockDns.calls).toBe(3);
});

test('[LOCK] pinned egress keeps link-local metadata blocked under private-network opt-in', async () => {
  const pinnedFetch = createPinnedFetch({
    allowPrivateNetworks: true,
    resolve: async () => ['169.254.169.254'],
  });

  await expect(pinnedFetch('http://metadata.internal.test:8080/'))
    .rejects.toThrow('not routable');
});

test('[LOCK] mixed-DNS-answer denial + public-only allow (false-deny guard)', async () => {
  mockDns.reset();
  mockDns.enqueue('192.0.2.5', '127.0.0.1');
  await expect(validateProviderUrl('http://mixed.internal.test:8080')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  mockDns.enqueue('192.0.2.5');
  await expect(validateProviderUrl('http://mixed.internal.test:8080')).resolves.toBeInstanceOf(URL);
  // Scripted answers only: DnsScript throws on an unscripted lookup, so this count proves the
  // policy consulted the resolver instead of quietly reaching the system one.
  expect(mockDns.calls).toBeGreaterThanOrEqual(2);
});

/* ------------------------------------------------------------------ *
 * B1 - bounded response body                                         *
 * ------------------------------------------------------------------ */

/**
 * A body source that only yields a pull when something actually reads it. highWaterMark 0 is
 * required for the measurement to mean anything: with the default HWM 1, the WHATWG stream
 * machinery fills the queue as soon as the Response constructor locks the stream, so the
 * counter reads 1 even though the transport never asked for a byte (measured on Node 22).
 */
function countingStream(counter: { pulled: number }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counter.pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (counter.pulled >= 2) {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

test('[LOCK] B1-lock content-Length precheck', async () => {
  const counter = { pulled: 0 };
  const rec = makeRecordingFetcher(
    () => new Response(countingStream(counter), { status: 200, headers: { 'content-length': '8192' } }),
  );
  const transport = new FetchProviderTransport({ fetcher: rec.fetcher, maxResponseBytes: 1024 });
  await expect(transport.send(providerRequest(PUBLIC_URL))).rejects.toMatchObject({
    code: 'INVALID_PROVIDER_RESPONSE',
  });
  expect(rec.calls).toHaveLength(1);
  // The declared header alone must be enough: the body is never pulled.
  expect(counter.pulled).toBe(0);

  // Instrument liveness / false-green guard: a lying content-length (512 declared, 2048
  // streamed) does reach the body, and the counter moves when it is read.
  const readCounter = { pulled: 0 };
  const lyingRec = makeRecordingFetcher(
    () => new Response(countingStream(readCounter), { status: 200, headers: { 'content-length': '512' } }),
  );
  const readingTransport = new FetchProviderTransport({
    fetcher: lyingRec.fetcher,
    maxResponseBytes: 1024,
  });
  await expect(readingTransport.send(providerRequest(PUBLIC_URL))).rejects.toMatchObject({
    code: 'INVALID_PROVIDER_RESPONSE',
  });
  expect(readCounter.pulled).toBeGreaterThan(0);
});

test('[LOCK:FIX-CR-08 early-cap-before-full-buffer]', async () => {
  const listener = await BoundaryListener.start();
  listeners.push(listener);
  // Paced witness (chunkDelayMs) — unpaced, an 8 KiB body is fully absorbed by kernel
  // buffers and bytesWritten reports 8192 even with a perfect client-side cancel (measured
  // 2026-09-25; same confound documented in the worker-sdk suite). Pacing gives the cancel
  // time to surface as a write error, which is what the early-cap assertion measures.
  listener.enqueue({ kind: 'chunkedNoLength', chunkBytes: 512, totalBytes: 8192, chunkDelayMs: 15, then: 'end' });
  // Real wire path: production default fetch against this suite's own loopback listener.
  // The EXACT literal in allowHosts is the documented local-test opt-in that lets the socket
  // open at all (post-FIX-CR-01 semantics); the cap behaviour under test is the assertion.
  const streamUrl = listener.url('/v1/stream');
  const transport = new FetchProviderTransport({
    maxResponseBytes: 1024,
    allowHosts: ['127.0.0.1'],
  });
  // Guard (kit README pitfall 1): in a shared-process full run, undici's keep-alive pool
  // can hand a dead socket from a previous listener that used this port; a refusal the
  // listener never witnessed is a pool artifact, not production behavior. Retry exactly
  // that shape once; anything the listener saw is asserted as-is.
  const attempt = async (): Promise<string> => {
    try {
      await transport.send(providerRequest(streamUrl));
      return 'resolved';
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    }
  };
  let code = await attempt();
  if (code === 'PROVIDER_UNAVAILABLE' && listener.requests === 0) {
    await new Promise((r) => setTimeout(r, 60));
    code = await attempt();
  }
  expect(code).toBe('INVALID_PROVIDER_RESPONSE');
  expect(listener.requests).toBeGreaterThanOrEqual(1);
  // FIX-CR-08: reading stops at the cap plus at most 4 in-flight/buffered chunks, not after
  // all 8192 bytes are consumed. Pre-fix this witnessed the full 8192; post-fix it stops near
  // the cap while the cancel propagates (measured ~1536 on Node 22/loopback).
  expect(listener.bytesWritten).toBeLessThanOrEqual(1024 + 4 * 512);
});

// ---------- PR-Q3-03 (turn 3): DNS pinning at connect — the rebinding TOCTOU half ----------

test('[LOCK:FIX-CR-01 rebinding-after-adjudication-must-deny-at-connect]', async () => {
  const listener = await BoundaryListener.start();
  listeners.push(listener);
  // validateProviderUrl resolves the name PUBLIC (mockDns below); the CONNECT-time
  // resolver (pinned-fetch seam) answers the loopback listener instead — a classic
  // rebinding TOCTOU. A pinned transport shares the adjudicated answer with the socket,
  // so the second answer must never reach connect.
  mockDns.enqueue('192.0.2.5');
  let connectResolutions = 0;
  const transport = new FetchProviderTransport({
    maxResponseBytes: 1024,
    resolve: async () => {
      connectResolutions++;
      return ['127.0.0.1'];
    },
  });
  const url = `http://flip.rebind.test:${listener.port}/v1/steal`;
  await expect(transport.send(providerRequest(url))).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE',
  });
  expect(listener.requests).toBe(0);
  expect(connectResolutions).toBeLessThanOrEqual(1);
});

test('[LOCK:FIX-CR-01 pinned-path-serves-normal-provider-traffic]', async () => {
  const listener = await BoundaryListener.start();
  listeners.push(listener);
  listener.enqueue({
    kind: 'respond',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, echo: 'pinned-wire' }),
  });
  // Default fetcher is now the pinned one: IP-literal target via exact allowHosts opt-in.
  const transport = new FetchProviderTransport({ maxResponseBytes: 10240, allowHosts: ['127.0.0.1'] });
  const res = await sendRetryingPoolArtifact(transport, providerRequest(listener.url('/v1/provider')), listener);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, echo: 'pinned-wire' });
  expect(listener.requests).toBe(1);
});

test('[LOCK] private-network opt-in permits loopback through validation and pinned connect', async () => {
  const listener = await BoundaryListener.start();
  listeners.push(listener);
  listener.enqueue({ kind: 'respond', status: 200, body: 'local-test' });
  const transport = new FetchProviderTransport({ allowPrivateNetworks: true });

  await expect(sendRetryingPoolArtifact(transport, providerRequest(listener.url('/v1/local-test')), listener))
    .resolves.toMatchObject({ status: 200, body: 'local-test' });
  expect(listener.requests).toBe(1);
});

test('[LOCK:FIX-CR-08 pinned-decodes-gzip-AND-caps-on-decoded-bytes]', async () => {
  const listener = await BoundaryListener.start();
  listeners.push(listener);
  // 16 KiB of DECODED JSON behind ~small gzip: a cap measured on encoded bytes would
  // happily pass a zip-bomb through; undici decompressed before the old post-buffer cap,
  // so the pinned fetch must decompress (provider parity) AND cap the DECODED stream.
  const big = JSON.stringify({ payload: 'A'.repeat(16 * 1024) });
  const gz = gzipSync(Buffer.from(big, 'utf8'));
  listener.enqueue({
    kind: 'respond',
    status: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength),
  });
  const transport = new FetchProviderTransport({ maxResponseBytes: 1024, allowHosts: ['127.0.0.1'] });
  await expect(sendRetryingPoolArtifact(transport, providerRequest(listener.url('/v1/bomb')), listener)).rejects.toMatchObject({
    code: 'INVALID_PROVIDER_RESPONSE',
  });
  expect(listener.requests).toBe(1);
});
