/**
 * R1-C canonical IP/DNS policy vector table (single source of truth).
 * Consumed by services/connector, services/orchestrator (webhook), packages/worker-sdk tests.
 * Absorbs services/connector/tests/reliability-security.test.ts:66-69 and the offline part of
 * tests/integration/p8-04-security-isolation.integration.test.ts (that suite stays the LIVE twin).
 * `expect` is the TARGET adjudication (what the fixed policy must return), not today's behavior:
 * vectors whose target differs from current behavior are the [OPEN:FIX-CR-01 / WR24-05] set.
 */

export interface IpPolicyVector {
  /** IP literal exactly as written; canonicalize via canonicalIpLiteral() before adjudication. */
  readonly input: string;
  readonly expect: 'ALLOW' | 'DENY';
  readonly why: string;
  readonly ipFamily: 4 | 6;
  /** Canonical review row this vector pins. */
  readonly row: string;
  readonly origin: 'A.2' | 'absorbed:reliability-security' | 'absorbed:p8-04' | 'control';
}

export const HARNESS_PORT = 8080;

type Expect = IpPolicyVector['expect'];
type Origin = IpPolicyVector['origin'];

const V6 = (input: string, expect: Expect, why: string, row: string, origin: Origin = 'A.2'): IpPolicyVector =>
  ({ input, expect, why, ipFamily: 6, row, origin });
const V4 = (input: string, expect: Expect, why: string, row: string, origin: Origin = 'A.2'): IpPolicyVector =>
  ({ input, expect, why, ipFamily: 4, row, origin });

export const IP_POLICY_VECTORS: readonly IpPolicyVector[] = [
  // --- already-blocked today: LOCK (regression pins; absorbed existing connector/p8-04 vectors) ---
  V4('127.0.0.1', 'DENY', 'IPv4 loopback', 'FIX-CR-01', 'absorbed:reliability-security'),
  V6('::1', 'DENY', 'IPv6 loopback', 'FIX-CR-01', 'absorbed:reliability-security'),
  V4('0.0.0.0', 'DENY', 'unspecified', 'FIX-CR-01'),
  V4('10.255.255.255', 'DENY', 'RFC1918 10/8', 'FIX-CR-01', 'absorbed:p8-04'),
  V4('172.16.0.1', 'DENY', 'RFC1918 172.16/12', 'FIX-CR-01', 'absorbed:p8-04'),
  V4('172.31.255.255', 'DENY', 'RFC1918 172.16/12 upper edge', 'FIX-CR-01', 'absorbed:p8-04'),
  V4('192.168.1.1', 'DENY', 'RFC1918 192.168/16', 'FIX-CR-01', 'absorbed:p8-04'),
  V4('169.254.169.254', 'DENY', 'link-local cloud metadata', 'FIX-CR-01', 'absorbed:p8-04'),
  V6('fe80::1', 'DENY', 'link-local IPv6', 'FIX-CR-01'),
  V6('fc00::', 'DENY', 'ULA fc00::/8', 'FIX-CR-01'),
  V6('fd12:3456::1', 'DENY', 'ULA fd00::/8 (RFC 4193)', 'FIX-CR-01'),
  // --- target DENY, allowed today (string-matching isBlockedAddress misses them): OPEN ---
  V6('::ffff:7f00:1', 'DENY', 'IPv4-mapped loopback, hextet serialization variant (WR24-05)', 'WR24-05'),
  V6('::ffff:127.0.0.1', 'DENY', 'IPv4-mapped loopback, dotted-tail serialization variant', 'WR24-05'),
  V6('0:0:0:0:0:0:0:1', 'DENY', 'non-compressed IPv6 loopback', 'WR24-05'),
  V6('::', 'DENY', 'IPv6 unspecified (self-connect)', 'FIX-CR-01'),
  V6('2002:7f00:1::', 'DENY', '6to4 carrying embedded 127.0.0.1', 'WR24-05'),
  V6('64:ff9b::7f00:1', 'DENY', 'NAT64 well-known prefix carrying 127.0.0.1', 'WR24-05'),
  V6('2001:0:4136:e378:8000:63bf:3fff:ffff', 'DENY', 'Teredo prefix 2001::/32', 'WR24-05'),
  V6('ff02::1', 'DENY', 'IPv6 link-local all-nodes multicast', 'FIX-CR-01'),
  V4('224.0.0.1', 'DENY', 'IPv4 multicast', 'FIX-CR-01'),
  V4('100.64.1.1', 'DENY', 'CGNAT 100.64/10 (cloud metadata placement)', 'FIX-CR-01'),
  V4('198.18.0.1', 'DENY', 'benchmarking 198.18/15', 'FIX-CR-01'),
  V4('192.0.0.1', 'DENY', 'IETF protocol assignments 192.0.0/24', 'FIX-CR-01'),
  // --- positive controls: must stay ALLOW (false-deny guard). TEST-NET/documentation ranges only. ---
  V4('192.0.2.1', 'ALLOW', 'TEST-NET-1 documentation range', 'control'),
  V4('198.51.100.1', 'ALLOW', 'TEST-NET-2 documentation range', 'control'),
  V4('203.0.113.10', 'ALLOW', 'TEST-NET-3 documentation range', 'control'),
  V6('2001:db8::1', 'ALLOW', 'documentation IPv6 range', 'control'),
];

export const DENY_VECTORS: readonly IpPolicyVector[] = IP_POLICY_VECTORS.filter((v) => v.expect === 'DENY');
export const ALLOW_VECTORS: readonly IpPolicyVector[] = IP_POLICY_VECTORS.filter((v) => v.expect === 'ALLOW');

/** WHATWG canonicalization of an IP literal, exactly as a URL-parsing policy layer would see it. */
export function canonicalIpLiteral(vector: IpPolicyVector): string {
  const raw = vector.ipFamily === 6
    ? `http://[${vector.input}]:${HARNESS_PORT}/`
    : `http://${vector.input}:${HARNESS_PORT}/`;
  return new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/** URL whose host is the canonicalized literal (policy adjudication point). */
export function urlForVector(vector: IpPolicyVector): string {
  const host = canonicalIpLiteral(vector);
  return vector.ipFamily === 6 ? `http://[${host}]:${HARNESS_PORT}/` : `http://${host}:${HARNESS_PORT}/`;
}
