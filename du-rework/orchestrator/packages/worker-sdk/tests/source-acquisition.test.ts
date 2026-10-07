import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinnedFetch } from '@du/egress';
import { acquireSourceUrl, SourceAcquisitionError } from '../src/source-acquisition';
import { createTempWorkspace } from '../src/artifact-streams';
import type { TempWorkspace } from '../src/artifact-streams';
import type { SdkFetcher } from '../src/fan-out';
import { BoundaryListener } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * DATA-03 (packet W-DATA03-ACQ-1): offline suite for the bounded URL
 * acquisition primitive. Three evidence layers:
 *
 * 1. POLICY layer (injected fetcher, zero sockets): scheme allowlist,
 *    userinfo refusal, hop bound + per-hop revalidation, byte/hash/size
 *    budgets, sanitized rejection text, fail-closed file removal.
 * 2. DEFAULT-EGRESS layer (no sockets at all): the default fetcher is the
 *    shared pinned egress, so loopback/metadata/RFC1918/IPv6-ULA/decimal
 *    literals and a hostname whose DNS answer is loopback are DENIED BEFORE
 *    CONNECT — the injected fetcher is never consulted, proving the wiring,
 *    not just the policy text.
 * 3. END-TO-END layer (127.0.0.1 listeners on port 0, the only allowed
 *    network): real pinned fetch with the narrow local-mesh opt-in drives
 *    happy path, redirect hop, mid-stream cap, idle stall, hang, reset.
 *
 * Boundary rules (kit README, same discipline as
 * network-boundaries.boundary.test.ts): offline only; globalThis.fetch is
 * NEVER monkeypatched — production HTTP enters only through the declared
 * fetcher seam; listeners are the oracle. Imports go straight at
 * '../src/...' modules (the sibling suite's barrel-health note applies).
 */

const doc = Buffer.from('DATA-03 acquisition fixture - repeated payload.\n'.repeat(64), 'utf8');
const docSha = createHash('sha256').update(doc).digest('hex');

interface FetchCall {
  url: string;
}

/** Scripted fetcher: each entry answers the next call; records EVERY call. */
type ScriptedBody = Uint8Array | string | null;
function scripted(
  responses: Array<{ status?: number; body?: ScriptedBody; headers?: Record<string, string> } | Error>
): { fetcher: SdkFetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetcher: SdkFetcher = async (input) => {
    const url = String(input);
    calls.push({ url });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error('scripted fetcher exhausted at call ' + index + ' (' + url + ')');
    if (next instanceof Error) throw next;
    return new Response(next.body ?? null, {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  };
  return { fetcher, calls };
}

function responseFor(body: Uint8Array, extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream', ...extra };
}

let testRoot: string;
const workspaces: TempWorkspace[] = [];
const listeners: BoundaryListener[] = [];

async function makeWorkspace(): Promise<TempWorkspace> {
  const ws = await createTempWorkspace(randomUUID(), { rootDir: testRoot });
  workspaces.push(ws);
  return ws;
}

/**
 * CYCLE-102 lesson (harness/listen-loopback.ts): port-0 binding on this host
 * intermittently yields connect-ETIMEDOUT on 127.0.0.1 — LISTEN succeeds but
 * Windows filters fresh ephemeral ports. Bind in a quiet band with a pid
 * offset; BoundaryListener.start(port) retries EADDRINUSE via listenLoopback
 * (same convention as the orchestrator webhook boundary suite).
 */
const QUIET_PORT_BASE = 46_400 + (process.pid % 8) * 16;
let portOffset = 0;
async function startListener(): Promise<BoundaryListener> {
  const listener = await BoundaryListener.start(QUIET_PORT_BASE + portOffset++);
  listeners.push(listener);
  return listener;
}

async function expectWorkspaceEmpty(ws: TempWorkspace): Promise<void> {
  const walk = async (dir: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else found.push(full);
    }
    return found;
  };
  expect(await walk(ws.dir)).toEqual([]);
}

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'du-acq-'));
});

afterAll(async () => {
  for (const listener of listeners) await listener.stop().catch(() => undefined);
  for (const ws of workspaces) await ws.dispose().catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
});

describe('acquisition policy (injected fetcher, no sockets)', () => {
  test('WIN: https happy path streams verified bytes into the workspace file', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ body: doc, headers: responseFor(doc) }]);
    const got = await acquireSourceUrl(ws, 'src.bin', 'https://source.example/doc.bin', {
      maxBytes: 1_000_000,
      expectedSha256: docSha,
      expectedSizeBytes: doc.byteLength,
      fetcher,
    });
    expect(got).toMatchObject({ sizeBytes: doc.byteLength, sha256: docSha, hops: 0 });
    expect(existsSync(got.path)).toBe(true);
    expect(createHash('sha256').update(readFileSync(got.path)).digest('hex')).toBe(docSha);
  });

  test('LOSER->HASH_MISMATCH: expected digest that does not match removes the partial file', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ body: doc, headers: responseFor(doc) }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', {
        maxBytes: 1_000_000,
        expectedSha256: 'f'.repeat(64),
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH', status: 422 });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->SIZE_MISMATCH: streamed count differs from the expected size', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ body: doc, headers: responseFor(doc) }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', {
        maxBytes: 1_000_000,
        expectedSizeBytes: doc.byteLength + 1,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->TOO_LARGE before any write: declared Content-Length above maxBytes', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ body: doc, headers: responseFor(doc) }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: doc.byteLength - 1, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->TOO_LARGE mid-stream: body larger than the cap without a length header', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ body: Buffer.alloc(4096, 0x61), headers: {} }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 2048, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->INVALID argument: non-integer maxBytes never reaches the network', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 1.5, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(calls).toHaveLength(0);
  });

  test('LOSER->INVALID file name: traversal refused before any fetch', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([]);
    await expect(
      acquireSourceUrl(ws, '../escape', 'https://source.example/x', { maxBytes: 10, fetcher })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('LOSER->SCHEME_NOT_ALLOWED: http refused by default, fetcher untouched', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'http://source.example/x', { maxBytes: 10, fetcher })
    ).rejects.toMatchObject({ code: 'SCHEME_NOT_ALLOWED' });
    expect(calls).toHaveLength(0);
  });

  test('allowHttp opts plain http in (approved-scheme seam)', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([{ body: doc, headers: responseFor(doc) }]);
    const got = await acquireSourceUrl(ws, 'src.bin', 'http://source.example/x', {
      maxBytes: 1_000_000,
      allowHttp: true,
      fetcher,
    });
    expect(got.sizeBytes).toBe(doc.byteLength);
    expect(calls).toHaveLength(1);
  });

  test.each(['file:///etc/passwd', 'gopher://x/y', 'data:text/plain,hi'])('LOSER-> scheme refused for %p', async (url) => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([]);
    await expect(acquireSourceUrl(ws, 'src.bin', url, { maxBytes: 10, fetcher })).rejects.toMatchObject({
      code: 'SCHEME_NOT_ALLOWED',
    });
    expect(calls).toHaveLength(0);
  });

  test('LOSER->INVALID_URL: userinfo forms refused (FIX-CR-01 vector class)', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://admin:p4ss@source.example/x', { maxBytes: 10, fetcher })
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(calls).toHaveLength(0);
  });

  test('LOSER->INVALID_URL: unparseable input', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([]);
    await expect(acquireSourceUrl(ws, 'src.bin', 'not a url', { maxBytes: 10, fetcher })).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
  });

  test('WIN: redirect hop followed within bound (relative Location resolves against current)', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([
      { status: 302, headers: { location: '/moved.bin' }, body: null },
      { body: doc, headers: responseFor(doc) },
    ]);
    const got = await acquireSourceUrl(ws, 'src.bin', 'https://source.example/doc.bin', {
      maxBytes: 1_000_000,
      fetcher,
    });
    expect(got.hops).toBe(1);
    expect(got.sha256).toBe(docSha);
    expect(calls.map((c) => c.url)).toEqual(['https://source.example/doc.bin', 'https://source.example/moved.bin']);
  });

  test('LOSER->REDIRECT_LIMIT: more hops than the caller bound', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([
      { status: 302, headers: { location: 'https://source.example/a' }, body: null },
      { status: 302, headers: { location: 'https://source.example/b' }, body: null },
      { status: 302, headers: { location: 'https://source.example/c' }, body: null },
      { status: 302, headers: { location: 'https://source.example/d' }, body: null },
    ]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/start', { maxBytes: 10, maxRedirects: 2, fetcher })
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
    expect(calls).toHaveLength(3);
  });

  test('LOSER->REDIRECT_LIMIT: maxRedirects=0 refuses any redirect', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ status: 302, headers: { location: 'https://other.example/x' }, body: null }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 10, maxRedirects: 0, fetcher })
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
  });

  test('LOSER-> hop revalidation: redirect into file: refused, second call never happens', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([
      { status: 302, headers: { location: 'file:///etc/passwd' }, body: null },
      { body: doc, headers: responseFor(doc) },
    ]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 100, fetcher })
    ).rejects.toMatchObject({ code: 'SCHEME_NOT_ALLOWED' });
    expect(calls).toHaveLength(1);
  });

  test('LOSER-> hop revalidation: redirect into userinfo refused', async () => {
    const ws = await makeWorkspace();
    const { fetcher, calls } = scripted([{ status: 302, headers: { location: 'https://u:p@evil.example/x' }, body: null }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 100, fetcher })
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(calls).toHaveLength(1);
  });

  test('LOSER->SOURCE_REJECTED: 3xx without a usable Location', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ status: 302, headers: {}, body: null }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 10, fetcher })
    ).rejects.toMatchObject({ code: 'SOURCE_REJECTED', status: 302 });
  });

  test('LOSER->SOURCE_REJECTED: upstream error body text NEVER travels into the error', async () => {
    const ws = await makeWorkspace();
    const leaky = Buffer.from(JSON.stringify({ detail: 'SENTINEL-UPSTREAM-TEXT' }), 'utf8');
    const { fetcher } = scripted([{ status: 404, body: leaky, headers: { 'content-type': 'application/json' } }]);
    const err = await acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 10, fetcher }).catch(
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'SOURCE_REJECTED', status: 404 });
    expect(String((err as Error).message)).not.toMatch(/SENTINEL-UPSTREAM-TEXT/);
  });

  test('LOSER->EMPTY_BODY: response with no body', async () => {
    const ws = await makeWorkspace();
    const { fetcher } = scripted([{ status: 200, body: null, headers: {} }]);
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 10, fetcher })
    ).rejects.toMatchObject({ code: 'EMPTY_BODY' });
  });

  test('LOSER->TRANSPORT_FAILURE: fetcher crash reports class name only', async () => {
    const ws = await makeWorkspace();
    const crash = Object.assign(new TypeError('connect ECONNREFUSED dsn://secret'), { name: 'TypeError' });
    const { fetcher } = scripted([crash]);
    const err = await acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', { maxBytes: 10, fetcher }).catch(
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'TRANSPORT_FAILURE' });
    expect(String((err as Error).message)).not.toMatch(/dsn:\/\/secret/);
  });

  test('LOSER->caller abort: aborted signal ends acquisition', async () => {
    const ws = await makeWorkspace();
    const controller = new AbortController();
    controller.abort();
    const aborting: SdkFetcher = async (_input, init) => {
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return new Response(null);
    };
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://source.example/x', {
        maxBytes: 10,
        fetcher: aborting,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE' });
    await expectWorkspaceEmpty(ws);
  });
});

describe('acquisition SSRF fence via default pinned egress (deny before connect)', () => {
  test.each([
    ['loopback IPv4', 'https://127.0.0.1:59999/doc'],
    ['decimal-encoded loopback', 'https://2130706433/doc'],
    ['cloud metadata link-local', 'https://169.254.169.254/latest/meta-data/'],
    ['RFC1918', 'https://10.0.0.5/doc'],
    ['IPv6 loopback', 'https://[::1]:59999/doc'],
    ['IPv6 ULA', 'https://[fd00::dead:beef]/doc'],
    ['CGNAT placement', 'https://100.64.1.1/doc'],
  ])('LOSER-> %s refused as DESTINATION_DENIED', async (_label, url) => {
    const ws = await makeWorkspace();
    // NO fetcher injected: this exercises the production default wiring.
    await expect(acquireSourceUrl(ws, 'src.bin', url, { maxBytes: 10 })).rejects.toMatchObject({
      code: 'DESTINATION_DENIED',
    });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER-> hostname whose DNS answer is loopback is denied (rebinding shape, resolver seam)', async () => {
    const ws = await makeWorkspace();
    const pinned = createPinnedFetch({ resolve: async () => ['127.0.0.1'] });
    await expect(
      acquireSourceUrl(ws, 'src.bin', 'https://rebind.example/doc', { maxBytes: 10, fetcher: pinned })
    ).rejects.toMatchObject({ code: 'DESTINATION_DENIED' });
  });

  test('LOSER-> redirect hop into metadata denied by the pinned egress itself', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    // allowPrivateNetworks:true opts loopback IN, so the always-denied hop
    // target is the metadata address (the opt-in never covers it).
    listener.enqueue({ kind: 'redirect', location: 'https://169.254.169.254/latest/meta-data/' });
    const pinned = createPinnedFetch({ allowPrivateNetworks: true });
    const err = await acquireSourceUrl(ws, 'src.bin', listener.url('/start'), {
      maxBytes: 1000,
      fetcher: pinned,
      allowHttp: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceAcquisitionError);
    // Egress denies the blocked hop by rejecting with DestinationDeniedError,
    // but it also destroys the socket from that same handler — which can win
    // the race and surface as ECONNRESET. Either way the acquisition FAILS
    // CLOSED; the pre-connect deny itself is pinned at the egress layer
    // (egress-ssrf-redirect-matrix.boundary.test.ts). Here we assert the
    // primitive-level invariant: failure + nothing past the first request.
    expect((err as SourceAcquisitionError).code).toMatch(/^(DESTINATION_DENIED|TRANSPORT_FAILURE)$/);
    expect(String((err as Error).message)).not.toMatch(/169\.254|SECRET/);
    // The listener saw the FIRST request only; the denied hop was never a
    // second successful exchange through this door.
    expect(listener.requests).toBe(1);
  });
});

describe('acquisition end-to-end over pinned egress + loopback listener', () => {
  const localPinned = (): SdkFetcher => createPinnedFetch({ allowPrivateNetworks: true });

  test('WIN: full download streams with correct hash and one request', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    listener.setDefault({ kind: 'respond', body: doc });
    const got = await acquireSourceUrl(ws, 'src.bin', listener.url('/doc.bin'), {
      maxBytes: 1_000_000,
      expectedSha256: docSha,
      fetcher: localPinned(),
      allowHttp: true,
    });
    expect(got).toMatchObject({ sizeBytes: doc.byteLength, sha256: docSha, hops: 0 });
    expect(listener.requests).toBe(1);
  });

  test('WIN: real 3xx hop followed via the pinned socket path', async () => {
    const ws = await makeWorkspace();
    const target = await startListener();
    target.setDefault({ kind: 'respond', body: doc });
    const redirector = await startListener();
    redirector.setDefault({ kind: 'redirect', location: target.url('/final.bin') });
    const got = await acquireSourceUrl(ws, 'src.bin', redirector.url('/start'), {
      maxBytes: 1_000_000,
      maxRedirects: 1,
      fetcher: localPinned(),
      allowHttp: true,
    });
    expect(got.hops).toBe(1);
    expect(got.sha256).toBe(docSha);
    expect(redirector.requests).toBe(1);
    expect(target.requests).toBe(1);
  });

  test('LOSER->TOO_LARGE mid-stream: cap tears the wire down early', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    listener.setDefault({ kind: 'chunkedNoLength', chunkBytes: 1024, totalBytes: 64 * 1024, chunkDelayMs: 1 });
    await expect(
      acquireSourceUrl(ws, 'src.bin', listener.url('/huge'), {
        maxBytes: 8 * 1024,
        fetcher: localPinned(),
        allowHttp: true,
      })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(listener.bytesWritten).toBeLessThan(64 * 1024);
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->IDLE_TIMEOUT: headers then silence past idleTimeoutMs', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    listener.setDefault({ kind: 'stallAfterHeaders' });
    await expect(
      acquireSourceUrl(ws, 'src.bin', listener.url('/stall'), {
        maxBytes: 1_000_000,
        idleTimeoutMs: 100,
        timeoutMs: 5_000,
        fetcher: localPinned(),
        allowHttp: true,
      })
    ).rejects.toMatchObject({ code: 'IDLE_TIMEOUT' });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->TIMEOUT: a request that never answers headers dies on the whole deadline', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    listener.setDefault({ kind: 'hangForever' });
    await expect(
      acquireSourceUrl(ws, 'src.bin', listener.url('/hang'), {
        maxBytes: 1_000_000,
        timeoutMs: 150,
        fetcher: localPinned(),
        allowHttp: true,
      })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expectWorkspaceEmpty(ws);
  });

  test('LOSER->TRANSPORT_FAILURE: server resets the body mid-stream', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    listener.setDefault({ kind: 'resetMidBody', bytesBeforeReset: 4096, chunkBytes: 1024 });
    await expect(
      acquireSourceUrl(ws, 'src.bin', listener.url('/reset'), {
        maxBytes: 1_000_000,
        fetcher: localPinned(),
        allowHttp: true,
      })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE' });
    await expectWorkspaceEmpty(ws);
  });

  test('error text never carries the fetched URL (query tokens must not ride logs)', async () => {
    const ws = await makeWorkspace();
    const listener = await startListener();
    listener.setDefault({ kind: 'respond', status: 403, body: 'nope' });
    const err = await acquireSourceUrl(ws, 'src.bin', listener.url('/doc?grant=SECRET-TOKEN'), {
      maxBytes: 100,
      fetcher: localPinned(),
      allowHttp: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceAcquisitionError);
    expect(String((err as Error).message)).not.toMatch(/SECRET-TOKEN/);
  });
});
