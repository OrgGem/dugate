/**
 * Cookie sign / verify / parse tests for the Admin shell (P6-01).
 *
 * Pure: HMAC over base64url(JSON). The test asserts:
 *   - round-trip preserves claims
 *   - tampering is rejected (constant-time compare failure)
 *   - expired cookies fail closed
 *   - empty secret disables the API
 *   - clock-skew tolerance is bounded
 *   - cookie header parsing handles edge cases
 */

import {
  buildSetCookieHeader,
  parseCookieHeader,
  parseFormBody,
  signCookie,
  verifyCookie,
} from '../src/app/admin/shell-auth';
import type { AdminCookieClaims } from '../src/app/admin/shell-types';

describe('admin-shell-auth (P6-01)', () => {
  const SECRET = 'test-secret-do-not-leak';
  const NOW = 1_700_000_000_000;

  const sampleClaims: AdminCookieClaims = {
    iss: 'du-admin-shell',
    role: 'admin',
    iat: NOW,
    exp: NOW + 60_000,
  };

  describe('signCookie + verifyCookie', () => {
    it('round-trips claims', () => {
      const c = signCookie(SECRET, sampleClaims);
      expect(c).not.toBeNull();
      const verified = verifyCookie(SECRET, c, NOW + 1_000);
      expect(verified).toEqual(sampleClaims);
    });

    it('returns null for an empty secret', () => {
      expect(signCookie('', sampleClaims)).toBeNull();
      expect(verifyCookie('', 'whatever', NOW)).toBeNull();
    });

    it('rejects an empty cookie', () => {
      expect(verifyCookie(SECRET, '', NOW)).toBeNull();
      expect(verifyCookie(SECRET, null, NOW)).toBeNull();
      expect(verifyCookie(SECRET, undefined, NOW)).toBeNull();
    });

    it('rejects a cookie with a tampered payload', () => {
      const c = signCookie(SECRET, sampleClaims);
      expect(c).not.toBeNull();
      // Tamper with the payload (the part before the dot).
      const dotIdx = c!.indexOf('.');
      const tampered = `AAAA${c!.slice(dotIdx)}`;
      expect(verifyCookie(SECRET, tampered, NOW + 1_000)).toBeNull();
    });

    it('rejects a cookie with a tampered signature', () => {
      const c = signCookie(SECRET, sampleClaims);
      expect(c).not.toBeNull();
      const tampered = `${c!.slice(0, c!.length - 4)}AAAA`;
      expect(verifyCookie(SECRET, tampered, NOW + 1_000)).toBeNull();
    });

    it('rejects a cookie signed with a different secret', () => {
      const c = signCookie('other-secret', sampleClaims);
      expect(c).not.toBeNull();
      expect(verifyCookie(SECRET, c, NOW + 1_000)).toBeNull();
    });

    it('rejects an expired cookie', () => {
      const expired = { ...sampleClaims, exp: NOW - 1 };
      const c = signCookie(SECRET, expired);
      expect(c).not.toBeNull();
      expect(verifyCookie(SECRET, c, NOW)).toBeNull();
    });

    it('rejects iat too far in the future (clock-skew guard)', () => {
      const future = { ...sampleClaims, iat: NOW + 5 * 60_000, exp: NOW + 10 * 60_000 };
      const c = signCookie(SECRET, future);
      expect(c).not.toBeNull();
      expect(verifyCookie(SECRET, c, NOW)).toBeNull();
    });

    it('accepts a small forward clock skew (<= 60s)', () => {
      const sk = { ...sampleClaims, iat: NOW + 30_000, exp: NOW + 60_000 };
      const c = signCookie(SECRET, sk);
      expect(c).not.toBeNull();
      expect(verifyCookie(SECRET, c, NOW)).toEqual(sk);
    });

    it('rejects a malformed cookie (no dot)', () => {
      expect(verifyCookie(SECRET, 'no-dot-here', NOW)).toBeNull();
    });

    it('rejects a cookie with a non-base64url signature', () => {
      expect(verifyCookie(SECRET, 'AAAA.@@@', NOW)).toBeNull();
    });

    it('rejects claims whose iss is not the shell issuer', () => {
      const forged = JSON.stringify({ ...sampleClaims, iss: 'other' });
      // signCookie accepts any object — but verify validates iss via
      // safeJsonParse → validateClaims. Build the cookie by hand.
      const { createHmac } = require('node:crypto');
      const payload = Buffer.from(forged, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const sig = createHmac('sha256', SECRET).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      expect(verifyCookie(SECRET, `${payload}.${sig}`, NOW)).toBeNull();
    });

    it('rejects claims whose role is invalid', () => {
      const forged = JSON.stringify({ ...sampleClaims, role: 'super-admin' });
      const { createHmac } = require('node:crypto');
      const payload = Buffer.from(forged, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const sig = createHmac('sha256', SECRET).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      expect(verifyCookie(SECRET, `${payload}.${sig}`, NOW)).toBeNull();
    });

    it('signs even when exp <= iat (verify is the source of truth for expiry)', () => {
      // The shell signs (e.g. for tests that exercise verify-time
      // rejection). Sign-time only blocks NaN/Infinity to keep JSON
      // round-trips safe.
      const c = signCookie(SECRET, { ...sampleClaims, exp: sampleClaims.iat });
      expect(c).not.toBeNull();
    });

    it('refuses to sign when iat or exp is not finite', () => {
      expect(signCookie(SECRET, { ...sampleClaims, iat: Number.NaN })).toBeNull();
      expect(signCookie(SECRET, { ...sampleClaims, exp: Number.POSITIVE_INFINITY })).toBeNull();
    });
  });

  describe('parseCookieHeader', () => {
    it('returns {} for null / empty / undefined', () => {
      expect(parseCookieHeader(null)).toEqual({});
      expect(parseCookieHeader(undefined)).toEqual({});
      expect(parseCookieHeader('')).toEqual({});
    });
    it('parses single and multiple cookies', () => {
      expect(parseCookieHeader('a=b')).toEqual({ a: 'b' });
      expect(parseCookieHeader('a=b; c=d; e=f')).toEqual({ a: 'b', c: 'd', e: 'f' });
    });
    it('last-write-wins on duplicate names', () => {
      expect(parseCookieHeader('a=b; a=c')).toEqual({ a: 'c' });
    });
    it('decodes percent-encoded name and value', () => {
      expect(parseCookieHeader('a%20b=c%20d')).toEqual({ 'a b': 'c d' });
    });
    it('skips malformed pairs silently', () => {
      expect(parseCookieHeader('a=b; %%%broken; c=d')).toEqual({ a: 'b', c: 'd' });
    });
  });

  describe('buildSetCookieHeader', () => {
    it('emits HttpOnly, SameSite=Strict, Path=/, Max-Age', () => {
      const h = buildSetCookieHeader('du_admin', 'signed', { maxAgeSeconds: 60 });
      expect(h).toContain('du_admin=signed');
      expect(h).toContain('HttpOnly');
      expect(h).toContain('SameSite=Strict');
      expect(h).toContain('Path=/');
      expect(h).toContain('Max-Age=60');
    });
    it('emits Max-Age=0 when clearing', () => {
      const h = buildSetCookieHeader('du_admin', '', { maxAgeSeconds: 0 });
      expect(h).toContain('Max-Age=0');
    });
    it('emits Secure when requested', () => {
      const h = buildSetCookieHeader('du_admin', 'x', { maxAgeSeconds: 60, secure: true });
      expect(h).toContain('Secure');
    });
  });

  describe('parseFormBody', () => {
    it('parses key=value pairs', () => {
      expect(parseFormBody('a=b&c=d')).toEqual({ a: 'b', c: 'd' });
    });
    it('decodes + as space', () => {
      expect(parseFormBody('a=hello+world')).toEqual({ a: 'hello world' });
    });
    it('decodes percent-encoded values', () => {
      expect(parseFormBody('a=%3Cb%3E')).toEqual({ a: '<b>' });
    });
    it('handles keys without values', () => {
      expect(parseFormBody('a')).toEqual({ a: '' });
    });
    it('returns {} for null / empty / undefined', () => {
      expect(parseFormBody(null)).toEqual({});
      expect(parseFormBody('')).toEqual({});
      expect(parseFormBody(undefined)).toEqual({});
    });
    it('skips malformed pairs', () => {
      expect(parseFormBody('a=b&%XX&c=d')).toEqual({ a: 'b', c: 'd' });
    });
  });
});