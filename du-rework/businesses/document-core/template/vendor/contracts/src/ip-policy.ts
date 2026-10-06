// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/contracts/src/ip-policy.ts (lines=279) sha256=B5A78AFBD8C16C5E991B18469214693FA38E2F284AD10DB1C7B542B13ADA2D77
// why: transitive dep of operations.ts (adjudicateUrlDestination, DESTINATION_DENIED)

/**
 * Shared IP destination policy (FIX-CR-01) — the single source of truth the R1-C
 * boundary vector table (tests/harness/network-boundaries/policy-vectors.ts) pins.
 * Adjudication is done on BYTES after canonicalization, not on string prefixes: every
 * WHATWG-serializable spelling of an address must collapse to the same decision
 * (measured 2026-09-25: ::ffff:127.0.0.1 and ::ffff:7f00:1 canonicalize identically).
 *
 * Design notes (report qwen3.md W49-Q3-2 sec.A.2/A.3 + sec.4b corrections):
 * - IPv4-mapped (::ffff:x), IPv4-compatible (::x), 6to4 (2002::/16), NAT64 well-known
 *   (64:ff9b::/96) and Teredo (2001::/32, obfuscated client field) are UNWRAPPED to
 *   their embedded IPv4 and THAT address is adjudicated — embedded-loopback variants
 *   are the exact WR24-05 gap.
 * - allowHosts may never skip adjudication for a NAME: a name can resolve anywhere.
 *   Exact IP-literals on the list are honored (precise opt-in, preserves the
 *   providerAllowHosts 127.0.0.1 local-test convention).
 * - No DNS in this module: callers resolve, then feed EVERY answer to
 *   isDestinationAddressAllowed using the same opt-in policy.
 */

export const DESTINATION_DENIED = 'DESTINATION_DENIED';

/** Strict dotted-quad of decimal octets, as a WHATWG hostname would present it. */
export function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => p.length > 0 && p.length <= 3 && /^[0-9]+$/.test(p) && Number(p) <= 255);
}

export function isIpv6Literal(host: string): boolean {
  return host.includes(':');
}

function parseIpv4Bytes(host: string): Uint8Array | null {
  if (!isIpv4Literal(host)) return null;
  const parts = host.split('.');
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) bytes[i] = Number(parts[i]);
  return bytes;
}

/**
 * inet_aton-family parsing for URL-shaped hosts: dotted forms with decimal/octal/hex
 * parts (0177.0.0.1, 0x7f.1), 1-3 part short forms (127.1, 2130706433). WHATWG
 * canonicalizes most of these before we see them, but shipped behavior for
 * leading-zero parts differs across parser versions, so we normalize defensively.
 * inet_aton semantics: the LAST segment fills all remaining low bytes
 * (127.1 -> 127.0.0.1, not 0.0.127.1). Returns null for regular domain names.
 */
export function parseNumericHostForm(host: string): Uint8Array | null {
  const raw = host.toLowerCase().replace(/\.$/, '');
  if (raw.length === 0) return null;
  if (isIpv6Literal(raw)) return null;
  const parts = raw.split('.');
  if (parts.length > 4) return null;
  const parsed: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/.test(part)) n = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part) && part.length > 1) n = parseInt(part.slice(1), 8);
    else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10);
    else return null; // letters involved -> domain, not numeric form
    if (!Number.isFinite(n) || n < 0 || n > 4294967295) return null;
    parsed.push(n);
  }
  const lead = parsed.slice(0, parsed.length - 1);
  if (lead.some((v) => v > 255)) return null;
  const width = 4 - lead.length; // bytes claimed by the last segment
  const last = parsed[parsed.length - 1] as number;
  if (last >= Math.pow(256, width)) return null;
  const bytes = new Uint8Array(4);
  lead.forEach((v, i) => {
    bytes[i] = v;
  });
  let rest = last;
  for (let i = 3; i >= lead.length; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

function parseHextet(word: string): number | null {
  if (word.length === 0 || word.length > 4 || !/^[0-9a-f]{1,4}$/.test(word)) return null;
  return parseInt(word, 16);
}

function parseIpv6Bytes(host: string): Uint8Array | null {
  const original = host.toLowerCase().replace(/^[［[\]］]/g, '');
  if (original.length === 0 || original.includes('%')) return null; // zones are not connect targets
  // Convert a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
  let h = original;
  const lastColon = h.lastIndexOf(':');
  if (h.includes('.')) {
    const v4 = parseNumericHostForm(h.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] as number) << 8) | (v4[1] as number);
    const lo = ((v4[2] as number) << 8) | (v4[3] as number);
    h = h.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
  }
  const zones = h.split('::');
  if (zones.length > 2) return null;
  const toWords = (s: string): number[] | null => {
    if (s.length === 0) return [];
    const out: number[] = [];
    for (const w of s.split(':')) {
      const v = parseHextet(w);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  let words: number[];
  if (zones.length === 2) {
    const head = toWords(zones[0] as string);
    const tail = toWords(zones[1] as string);
    if (!head || !tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    words = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    const all = toWords(h);
    if (!all || all.length !== 8) return null;
    words = all;
  }
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[i * 2] = (w >> 8) & 0xff;
    bytes[i * 2 + 1] = w & 0xff;
  });
  return bytes;
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

function checkV4(b: Uint8Array): boolean {
  const a0 = b[0] as number;
  const a1 = b[1] as number;
  if (a0 === 0) return false; // 0.0.0.0/8
  if (a0 === 10) return false; // RFC1918
  if (a0 === 100 && (a1 & 0xc0) === 64) return false; // CGNAT 100.64/10 (cloud metadata placement)
  if (a0 === 127) return false; // loopback
  if (a0 === 169 && a1 === 254) return false; // link-local + cloud metadata
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return false; // RFC1918
  if (a0 === 192 && a1 === 0 && (b[2] as number) === 0) return false; // IETF 192.0.0/24 (NOT TEST-NET 192.0.2/24)
  if (a0 === 192 && a1 === 168) return false; // RFC1918
  if (a0 === 198 && (a1 & 0xfe) === 18) return false; // benchmarking 198.18/15
  if (a0 >= 224) return false; // multicast 224/4, reserved 240/4, broadcast
  return true;
}

function isPrivateV4(b: Uint8Array): boolean {
  const a0 = b[0] as number;
  const a1 = b[1] as number;
  return a0 === 10
    || a0 === 127
    || (a0 === 172 && a1 >= 16 && a1 <= 31)
    || (a0 === 192 && a1 === 168);
}

/** Returns embedded IPv4 bytes when the v6 form carries one, else null. */
function unwrapV6(b: Uint8Array): Uint8Array | null {
  if (allZero(b, 0, 10) && (b[10] as number) === 0xff && (b[11] as number) === 0xff) return b.subarray(12, 16); // mapped
  if (allZero(b, 0, 12)) return b.subarray(12, 16); // IPv4-compatible, ::, ::1
  if (b[0] === 0x20 && b[1] === 0x02) return b.subarray(2, 6); // 6to4 2002::/16
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
    return b.subarray(12, 16); // NAT64 well-known 64:ff9b::/96
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    const out = new Uint8Array(4); // Teredo 2001::/32: client IPv4 is obfuscated (bitwise NOT)
    for (let i = 0; i < 4; i++) out[i] = (~(b[12 + i] as number)) & 0xff;
    return out;
  }
  return null;
}

/**
 * True when the address may be connected to. Unparseable input is NOT routable
 * (fail closed at this layer).
 */
export function isPubliclyRoutableAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseIpv4Bytes(host) ?? parseNumericHostForm(host);
  if (v4) return checkV4(v4);
  const v6 = parseIpv6Bytes(host);
  if (!v6) return false;
  const embedded = unwrapV6(v6);
  if (embedded) return checkV4(embedded);
  if (v6[0] === 0xfe && (((v6[1] as number) & 0xc0) === 0x80)) return false; // link-local fe80::/10
  if ((((v6[0] as number)) & 0xfe) === 0xfc) return false; // ULA fc00::/7
  if ((((v6[0] as number)) & 0xf0) === 0xf0) return false; // multicast + reserved
  return true;
}

/**
 * True only for RFC1918, loopback, and IPv6 ULA destinations. These are the address
 * classes the explicit local-network opt-in is intended to permit. Link-local (including
 * cloud metadata), unspecified, CGNAT, multicast, and reserved ranges remain blocked.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseIpv4Bytes(host) ?? parseNumericHostForm(host);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIpv6Bytes(host);
  if (!v6) return false;
  if (allZero(v6, 0, 15) && v6[15] === 1) return true; // ::1 only; :: stays blocked
  if ((((v6[0] as number)) & 0xfe) === 0xfc) return true; // ULA fc00::/7
  const embedded = unwrapV6(v6);
  return embedded ? isPrivateV4(embedded) : false;
}

/** Apply the common public policy plus its narrowly scoped private-network opt-in. */
export function isDestinationAddressAllowed(
  address: string,
  options: { allowPrivateNetworks?: boolean } = {},
): boolean {
  return isPubliclyRoutableAddress(address)
    || (options.allowPrivateNetworks === true && isPrivateNetworkAddress(address));
}

export type DestinationKind = 'ALLOWED' | 'DENIED' | 'NEEDS_RESOLUTION';

export interface DestinationDecision {
  readonly kind: DestinationKind;
  readonly code: string;
  readonly reason: string;
  readonly host?: string;
}

function deny(reason: string): DestinationDecision {
  return { kind: 'DENIED', code: DESTINATION_DENIED, reason };
}

/**
 * Protocol/userinfo/IP-literal adjudication for a destination URL, before any DNS or
 * connect. NEEDS_RESOLUTION means "host is a name; resolve it and run
 * isDestinationAddressAllowed on EVERY answer with the same opt-in — any blocked
 * answer denies the destination; a lookup error is the caller's retryable-unresolved
 * case, not a deny".
 */
export function adjudicateUrlDestination(
  rawUrl: string,
  options: { allowHosts?: ReadonlySet<string>; allowPrivateNetworks?: boolean } = {},
): DestinationDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('unparseable destination url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return deny('destination protocol is not http(s)');
  }
  if (url.username !== '' || url.password !== '') {
    return deny('userinfo in destination url is not allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const numeric = parseNumericHostForm(host);
  const literal = isIpv4Literal(host) || isIpv6Literal(host);
  if (numeric || literal) {
    const dotted = numeric ? Array.from(numeric).join('.') : host;
    if (options.allowHosts?.has(dotted) || options.allowHosts?.has(host)) {
      return { kind: 'ALLOWED', code: 'ALLOWED', reason: 'exact ip-literal allowlist opt-in', host };
    }
    return isDestinationAddressAllowed(host, options)
      ? {
          kind: 'ALLOWED',
          code: 'ALLOWED',
          reason: isPubliclyRoutableAddress(host) ? 'publicly routable destination' : 'explicit private-network opt-in',
          host,
        }
      : deny('destination ip ' + dotted + ' is in a blocked range');
  }
  if (host.length === 0) return deny('empty destination host');
  return { kind: 'NEEDS_RESOLUTION', code: 'NEEDS_RESOLUTION', reason: 'resolve and adjudicate every answer', host };
}
