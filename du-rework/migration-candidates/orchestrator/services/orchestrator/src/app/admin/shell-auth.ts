/**
 * Pure cookie sign/verify for the Admin shell (P6-01).
 *
 * Scheme: HMAC-SHA256 over the JSON payload (base64url) with a cookie
 * secret held by the orchestrator. The cookie body is `base64url(payload)
 * . base64url(hmac-sha256(payload))`. Verify uses a constant-time
 * compare so a forged signature cannot be detected byte-by-byte.
 *
 * Pure: no DB, no Redis, no HTTP. Node `crypto` only.
 *
 * Fail-closed: a missing or malformed cookie is `null`, never an
 * exception. A verified cookie with `exp` in the past is `null`. A
 * verified cookie with `iat` in the future is `null`.
 *
 * Strict TypeScript, zero `any`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdminCookieClaims } from './shell-types';

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(s: string): Buffer | null {
  if (s.length === 0) return null;
  // Re-pad.
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON (no JSON.parse/JSON.stringify exceptions escape the boundary)
// ---------------------------------------------------------------------------

function safeJsonParse(buf: Buffer): AdminCookieClaims | null {
  try {
    const text = buf.toString('utf8');
    if (text.length === 0) return null;
    const v: unknown = JSON.parse(text);
    return validateClaims(v);
  } catch {
    return null;
  }
}

function validateClaims(v: unknown): AdminCookieClaims | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o['iss'] !== 'du-admin-shell') return null;
  if (typeof o['role'] !== 'string') return null;
  if (o['role'] !== 'admin' && o['role'] !== 'operator' && o['role'] !== 'viewer') {
    return null;
  }
  if (typeof o['iat'] !== 'number' || !Number.isFinite(o['iat'])) return null;
  if (typeof o['exp'] !== 'number' || !Number.isFinite(o['exp'])) return null;
  return {
    iss: 'du-admin-shell',
    role: o['role'],
    iat: o['iat'],
    exp: o['exp'],
  };
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign claims into a cookie string. Returns `null` if the secret is
 * empty or claims are out of range (defensive; callers usually build
 * claims themselves and never pass `NaN`).
 */
export function signCookie(
  secret: string,
  claims: AdminCookieClaims,
): string | null {
  if (!secret) return null;
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return null;
  // Note — `exp <= iat` is allowed at sign time so tests can mint
  // already-expired cookies to assert verify-time rejection. The
  // production callers (handleLoginPost) always pass `iat = now, exp
  // = now + maxAge*1000`, where `exp > iat` is enforced.

  const payload = base64urlEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  const mac = createHmac('sha256', secret).update(payload).digest();
  const sig = base64urlEncode(mac);
  return `${payload}.${sig}`;
}

/**
 * Verify a cookie string and return its claims if valid and unexpired.
 * Returns `null` on any failure (bad shape, bad signature, expired).
 *
 * `nowMs` is injectable for deterministic tests; production callers
 * omit it and the function reads `Date.now()`.
 */
export function verifyCookie(
  secret: string,
  cookie: string | undefined | null,
  nowMs?: number,
): AdminCookieClaims | null {
  if (!secret) return null;
  if (!cookie) return null;

  const dotIdx = cookie.indexOf('.');
  if (dotIdx <= 0 || dotIdx === cookie.length - 1) return null;
  const payload = cookie.slice(0, dotIdx);
  const sig = cookie.slice(dotIdx + 1);

  const expectedMac = createHmac('sha256', secret).update(payload).digest();
  const providedMac = base64urlDecode(sig);
  if (!providedMac) return null;
  if (providedMac.length !== expectedMac.length) return null;
  if (!timingSafeEqual(providedMac, expectedMac)) return null;

  const buf = base64urlDecode(payload);
  if (!buf) return null;
  const claims = safeJsonParse(buf);
  if (!claims) return null;

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (claims.exp <= now) return null;
  if (claims.iat > now + 60_000) return null; // small clock-skew tolerance
  return claims;
}

// ---------------------------------------------------------------------------
// Cookie header parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw `Cookie:` header into a flat `{name: value}` record.
 * Last-write-wins; no decoding beyond `decodeURIComponent` on name
 * and value. Returns `{}` for missing or empty headers.
 *
 * Cookie names that fail decoding are skipped (defensive; some browsers
 * emit odd bytes). Malformed pairs are skipped silently.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const rawName = trimmed.slice(0, eq);
    const rawValue = trimmed.slice(eq + 1);
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
    if (name.length === 0) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Build a `Set-Cookie` header value. `maxAgeSeconds` of 0 emits
 * `Max-Age=0` to clear the cookie at the client.
 */
export function buildSetCookieHeader(
  name: string,
  value: string,
  opts: {
    maxAgeSeconds: number;
    path?: string;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    secure?: boolean;
  },
): string {
  const parts: string[] = [`${name}=${value}`];
  parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite ?? 'Strict'}`);
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Application/x-www-form-urlencoded parsing (POST body)
// ---------------------------------------------------------------------------

/**
 * Parse a raw `application/x-www-form-urlencoded` body. Each key and
 * value is `decodeURIComponent`d. Returns `{}` on null / empty / error.
 * Used for the login form (`token=...`) and any future POST forms.
 */
export function parseFormBody(body: string | undefined | null): Record<string, string> {
  if (!body) return {};
  const out: Record<string, string> = {};
  for (const part of body.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    if (eq < 0) {
      try {
        const k = decodeURIComponent(part.replace(/\+/g, ' '));
        if (k.length > 0) out[k] = '';
      } catch {
        // skip
      }
      continue;
    }
    const rawK = part.slice(0, eq);
    const rawV = part.slice(eq + 1);
    try {
      const k = decodeURIComponent(rawK.replace(/\+/g, ' '));
      const v = decodeURIComponent(rawV.replace(/\+/g, ' '));
      if (k.length > 0) out[k] = v;
    } catch {
      // skip
    }
  }
  return out;
}