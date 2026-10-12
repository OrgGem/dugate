import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createLocalAdminAuth } from '../src/app/admin/local-auth-boot';
import { hashLocalPassword } from '../src/modules/auth/local-primitives';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { Db } from '../src/db/db';

const redisUrl = process.env.ORV12_REDIS_URL ?? 'redis://127.0.0.1:56398';
const username = `local-${randomUUID()}`;
let row: { id: string; password_hash: string; role: string; tenant_id: string | null; version: number; is_enabled: boolean; is_locked: boolean; legacy_password_reset_required: boolean };
let boot: Awaited<ReturnType<typeof createLocalAdminAuth>>, replica: typeof boot;
let shell: ReturnType<typeof createAdminShellServer>;
const audit: unknown[] = [];
const redisPrefix = `orv12-owner:${randomUUID()}:`;
const query = async (sql: string, values: unknown[]) => {
  if (!sql.includes('admin_local_users')) throw new Error('unexpected SQL');
  expect(sql).toContain('legacy_password_reset_required');
  const active = row.is_enabled && !row.is_locked && !row.legacy_password_reset_required;
  const found = active && (sql.includes('username_normalized') ? values[0] === username : values[0] === row.id);
  const sameVerifier = !sql.includes('password_hash=$2') || values[1] === row.password_hash;
  return { rowCount: found && sameVerifier ? 1 : 0, rows: found && sameVerifier ? [row] : [] };
};
beforeAll(async () => {
  row = { id: randomUUID(), password_hash: await hashLocalPassword('Fixture-secret-123!'), role: 'admin', tenant_id: null, version: 1, is_enabled: true, is_locked: false, legacy_password_reset_required: false };
  const options = { db: { query } as unknown as Db, redisUrl, redisKeyPrefix: redisPrefix };
  boot = await createLocalAdminAuth(options); replica = await createLocalAdminAuth(options);
  shell = createAdminShellServer({ port: 0, host: '127.0.0.1', cookieSecret: 'local-test-cookie-secret', adminToken: 'internal-token', localAuth: boot.localAuth, oidcSessions: boot.sessions, securityAudit: event => { audit.push(event); }, cookiePolicy: { requireSecure: false, trustProxyProtocol: false } });
  await shell.listen();
});
afterAll(async () => { await shell?.close(); await Promise.all([boot?.close(), replica?.close()]); });
async function proof() {
  const response = await fetch(`${shell.url}/admin/login`);
  const html = await response.text();
  expect(html).toContain('name="username"'); expect(html).toContain('name="password"');
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; expect(csrf).toBeTruthy();
  return { csrf: csrf!, cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
}
async function login(password = 'Fixture-secret-123!') {
  const p = await proof();
  return fetch(`${shell.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { cookie: p.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, csrf: p.csrf, redirect: '//evil.test/' }) });
}
test('real HTTP local login requires CSRF, authenticates password and mints shared opaque session', async () => {
  const denied = await fetch(`${shell.url}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username, password: 'Fixture-secret-123!' }) });
  expect(denied.status).toBe(403);
  expect((await login('wrong')).status).toBe(401);
  const result = await login(); expect(result.status).toBe(302); expect(result.headers.get('location')).toBe('/admin');
  const sessionCookie = result.headers.getSetCookie().find(c => c.startsWith('du_session='))!;
  expect(sessionCookie).toContain('HttpOnly'); expect(sessionCookie).toContain('SameSite=Strict');
  const id = sessionCookie.split(';')[0]!.slice('du_session='.length);
  expect(await replica.sessions.get(id)).toMatchObject({ issuer: 'du-local', sub: row.id, role: 'admin' });
  const redis = new Redis(redisUrl);
  try { expect((await redis.keys(`${redisPrefix}version:*`)).every(key => !key.includes(id))).toBe(true); } finally { await redis.quit(); }
  const page = await fetch(`${shell.url}/admin`, { headers: { cookie: `du_session=${id}` }, redirect: 'manual' });
  expect(page.status).toBe(200);
  row.version++;
  expect(await replica.sessions.get(id)).toBeNull();
  expect((await fetch(`${shell.url}/admin`, { headers: { cookie: `du_session=${id}` }, redirect: 'manual' })).status).toBe(302);
  expect(JSON.stringify(audit)).not.toContain('Fixture-secret'); expect(JSON.stringify(audit)).not.toContain(id);
});
test('disabled, locked and reset-required identities cannot log in', async () => {
  for (const flag of ['is_locked','legacy_password_reset_required'] as const) {
    row[flag] = true; expect(await boot.localAuth.login(username,'Fixture-secret-123!')).toBeNull(); row[flag] = false;
  }
  row.is_enabled = false; expect(await boot.localAuth.login(username,'Fixture-secret-123!')).toBeNull(); row.is_enabled = true;
  expect(await boot.localAuth.login('!invalid username','Fixture-secret-123!')).toBeNull();
});

test('logout is CSRF guarded and revokes the opaque session on every replica', async () => {
  const session = await boot.localAuth.login(username, 'Fixture-secret-123!'); expect(session).not.toBeNull();
  const headers = { cookie: `du_session=${session!.sessionId}`, 'content-type': 'application/x-www-form-urlencoded' };
  expect((await fetch(`${shell.url}/admin/logout`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams() })).status).toBe(403);
  expect(await replica.sessions.get(session!.sessionId)).not.toBeNull();
  expect((await fetch(`${shell.url}/admin/logout`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ csrf: session!.csrfToken }) })).status).toBe(302);
  expect(await replica.sessions.get(session!.sessionId)).toBeNull();
});
test('failed passwords lock across login replicas while token fallback clears stale opaque cookie', async () => {
  for (let i=0;i<5;i++) expect(await boot.localAuth.login(username, 'wrong')).toBeNull();
  expect(await replica.localAuth.login(username,'Fixture-secret-123!')).toBeNull();
  const p = await proof();
  const response = await fetch(`${shell.url}/admin/login`, { method:'POST', redirect:'manual', headers: { cookie: `${p.cookie}; du_session=stale-session`, 'content-type':'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token:'internal-token', csrf:p.csrf }) });
  expect(response.status).toBe(302);
  expect(response.headers.getSetCookie().some(c=>c.startsWith('du_session=') && c.includes('Max-Age=0'))).toBe(true);
});
