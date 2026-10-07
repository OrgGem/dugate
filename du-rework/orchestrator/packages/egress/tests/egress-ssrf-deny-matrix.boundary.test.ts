import { createPinnedFetch, DestinationDeniedError } from '../src/pinned-fetch';
import { BoundaryListener, sleep } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * CYCLE-102 SSRF deny-matrix for the pinned egress policy path:
 * a hostname whose DNS answer lands in private / link-local / loopback space MUST
 * throw DestinationDeniedError AND must never reach the socket layer. The single
 * shared listener is the negative oracle — every case targets its real port, so any
 * case that leaked past adjudication would show up as requests > 0, not as a hang.
 *
 * The policy itself (byte-space ranges) is contracts-owned and pinned vector-by-vector
 * in services/connector/tests/network-boundaries.boundary.test.ts; this file proves
 * the ENFORCEMENT SITE (resolve→deny→no-connect) at the @du/egress boundary for the
 * full class the packet names, including /8-/12-/16-breadth variants.
 *
 * Run: pnpm --dir packages/egress exec jest tests/egress-ssrf-deny-matrix.boundary.test.ts --runInBand
 */

const DENY_MATRIX: ReadonlyArray<{ readonly label: string; readonly ip: string }> = [
  { label: 'IPv4 loopback /8 base', ip: '127.0.0.1' },
  { label: 'IPv4 loopback /8 breadth', ip: '127.5.6.7' },
  { label: 'RFC1918 10/8', ip: '10.10.10.10' },
  { label: 'RFC1918 172.16/12 lower edge', ip: '172.16.0.1' },
  { label: 'RFC1918 172.16/12 upper edge', ip: '172.31.255.255' },
  { label: 'RFC1918 192.168/16', ip: '192.168.100.5' },
  { label: 'link-local /16', ip: '169.254.1.1' },
  { label: 'cloud metadata address', ip: '169.254.169.254' },
  { label: 'IPv6 loopback', ip: '::1' },
  { label: 'ULA fc00:: half of fc00::/7', ip: 'fc00::' },
  { label: 'ULA fd00:: half of fc00::/7', ip: 'fd12:3456:789a:1::2' },
  { label: 'IPv6 link-local fe80::/10', ip: 'fe80::dead:beef' },
];

let listener: BoundaryListener;
let resolveCalls = 0;

beforeAll(async () => {
  listener = await BoundaryListener.start();
});

afterAll(async () => {
  if (listener) await listener.stop().catch(() => undefined);
});

beforeEach(() => {
  resolveCalls = 0;
});

async function denyFor(hostname: string, answers: string[]): Promise<unknown> {
  const fetcher = createPinnedFetch({
    resolve: async () => {
      resolveCalls++;
      return answers;
    },
  });
  return fetcher('http://' + hostname + ':' + listener.port + '/ssrf-probe', { method: 'GET' }).then(
    () => null, // resolved promise = the failure we assert below
    (err: unknown) => err
  );
}

for (const vector of DENY_MATRIX) {
  it('[LOCK] hostname resolving to ' + vector.label + ' (' + vector.ip + ') is denied without a socket', async () => {
    const err = await denyFor('blocked-' + vector.ip.replace(/[:.]/g, '-') + '.external.test', [vector.ip]);
    expect(err).toBeInstanceOf(DestinationDeniedError);
    expect(String((err as Error).message)).toMatch(/resolved destination is not routable/);
    expect(resolveCalls).toBe(1); // denied on the FIRST adjudicated answer — never re-resolved, never dialled
    expect(listener.requests).toBe(0); // THE socket oracle
  });
}

it('[LOCK] mixed answer [public, private] still denies (every-answer policy, not first-only)', async () => {
  const err = await denyFor('mixed-a.external.test', ['192.0.2.5', '10.0.0.1']);
  expect(err).toBeInstanceOf(DestinationDeniedError);
  expect(String((err as Error).message)).toMatch(/not routable/);
  expect(resolveCalls).toBe(1);
  expect(listener.requests).toBe(0);
});

it('[LOCK] private answer via IPv4-COMPRESSED v6 forms also denied (mapped ::ffff:a.b.c.d)', async () => {
  const err = await denyFor('mapped-compressed.external.test', ['::ffff:7f00:1']);
  expect(err).toBeInstanceOf(DestinationDeniedError);
  expect(resolveCalls).toBe(1);
  expect(listener.requests).toBe(0);
});

it('[LOCK] allowPrivateNetworks opt-in still REFUSES metadata/link-local (narrow escape hatch)', async () => {
  // The opt-in is contracts-narrow (RFC1918/loopback/ULA only): metadata must stay denied
  // even when a caller believes they opted in — pinning the WR24-05/CGNAT-class gap.
  const fetcher = createPinnedFetch({
    allowPrivateNetworks: true,
    resolve: async () => {
      resolveCalls++;
      return ['169.254.169.254'];
    },
  });
  await expect(
    fetcher('http://meta-escape.external.test:' + listener.port + '/latest/meta-data', { method: 'GET' })
  ).rejects.toBeInstanceOf(DestinationDeniedError);
  expect(resolveCalls).toBe(1);
  expect(listener.requests).toBe(0);
});
