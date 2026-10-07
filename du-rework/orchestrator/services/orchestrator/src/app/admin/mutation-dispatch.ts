/**
 * mutation-dispatch - extracted from shell-router.ts by CONV-12.
 *
 * Declarations moved VERBATIM: no behaviour change, no signature change.
 * Shared types and pure query helpers live in ./shell-router-shared, which imports
 * nothing from this directory, so no module here imports shell-router.ts back - the
 * split adds no cycle. shell-router.ts re-exports every moved public name, so
 * server.ts, shell-server.ts, index.ts and the tests are untouched.
 */
import type { AdminCookieClaims, AdminShellResponse } from './shell-types';
import type { AdminShellRequest } from './shell-types';
import { SESSION_COOKIE_NAME, verifySessionCsrf, type SessionRecord } from '../../modules/auth/session-store';
import { deriveCsrfToken, validateCsrfToken } from '../../modules/admin-actions/rbac';
import {
  renderErrorPage,
  renderLoginPage,
  renderShell,
} from './shell-render';
import type { ShellRuntimeConfig } from './shell-router-shared';


export async function csrfTokenForRequest(request: AdminShellRequest, config: ShellRuntimeConfig): Promise<string> {
  const sessionId = request.cookies[SESSION_COOKIE_NAME];
  if (config.oidcSessions && sessionId) {
    return (await config.oidcSessions.get(sessionId))?.csrfToken ?? '';
  }
  const cookie = request.cookies['du_admin'];
  return cookie && config.cookieSecret ? deriveCsrfToken(config.cookieSecret, cookie) : '';
}

export async function handleAdminMutationPost(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  claims: AdminCookieClaims | null,
  oidcCsrfToken?: string,
): Promise<{ routeId: string; response: AdminShellResponse } | null> {
  if (request.method !== 'POST') return null;
  const issue = request.pathname === '/admin/api-keys/new';
  const revokeMatch = /^\/admin\/api-keys\/([^/]+)\/revoke$/.exec(request.pathname);
  const connectorMatch = /^\/admin\/connectors\/([^/]+)\/revisions\/(\d+)\/(test|rotate-secret)$/.exec(request.pathname);
  if (!issue && !revokeMatch && !connectorMatch) return null;
  const fail = (status: number, title: string, message: string) => ({
    routeId: 'admin-mutation',
    response: {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: renderErrorPage({ status, title, message }),
    },
  });
  if (!claims) return fail(401, 'Sign-in required', 'Sign in to manage API keys.');
  if (claims.role !== 'admin') return fail(403, 'Access denied', 'Administrator role is required.');
  const csrfOk = oidcCsrfToken !== undefined
    ? verifySessionCsrf({ csrfToken: oidcCsrfToken } as SessionRecord, request.body['csrf'])
    : validateCsrfToken({
        secret: config.cookieSecret,
        sessionCookie: request.cookies['du_admin'],
        provided: request.body['csrf'],
      });
  if (!csrfOk) return fail(403, 'Request rejected', 'Missing or invalid CSRF proof. Reload the page and try again.');
  if (!config.adminAction) return fail(503, 'Not available', 'Admin actions are not configured.');
  const tenantId = (request.body['tenantId'] ?? '').trim();
  if (issue && (!tenantId || tenantId.length > 64)) {
    return fail(422, 'Invalid request', 'Enter a tenant ID of at most 64 characters.');
  }
  const rotate = connectorMatch?.[3] === 'rotate-secret';
  if (rotate && (!request.body['mount'] || !request.body['path'] || !request.body['key'] || !request.body['value'])) {
    return fail(422, 'Invalid request', 'Vault mount, path, key and new value are required.');
  }
  try {
    const result = await config.adminAction(
      issue ? 'apikey.issue' : revokeMatch ? 'apikey.revoke' : rotate ? 'connectors.rotate_credential' : 'connectors.test_credential',
      issue ? { tenantId } : revokeMatch
        ? { apiKeyId: decodeURIComponent(revokeMatch[1]!) }
        : rotate
          ? { connectorId: decodeURIComponent(connectorMatch![1]!), mount: request.body['mount'], path: request.body['path'], key: request.body['key'], value: request.body['value'] }
          : { connectorId: decodeURIComponent(connectorMatch![1]!) },
    );
    if (result.status < 200 || result.status >= 300) {
      return fail(result.status >= 400 && result.status < 500 ? result.status : 503, 'Action failed', 'The API key change could not be saved.');
    }
    if (!issue && connectorMatch?.[3] === 'test') {
      const ok = result.body.ok === true;
      return {
        routeId: 'admin-mutation',
        response: {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Connector readiness</title><main><h1>Connector readiness</h1><p>' + (ok ? 'Connector service is ready.' : 'Connector service is unavailable.') + '</p><a href="/admin/connectors?connectorId=' + encodeURIComponent(decodeURIComponent(connectorMatch[1]!)) + '">Return to connector</a></main></html>',
        },
      };
    }
    if (!issue) {
      return {
        routeId: 'admin-mutation',
        response: {
          status: 303,
          headers: { location: revokeMatch ? '/admin/api-keys' : '/admin/connectors?connectorId=' + encodeURIComponent(decodeURIComponent(connectorMatch![1]!)), 'cache-control': 'no-store' },
          body: '',
        },
      };
    }
    const rawKey = result.body.rawKey;
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      return fail(503, 'Action failed', 'The issued key was not returned.');
    }
    const escaped = rawKey.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return {
      routeId: 'admin-mutation',
      response: {
        status: 201,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
        body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>API key issued</title><main><h1>API key issued</h1><p>Copy this value now. It cannot be retrieved again.</p><output><code>' + escaped + '</code></output><p><a href="/admin/api-keys">Return to API keys</a></p></main></html>',
      },
    };
  } catch {
    return fail(503, 'Action failed', 'The API key service is unavailable.');
  }
}
