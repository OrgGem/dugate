import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../../orchestrator/services/orchestrator/src/db/db';
import { hashLocalPassword } from '../../../orchestrator/services/orchestrator/src/modules/auth/local-primitives';
import { createTestIsolationContext, assertSafeIsolationConfig } from '../../isolation/namespace';
import { syntheticMetadataKeyProvider } from '../isolation';

const runId = `orv14_vfy_identity_${Date.now()}_${randomUUID().slice(0, 8)}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';
const isolation = createTestIsolationContext({ runId, baseArtifactPath: 'tests/workflow-api/orv14-vfy/identity-artifacts' });
const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
const redisUrl = isolation.getRedisUrl(baseRedisUrl);
assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

const baseDb = createDb(baseDatabaseUrl);
const tenantId = randomUUID();
const adminToken = `orv14-vfy-identity-admin-${randomUUID()}`;
const cookieSecret = `orv14-vfy-identity-cookie-${randomUUID()}-synthetic-only`;
const invocationGrantSecret = `orv14-vfy-identity-grant-${randomUUID()}`;
const previousAdminWeb = process.env.DU_ADMIN_WEB;
const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
let appA: App | undefined;
let appB: App | undefined;
let appC: App | undefined;
let shellUrlA = '';
let shellUrlB = '';
let internalUrl = '';
let schemaCreated = false;

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startReplica(options: { localAuth?: boolean; oidcOnly?: boolean } = {}): Promise<{ app: App; internalUrl: string; shellUrl: string }> {
  const internalPort = await availablePort();
  const replica = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort,
    databaseUrl, redisUrl, autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, adminLocalAuthEnabled: options.localAuth ?? true,
    ...(options.oidcOnly ? { adminIdentityAuth: { mode: 'oidc', localEnabled: false, oidc: null } } : {}),
    adminShellCookieSecret: cookieSecret,
    adminShellHost: '127.0.0.1', adminShellPort: 0, jsonBaseUrl: `http://127.0.0.1:${internalPort}`,
    invocationGrantSecret,
    metadataEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: runId },
  });
  await replica.listen();
  const address = replica.internalServer.address();
  if (!address || typeof address === 'string') throw new Error('ORV14 identity fixture internal server did not bind');
  return { app: replica, internalUrl: `http://127.0.0.1:${address.port}`, shellUrl: replica.adminShell!.url };
}

async function seedLocalUser(input: {
  id?: string;
  username: string;
  role?: 'admin' | 'operator' | 'viewer';
  enabled?: boolean;
  locked?: boolean;
  resetRequired?: boolean;
  passwordHash: string;
}): Promise<string> {
  if (!appA) throw new Error('identity fixture is not initialized');
  const id = input.id ?? randomUUID();
  await appA.db.query(
    `INSERT INTO admin_local_users
      (id,tenant_id,username_normalized,password_hash,role,is_enabled,is_locked,version,legacy_password_reset_required)
     VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)`,
    [id, tenantId, input.username.toLowerCase(), input.passwordHash, input.role ?? 'operator', input.enabled ?? true,
      input.locked ?? false, input.resetRequired ?? false],
  );
  return id;
}

async function resetPassword(userId: string, password: string, expectedVersion: number): Promise<Response> {
  return fetch(`${internalUrl}/api/internal/parity/identity/users/${encodeURIComponent(userId)}/password?tenantId=${encodeURIComponent(tenantId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password, expectedVersion }),
  });
}

async function updateIdentity(userId: string, enabled: boolean, expectedVersion: number): Promise<Response> {
  return fetch(`${internalUrl}/api/internal/parity/identity/users/${encodeURIComponent(userId)}?tenantId=${encodeURIComponent(tenantId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'ADMIN', enabled, expectedVersion }),
  });
}

async function localLogin(shellUrl: string, username: string, password: string): Promise<{ response: Response; cookie: string | null }> {
  const page = await fetch(`${shellUrl}/admin/login`, { redirect: 'manual' });
  const html = await page.text();
  const csrf = /<input[^>]*name="csrf"[^>]*value="([^"]+)"/.exec(html)?.[1];
  const localCookie = /(?:^|[,;]\s*)du_local_login=([^;,\s]+)/.exec(page.headers.get('set-cookie') ?? '')?.[1];
  if (!csrf || !localCookie) throw new Error('local login form did not provide its CSRF cookie and proof');
  const response = await fetch(`${shellUrl}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `du_local_login=${localCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, csrf, redirect: '/admin' }),
  });
  const sessionCookie = /(?:^|[,;]\s*)du_session=([^;,\s]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  return { response, cookie: sessionCookie ? `du_session=${sessionCookie}` : null };
}

async function identityBff(shellUrl: string, cookie: string): Promise<Response> {
  return fetch(`${shellUrl}/admin/api/identity/users?tenantId=${encodeURIComponent(tenantId)}`, { headers: { cookie } });
}

beforeAll(async () => {
  process.stdout.write(`ORV14_VFY_NAMESPACE suite=identity runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${isolation.redisPrefix} queuePrefix=${isolation.queuePrefix} artifactDir=${isolation.artifactDir}\n`);
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = 'tests/workflow-api/orv14-vfy/no-bundle';
  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  const replicaA = await startReplica();
  appA = replicaA.app;
  shellUrlA = replicaA.shellUrl;
  internalUrl = replicaA.internalUrl;
  const replicaB = await startReplica();
  appB = replicaB.app;
  shellUrlB = replicaB.shellUrl;
  await appA.db.query('INSERT INTO tenants(id,name,state) VALUES($1,$2,\'ACTIVE\')', [tenantId, 'ORV14 local identity tenant']);
});

afterAll(async () => {
  await appC?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  await appB?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  await appA?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  if (schemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`);
  await baseDb.close();
  isolation.cleanupArtifactDir();
  if (previousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = previousAdminWeb;
  if (previousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = previousAdminWebDist;
});

describe('ORV14 source-independent legacy local identity reset and replica session revocation', () => {
  test('staged legacy reset, ordinary disabled reset, locked/stale/foreign negatives and shared two-replica login verifier', async () => {
    const initialPassword = `orv14-vfy-initial-${randomUUID()}-synthetic`;
    const initialHash = await hashLocalPassword(initialPassword);
    const pendingId = await seedLocalUser({ username: `pending-${randomUUID()}`, role: 'admin', enabled: false, resetRequired: true, passwordHash: initialHash });
    const lockedId = await seedLocalUser({ username: `locked-${randomUUID()}`, enabled: false, locked: true, resetRequired: true, passwordHash: initialHash });
    const disabledId = await seedLocalUser({ username: `disabled-${randomUUID()}`, enabled: false, passwordHash: initialHash });
    const ordinaryAdminId = await seedLocalUser({ username: `normal-admin-${randomUUID()}`, role: 'admin', passwordHash: initialHash });
    const pendingUsername = (await appA!.db.query<{ username_normalized: string }>('SELECT username_normalized FROM admin_local_users WHERE id=$1', [pendingId])).rows[0]!.username_normalized;
    const normalUsername = (await appA!.db.query<{ username_normalized: string }>('SELECT username_normalized FROM admin_local_users WHERE id=$1', [ordinaryAdminId])).rows[0]!.username_normalized;
    const newPendingPassword = `orv14-vfy-reset-${randomUUID()}-synthetic`;
    const newNormalPassword = `orv14-vfy-rotate-${randomUUID()}-synthetic`;

    const pendingBeforeReset = await localLogin(shellUrlA, pendingUsername, initialPassword);
    expect(pendingBeforeReset.response.status).toBe(401);
    expect(pendingBeforeReset.cookie).toBeNull();

    const attemptedEnable = await updateIdentity(pendingId, true, 1);
    expect(attemptedEnable.status).toBe(409);
    const heldPending = await appA!.db.query<{ is_enabled: boolean; legacy_password_reset_required: boolean; version: number }>(
      'SELECT is_enabled,legacy_password_reset_required,version FROM admin_local_users WHERE id=$1', [pendingId],
    );
    expect(heldPending.rows[0]).toMatchObject({ is_enabled: false, legacy_password_reset_required: true, version: 1 });

    const resetPending = await resetPassword(pendingId, newPendingPassword, 1);
    expect(resetPending.status).toBe(200);
    const resetPendingBody = await resetPending.json() as { user: Record<string, unknown> };
    expect(resetPendingBody.user).toMatchObject({ enabled: true, locked: false, legacyPasswordResetRequired: false, version: 2 });
    expect(JSON.stringify(resetPendingBody)).not.toMatch(/password_hash|passwordHash|secret|session/i);
    const pendingState = await appA!.db.query<{ is_enabled: boolean; is_locked: boolean; legacy_password_reset_required: boolean; version: number }>(
      'SELECT is_enabled,is_locked,legacy_password_reset_required,version FROM admin_local_users WHERE id=$1', [pendingId],
    );
    expect(pendingState.rows[0]).toMatchObject({ is_enabled: true, is_locked: false, legacy_password_reset_required: false, version: 2 });

    const staleReset = await resetPassword(pendingId, `orv14-vfy-stale-${randomUUID()}-synthetic`, 1);
    expect(staleReset.status).toBe(409);
    expect((await appA!.db.query<{ version: number }>('SELECT version FROM admin_local_users WHERE id=$1', [pendingId])).rows[0]?.version).toBe(2);

    const lockedReset = await resetPassword(lockedId, `orv14-vfy-locked-${randomUUID()}-synthetic`, 1);
    expect(lockedReset.status).toBe(409);
    const lockedState = await appA!.db.query<{ is_enabled: boolean; is_locked: boolean; legacy_password_reset_required: boolean; version: number }>(
      'SELECT is_enabled,is_locked,legacy_password_reset_required,version FROM admin_local_users WHERE id=$1', [lockedId],
    );
    expect(lockedState.rows[0]).toMatchObject({ is_enabled: false, is_locked: true, legacy_password_reset_required: true, version: 1 });

    const disabledPassword = `orv14-vfy-disabled-${randomUUID()}-synthetic`;
    const disabledReset = await resetPassword(disabledId, disabledPassword, 1);
    expect(disabledReset.status).toBe(200);
    const disabledState = await appA!.db.query<{ is_enabled: boolean; legacy_password_reset_required: boolean; version: number }>(
      'SELECT is_enabled,legacy_password_reset_required,version FROM admin_local_users WHERE id=$1', [disabledId],
    );
    expect(disabledState.rows[0]).toMatchObject({ is_enabled: false, legacy_password_reset_required: false, version: 2 });
    const disabledLogin = await localLogin(shellUrlA,
      (await appA!.db.query<{ username_normalized: string }>('SELECT username_normalized FROM admin_local_users WHERE id=$1', [disabledId])).rows[0]!.username_normalized,
      disabledPassword);
    expect(disabledLogin.response.status).toBe(401);
    expect(disabledLogin.cookie).toBeNull();

    const absentLocalUser = await resetPassword(randomUUID(), `orv14-vfy-absent-${randomUUID()}-synthetic`, 1);
    expect(absentLocalUser.status).toBe(404);

    const oidcReplica = await startReplica({ localAuth: false, oidcOnly: true });
    appC = oidcReplica.app;
    const oidcModeReset = await fetch(`${oidcReplica.internalUrl}/api/internal/parity/identity/users/${encodeURIComponent(ordinaryAdminId)}/password?tenantId=${encodeURIComponent(tenantId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password: `orv14-vfy-oidc-denied-${randomUUID()}-synthetic`, expectedVersion: 1 }),
    });
    expect(oidcModeReset.status).toBe(409);
    expect(await oidcModeReset.json()).toMatchObject({ code: 'LOCAL_AUTH_DISABLED' });
    await appC.close({ timeoutMs: 0, pollIntervalMs: 10 });
    appC = undefined;

    const pendingAfterReset = await localLogin(shellUrlB, pendingUsername, newPendingPassword);
    expect(pendingAfterReset.response.status).toBe(302);
    expect(pendingAfterReset.cookie).toMatch(/^du_session=/);
    const pendingBff = await identityBff(shellUrlB, pendingAfterReset.cookie!);
    expect(pendingBff.status).toBe(200);
    expect(await pendingBff.text()).toContain(pendingId);

    const loggedIn = await localLogin(shellUrlA, normalUsername, initialPassword);
    expect(loggedIn.response.status).toBe(302);
    expect(loggedIn.cookie).toMatch(/^du_session=/);
    expect((await identityBff(shellUrlA, loggedIn.cookie!)).status).toBe(200);
    expect((await identityBff(shellUrlB, loggedIn.cookie!)).status).toBe(200);

    const rotate = await resetPassword(ordinaryAdminId, newNormalPassword, 1);
    expect(rotate.status).toBe(200);
    expect((await identityBff(shellUrlA, loggedIn.cookie!)).status).toBe(401);
    expect((await identityBff(shellUrlB, loggedIn.cookie!)).status).toBe(401);
    expect((await localLogin(shellUrlB, normalUsername, initialPassword)).response.status).toBe(401);

    const currentLogin = await localLogin(shellUrlB, normalUsername, newNormalPassword);
    expect(currentLogin.response.status).toBe(302);
    expect(currentLogin.cookie).toMatch(/^du_session=/);
    const currentBff = await identityBff(shellUrlA, currentLogin.cookie!);
    expect(currentBff.status).toBe(200);
    expect(await currentBff.text()).toContain(ordinaryAdminId);
    expect((await identityBff(shellUrlB, currentLogin.cookie!)).status).toBe(200);
  });
});
