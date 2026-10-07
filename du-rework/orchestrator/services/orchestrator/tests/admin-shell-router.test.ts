/**
 * Route-matcher tests for the Admin shell (P6-01).
 *
 * Pure: each test calls `matchShellRoute(method, pathname)` and asserts
 * the matched route id / section / required-role. The role guard is
 * exercised separately through `dispatchShellRequest`.
 */

import {
  deriveRoleFromToken,
  dispatchShellRequest,
  matchShellRoute,
} from '../src/app/admin/shell-router';

describe('admin-shell-router (P6-01)', () => {
  describe('matchShellRoute', () => {
    it('matches the admin root', () => {
      const r = matchShellRoute('GET', '/');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('admin-root');
      expect(r!.section).toBeNull();
      expect(r!.requiredRole).toBe('viewer');
    });

    it('matches /admin and /admin/ as the root', () => {
      expect(matchShellRoute('GET', '/admin')!.id).toBe('admin-root');
      expect(matchShellRoute('GET', '/admin/')!.id).toBe('admin-root');
    });

    it('matches /admin/login', () => {
      const r = matchShellRoute('GET', '/admin/login');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('admin-login');
    });

    it('matches /admin/logout for POST only', () => {
      expect(matchShellRoute('POST', '/admin/logout')!.id).toBe('admin-logout');
      expect(matchShellRoute('GET', '/admin/logout')).toBeNull();
    });

    it('matches each section in the canonical nav', () => {
      const cases: Array<[string, string, 'admin' | 'operator' | 'viewer']> = [
        ['/admin/businesses', 'businesses', 'viewer'],
        ['/admin/operations', 'operations', 'viewer'],
        ['/admin/profiles', 'profiles', 'admin'],
        ['/admin/connectors', 'connectors', 'admin'],
        ['/admin/grants', 'grants', 'admin'],
      ];
      for (const [path, section, requiredRole] of cases) {
        const r = matchShellRoute('GET', path);
        expect(r).not.toBeNull();
        expect(r!.id).toBe('section:' + section);
        expect(r!.section).toBe(section);
        expect(r!.requiredRole).toBe(requiredRole);
      }
    });

    it('matches sub-paths under each section', () => {
      const r = matchShellRoute('GET', '/admin/businesses/biz-1');
      expect(r!.section).toBe('businesses');
      const r2 = matchShellRoute('GET', '/admin/operations/op-42/cancel');
      expect(r2!.section).toBe('operations');
    });

    it('returns null for unknown paths', () => {
      expect(matchShellRoute('GET', '/admin/missing')).toBeNull();
      expect(matchShellRoute('GET', '/something/else')).toBeNull();
      expect(matchShellRoute('GET', '/admin/business')).toBeNull();
    });

    it('normalises pathname that does not start with /', () => {
      const r = matchShellRoute('GET', 'admin/businesses');
      expect(r).not.toBeNull();
      expect(r!.section).toBe('businesses');
    });
  });

  describe('deriveRoleFromToken', () => {
    const TOKEN = 'super-secret';

    it('matches the raw token as admin', () => {
      expect(deriveRoleFromToken(TOKEN, TOKEN)).toEqual({ role: 'admin' });
    });

    it('parses role:viewer:<token>, role:operator:<token>, role:admin:<token>', () => {
      expect(deriveRoleFromToken(TOKEN, `role:viewer:${TOKEN}`)).toEqual({ role: 'viewer' });
      expect(deriveRoleFromToken(TOKEN, `role:operator:${TOKEN}`)).toEqual({ role: 'operator' });
      expect(deriveRoleFromToken(TOKEN, `role:admin:${TOKEN}`)).toEqual({ role: 'admin' });
    });

    it('rejects mismatched inner value', () => {
      expect(deriveRoleFromToken(TOKEN, 'role:viewer:wrong')).toBeNull();
    });

    it('rejects invalid role string', () => {
      expect(deriveRoleFromToken(TOKEN, `role:root:${TOKEN}`)).toBeNull();
    });

    it('rejects malformed tokens (no inner colon)', () => {
      expect(deriveRoleFromToken(TOKEN, 'role:viewer')).toBeNull();
    });

    it('rejects empty configured token', () => {
      expect(deriveRoleFromToken('', 'whatever')).toBeNull();
    });
  });

  describe('dispatchShellRequest — auth flow', () => {
    const TOKEN = 'tok';
    const SECRET = 'shh';
    const NOW = 1_700_000_000_000;
    const config = { cookieSecret: SECRET, adminToken: TOKEN, nowMs: () => NOW };

    function req(method: 'GET' | 'POST', pathname: string, body: Record<string, string> = {}, cookies: Record<string, string> = {}) {
      return { method, pathname, body, cookies };
    }

    it('GET /admin/login returns 200 with the login form', () => {
      const out = dispatchShellRequest(req('GET', '/admin/login'), config);
      expect(out.routeId).toBe('admin-login');
      expect(out.response.status).toBe(200);
      expect(out.response.headers['content-type']).toContain('text/html');
      expect(out.response.body).toContain('<form method="POST" action="/admin/login"');
    });

    it('GET / with no cookie returns 401', () => {
      const out = dispatchShellRequest(req('GET', '/admin'), config);
      expect(out.routeId).toBe('admin-root');
      expect(out.response.status).toBe(401);
    });

    it('POST /admin/login with bad token returns 401 with the form (inline error)', () => {
      const out = dispatchShellRequest(
        req('POST', '/admin/login', { token: 'nope', redirect: '/admin' }),
        config,
      );
      expect(out.response.status).toBe(401);
      expect(out.response.body).toContain('Invalid token');
    });

    it('POST /admin/login with good token returns 302 + Set-Cookie', () => {
      const out = dispatchShellRequest(
        req('POST', '/admin/login', { token: TOKEN, redirect: '/admin/businesses' }),
        config,
      );
      expect(out.response.status).toBe(302);
      expect(out.response.headers['location']).toBe('/admin/businesses');
      expect(out.response.headers['set-cookie']).toContain('du_admin=');
      expect(out.response.headers['set-cookie']).toContain('HttpOnly');
      expect(out.response.headers['set-cookie']).toContain('SameSite=Strict');
    });

    it('GET /admin/businesses with a valid viewer cookie returns 200', () => {
      // Mint a viewer cookie via the auth module to drive the dispatch.
      // The shell mints `role:viewer:<TOKEN>` for the viewer role.
      const { signCookie } = require('../src/app/admin/shell-auth');
      const claims = { iss: 'du-admin-shell', role: 'viewer' as const, iat: NOW, exp: NOW + 60_000 };
      const cookie = signCookie(SECRET, claims);
      expect(cookie).not.toBeNull();
      const out = dispatchShellRequest(
        req('GET', '/admin/businesses', {}, { du_admin: cookie }),
        config,
      );
      expect(out.routeId).toBe('section:businesses');
      expect(out.response.status).toBe(200);
      expect(out.response.body).toContain('screen-state--ready');
      expect(out.response.body).toContain('href="/admin/businesses"');
    });

    it('GET /admin/profiles as viewer returns 403', () => {
      const { signCookie } = require('../src/app/admin/shell-auth');
      const cookie = signCookie(SECRET, { iss: 'du-admin-shell', role: 'viewer', iat: NOW, exp: NOW + 60_000 });
      const out = dispatchShellRequest(
        req('GET', '/admin/profiles', {}, { du_admin: cookie }),
        config,
      );
      expect(out.response.status).toBe(403);
      expect(out.response.body).toContain('Access denied');
    });

    it('GET /admin/missing returns 404', () => {
      const out = dispatchShellRequest(req('GET', '/admin/missing'), config);
      expect(out.routeId).toBe('unknown');
      expect(out.response.status).toBe(404);
      expect(out.response.body).toContain('Not found');
    });

    it('GET /favicon.ico returns 204', () => {
      const out = dispatchShellRequest(req('GET', '/favicon.ico'), config);
      expect(out.response.status).toBe(204);
    });

    it('POST /admin/logout returns 302 with Max-Age=0', () => {
      const out = dispatchShellRequest(req('POST', '/admin/logout'), config);
      expect(out.response.status).toBe(302);
      expect(out.response.headers['location']).toBe('/admin/login');
      expect(out.response.headers['set-cookie']).toContain('Max-Age=0');
    });

    it('a cookie signed with the wrong secret is rejected (no claims)', () => {
      const { signCookie } = require('../src/app/admin/shell-auth');
      const cookie = signCookie('wrong', { iss: 'du-admin-shell', role: 'admin', iat: NOW, exp: NOW + 60_000 });
      const out = dispatchShellRequest(
        req('GET', '/admin', {}, { du_admin: cookie }),
        config,
      );
      expect(out.response.status).toBe(401);
    });

    it('a cookie with the wrong issuer is rejected', () => {
      const { signCookie } = require('../src/app/admin/shell-auth');
      // signCookie requires iss='du-admin-shell'; forge by hand.
      const { createHmac } = require('node:crypto');
      const payload = Buffer.from(JSON.stringify({ iss: 'evil', role: 'admin', iat: NOW, exp: NOW + 60_000 }), 'utf8')
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const sig = createHmac('sha256', SECRET).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const cookie = `${payload}.${sig}`;
      const out = dispatchShellRequest(
        req('GET', '/admin', {}, { du_admin: cookie }),
        config,
      );
      expect(out.response.status).toBe(401);
    });
  });
});