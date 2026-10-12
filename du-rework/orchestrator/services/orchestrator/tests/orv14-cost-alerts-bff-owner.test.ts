import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleCostAlertsRoute, matchCostAlertsRoute } from '../src/app/admin/bff/cost-alerts';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { BffRuntimeConfig } from '../src/app/admin/bff/upstream';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SESSION = 'S'.repeat(43);
const CSRF = 'C'.repeat(43);
const OIDC_PRINCIPAL = '99999999-9999-4999-8999-999999999999';

function responseCapture() {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    end(value?: string) { body = value ?? ''; },
  };
  return { res: res as unknown as ServerResponse, headers, body: () => body, status: () => res.statusCode };
}

function localAdminConfig(role: 'admin' | 'operator' = 'admin'): ShellRuntimeConfig {
  return {
    oidcSessions: {
      async get() {
        return {
          sessionId: SESSION,
          issuer: 'du-local',
          sub: USER,
          tenantId: TENANT,
          role,
          csrfToken: CSRF,
          roleVersion: 4,
        };
      },
    },
  } as unknown as ShellRuntimeConfig;
}

function externalAdminConfig(pinned = true): ShellRuntimeConfig {
  return {
    oidcSessions: {
      async get() {
        return {
          sessionId: SESSION,
          issuer: 'https://idp.example.test',
          sub: 'external-user-42',
          tenantId: null,
          role: 'admin',
          csrfToken: CSRF,
          createdAt: Date.parse('2026-10-11T20:00:00.000Z'),
          ...(pinned ? { costAlertPrincipalId: OIDC_PRINCIPAL, costAlertAuthorizationVersion: 3 } : {}),
        };
      },
    },
  } as unknown as ShellRuntimeConfig;
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage;
  Object.assign(request, { method: 'POST', headers: { 'x-csrf-token': CSRF, ...headers } });
  return request;
}

function shellRequest(): AdminShellRequest {
  return { method: 'GET', pathname: '/admin/api/cost-alerts/inbox', cookies: { du_session: SESSION }, body: {} };
}

describe('ORV14 cost alert BFF owner fence', () => {
  test('matches only the declared alert routes and rejects malformed identity paths', () => {
    expect(matchCostAlertsRoute('/cost-alerts')).toEqual({ kind: 'alerts-list' });
    expect(matchCostAlertsRoute('/cost-alerts/channels')).toEqual({ kind: 'channels' });
    expect(matchCostAlertsRoute('/cost-alerts/scope-catalog')).toEqual({ kind: 'scope-catalog' });
    expect(matchCostAlertsRoute('/cost-alerts/bindings')).toEqual({ kind: 'binding-write' });
    expect(matchCostAlertsRoute('/cost-alerts/inbox')).toEqual({ kind: 'inbox-list' });
    expect(matchCostAlertsRoute('/cost-alerts/bindings/33333333-3333-4333-8333-333333333333')).toEqual({
      kind: 'binding-read', budgetId: '33333333-3333-4333-8333-333333333333',
    });
    expect(matchCostAlertsRoute('/cost-alerts/inbox/33333333-3333-4333-8333-333333333333/read')).toEqual({
      kind: 'inbox-read', alertId: '33333333-3333-4333-8333-333333333333',
    });
    expect(matchCostAlertsRoute('/cost-alerts/recipients')).toEqual({ kind: 'recipient-list' });
    expect(matchCostAlertsRoute('/cost-alerts/recipients/self')).toEqual({ kind: 'recipient-self' });
    expect(matchCostAlertsRoute('/cost-alerts/recipients/99999999-9999-4999-8999-999999999999/lifecycle')).toEqual({
      kind: 'recipient-lifecycle', principalId: OIDC_PRINCIPAL,
    });
    expect(matchCostAlertsRoute('/cost-alerts/inbox/%2F/read')).toEqual({ kind: 'invalid' });
    expect(matchCostAlertsRoute('/cost-alerts/other')).toEqual({ kind: 'invalid' });
  });

  test('forwards the active local Admin session proof and fences the inbox to its current tenant', async () => {
    const upstreamCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const runtime: BffRuntimeConfig = {
      jsonBaseUrl: 'http://127.0.0.1:3000',
      adminToken: 'platform-token-for-upstream',
      fetchImpl: async (input, init) => {
        upstreamCalls.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify({ tenantId: TENANT, items: [], limit: 25, hasMore: false, nextCursor: null }), { status: 200 });
      },
    };
    const capture = responseCapture();
    const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;
    await handleCostAlertsRoute(
      req, capture.res, shellRequest(), { kind: 'inbox-list' }, new URLSearchParams(`tenantId=${TENANT}&limit=25`),
      localAdminConfig(), runtime, 'cost-alert-test',
    );
    expect(capture.status()).toBe(200);
    expect(JSON.parse(capture.body())).toMatchObject({ tenantId: TENANT, items: [] });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.url).toBe(`http://127.0.0.1:3000/api/internal/cost-alerts/inbox?tenantId=${TENANT}&limit=25&unreadOnly=false`);
    expect(upstreamCalls[0]?.headers.authorization).toBe('Bearer platform-token-for-upstream');
    expect(upstreamCalls[0]?.headers.cookie).toBe(`du_session=${SESSION}`);
    expect(upstreamCalls[0]?.headers['x-csrf-token']).toBe(CSRF);

    const denied = responseCapture();
    await handleCostAlertsRoute(
      req, denied.res, shellRequest(), { kind: 'inbox-list' }, new URLSearchParams(`tenantId=${TENANT}`),
      localAdminConfig('operator'), runtime, 'cost-alert-test',
    );
    expect(denied.status()).toBe(403);
    expect(upstreamCalls).toHaveLength(1);
  });

  test('fails closed for an external OIDC Admin without a current identity-directory binding', async () => {
    const upstreamCalls: string[] = [];
    const runtime: BffRuntimeConfig = {
      jsonBaseUrl: 'http://127.0.0.1:3000',
      adminToken: 'platform-token-for-upstream',
      fetchImpl: async (input) => {
        upstreamCalls.push(String(input));
        return new Response(JSON.stringify({ tenantId: TENANT, items: [], limit: 25, hasMore: false, nextCursor: null }), { status: 200 });
      },
    };
    const config = {
      oidcSessions: {
        async get() {
          return {
            sessionId: SESSION,
            issuer: 'https://idp.example.test',
            sub: 'external-user-42',
            tenantId: TENANT,
            role: 'admin',
            csrfToken: CSRF,
          };
        },
      },
    } as unknown as ShellRuntimeConfig;
    const capture = responseCapture();
    const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;
    await handleCostAlertsRoute(
      req, capture.res, shellRequest(), { kind: 'inbox-list' }, new URLSearchParams(`tenantId=${TENANT}`),
      config, runtime, 'cost-alert-test',
    );
    expect(capture.status()).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('allows a current external platform Admin to read only its own inbox in an explicit tenant', async () => {
    const upstreamCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const runtime: BffRuntimeConfig = {
      jsonBaseUrl: 'http://127.0.0.1:3000',
      adminToken: 'platform-token-for-upstream',
      fetchImpl: async (input, init) => {
        upstreamCalls.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify({ tenantId: TENANT, items: [], limit: 25, hasMore: false, nextCursor: null }), { status: 200 });
      },
    };
    const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;
    const capture = responseCapture();
    await handleCostAlertsRoute(
      req, capture.res, shellRequest(), { kind: 'inbox-list' }, new URLSearchParams(`tenantId=${TENANT}&limit=25`),
      externalAdminConfig(), runtime, 'cost-alert-test',
    );
    expect(capture.status()).toBe(200);
    expect(upstreamCalls[0]?.url).toBe(`http://127.0.0.1:3000/api/internal/cost-alerts/inbox?tenantId=${TENANT}&limit=25&unreadOnly=false`);
    expect(upstreamCalls[0]?.headers.cookie).toBe(`du_session=${SESSION}`);

    const implicitTenant = responseCapture();
    await handleCostAlertsRoute(
      req, implicitTenant.res, shellRequest(), { kind: 'inbox-list' }, new URLSearchParams('limit=25'),
      externalAdminConfig(), runtime, 'cost-alert-test',
    );
    expect(implicitTenant.status()).toBe(422);
    expect(upstreamCalls).toHaveLength(1);
  });

  test('self registration forwards only an empty body from a verified external platform Admin cookie', async () => {
    const upstreamCalls: Array<{ url: string; headers: Record<string, string>; body: string | undefined }> = [];
    const runtime: BffRuntimeConfig = {
      jsonBaseUrl: 'http://127.0.0.1:3000',
      adminToken: 'platform-token-for-upstream',
      fetchImpl: async (input, init) => {
        upstreamCalls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
        return new Response(JSON.stringify({
          kind: 'oidc', principalId: OIDC_PRINCIPAL, displayName: 'External OIDC Admin · 123ABC4567',
          role: 'ADMIN', state: 'ENABLED', authorizationVersion: 1, lastVerifiedAt: '2026-10-11T20:00:00.000Z', eligible: true,
        }), { status: 200 });
      },
    };
    const capture = responseCapture();
    await handleCostAlertsRoute(
      jsonRequest({}), capture.res, shellRequest(), { kind: 'recipient-self' }, new URLSearchParams(),
      externalAdminConfig(false), runtime, 'cost-alert-test',
    );
    expect(capture.status()).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.url).toBe('http://127.0.0.1:3000/api/internal/cost-alerts/recipients/self');
    expect(upstreamCalls[0]?.body).toBe('{}');
    expect(upstreamCalls[0]?.headers.cookie).toBe(`du_session=${SESSION}`);
    expect(upstreamCalls[0]?.headers['x-csrf-token']).toBe(CSRF);
    expect(upstreamCalls[0]?.url).not.toContain('issuer');
    expect(upstreamCalls[0]?.url).not.toContain('subject');
  });

  test('forwards bounded scope search, keyset cursor, and parent filter through the guided catalog route', async () => {
    const apiKeyId = '44444444-4444-4444-8444-444444444444';
    const upstreamCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const runtime: BffRuntimeConfig = {
      jsonBaseUrl: 'http://127.0.0.1:3000',
      adminToken: 'platform-token-for-upstream',
      fetchImpl: async (input, init) => {
        upstreamCalls.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify({
          tenantId: TENANT, kind: 'profiles', items: [], limit: 50, hasMore: false, nextCursor: null,
        }), { status: 200 });
      },
    };
    const capture = responseCapture();
    const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;
    await handleCostAlertsRoute(
      req, capture.res, shellRequest(), { kind: 'scope-catalog' },
      new URLSearchParams(`tenantId=${TENANT}&kind=profiles&q=invoice+tool&limit=50&cursor=nextPageToken&apiKeyId=${apiKeyId}`),
      localAdminConfig(), runtime, 'cost-alert-test',
    );
    expect(capture.status()).toBe(200);
    expect(upstreamCalls[0]?.url).toBe(
      `http://127.0.0.1:3000/api/internal/cost-alerts/scope-catalog?tenantId=${TENANT}&kind=profiles&q=invoice+tool&limit=50&cursor=nextPageToken&apiKeyId=${apiKeyId}`,
    );
    expect(upstreamCalls[0]?.headers.authorization).toBe('Bearer platform-token-for-upstream');

    const invalid = responseCapture();
    await handleCostAlertsRoute(
      req, invalid.res, shellRequest(), { kind: 'scope-catalog' },
      new URLSearchParams(`tenantId=${TENANT}&kind=profiles&q=invoice&profileId=${apiKeyId}`),
      localAdminConfig(), runtime, 'cost-alert-test',
    );
    expect(invalid.status()).toBe(422);
    expect(upstreamCalls).toHaveLength(1);
  });
});
