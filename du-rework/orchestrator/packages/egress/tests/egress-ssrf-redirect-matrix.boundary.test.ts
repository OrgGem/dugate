import { createPinnedFetch, DestinationDeniedError } from '../src/pinned-fetch';
import { BoundaryListener } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * CYCLE-103 SSRF redirect-hop boundary for createPinnedFetch.
 *
 * Threat model: the FIRST hop is a legitimately-allowed destination (exact IP-literal
 * allowHosts opt-in — the same narrow local-mesh convention the connector uses). Its
 * 3xx response points at private / loopback / link-local / metadata space. Egress must:
 *   (a) NEVER follow the redirect (no second dial anywhere — witness: hopB.requests === 0),
 *   (b) DESTROY the hop and throw DestinationDeniedError instead of returning the 3xx to
 *       the caller (a returned internal-Location 3xx is a follow-vector for upper layers),
 *   (c) still PASS THROUGH a public 3xx untouched (the caller's own redirect policy decides).
 * Every denied case additionally asserts listenerA sees AT MOST its one legitimate request —
 * denial happens after headers, before any body/follow.
 *
 * Run: pnpm --dir packages/egress exec jest tests/egress-ssrf-redirect-matrix.boundary.test.ts --runInBand
 */

const listeners: BoundaryListener[] = [];
async function start(): Promise<BoundaryListener> {
  const l = await BoundaryListener.start();
  listeners.push(l);
  return l;
}

afterAll(async () => {
  while (listeners.length > 0) {
    const l = listeners.pop();
    if (l) await l.stop().catch(() => undefined);
  }
});

const HOP_DENY: ReadonlyArray<{ readonly status: number; readonly label: string; readonly target: string }> = [
  { status: 301, label: 'RFC1918 10/8', target: 'http://10.0.0.1/steal' },
  { status: 302, label: 'cloud metadata', target: 'http://169.254.169.254/latest/meta-data/' },
  { status: 307, label: 'IPv6 loopback', target: 'http://[::1]/steal' },
  { status: 308, label: 'ULA fc00::/7', target: 'http://[fd12:3456::9]/steal' },
  { status: 302, label: 'IPv4 loopback outside the allowlist', target: 'http://127.9.9.9/steal' },
  { status: 302, label: 'link-local', target: 'http://169.254.7.7/x' },
];

for (const hop of HOP_DENY) {
  it('[LOCK] ' + hop.status + ' hop to ' + hop.label + ' (' + hop.target + ') denied, never followed', async () => {
    const listenerA = await start();
    listenerA.enqueue({ kind: 'redirect', status: hop.status, location: hop.target });
    const fetcher = createPinnedFetch({ allowHosts: new Set(['127.0.0.1']) });
    const err = await fetcher(listenerA.url('/entry'), { method: 'GET' }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DestinationDeniedError);
    expect(String((err as Error).message)).toMatch(/redirect hop/);
    expect(listenerA.requests).toBe(1); // only the legitimate first hop — no body, no re-dial
  });
}

it('[LOCK] hostname Location resolving to loopback is denied (hop re-adjudicated via resolver seam)', async () => {
  const listenerA = await start();
  listenerA.enqueue({ kind: 'redirect', status: 302, location: 'http://evil.internal.test/steal' });
  let hopResolutions = 0;
  const fetcher = createPinnedFetch({
    allowHosts: new Set(['127.0.0.1']),
    resolve: async (host) => {
      if (host === 'evil.internal.test') {
        hopResolutions++;
        return ['127.0.0.1'];
      }
      return ['127.0.0.1'];
    },
  });
  await expect(fetcher(listenerA.url('/entry2'), { method: 'GET' })).rejects.toBeInstanceOf(DestinationDeniedError);
  expect(hopResolutions).toBe(1);
  expect(listenerA.requests).toBe(1);
});

it('[LOCK] unparseable Location is denied fail-closed', async () => {
  const listenerA = await start();
  listenerA.enqueue({ kind: 'respond', status: 302, headers: { location: 'http://[' }, body: '' });
  const fetcher = createPinnedFetch({ allowHosts: new Set(['127.0.0.1']) });
  const err = await fetcher(listenerA.url('/entry3'), { method: 'GET' }).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(DestinationDeniedError);
  expect(String((err as Error).message)).toMatch(/unparseable/);
});

it('[LOCK] PUBLIC 3xx hop passes through unfollowed (control — caller decides)', async () => {
  const listenerA = await start();
  const listenerB = await start(); // stands in for the public hop target: must stay silent
  listenerA.enqueue({ kind: 'redirect', status: 302, location: 'https://pub.example.test/moved' });
  let hopResolutions = 0;
  const fetcher = createPinnedFetch({
    allowHosts: new Set(['127.0.0.1']),
    resolve: async () => {
      hopResolutions++;
      return ['192.0.2.77']; // TEST-NET-1: routable per policy
    },
  });
  const res = await fetcher(listenerA.url('/entry4'), { method: 'GET' });
  expect(res.status).toBe(302); // egress does NOT follow and does NOT deny a public hop
  const loc = res.headers.get('location');
  expect(loc).toBe('https://pub.example.test/moved');
  expect(hopResolutions).toBe(1); // hop was ADJUDICATED (resolve once) ...
  expect(listenerB.requests).toBe(0); // ... and provably never dialled
});
