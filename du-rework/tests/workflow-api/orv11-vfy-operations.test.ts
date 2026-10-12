import { createLifecycleService } from '../../orchestrator/services/orchestrator/src/modules/lifecycle/lifecycle';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { createMemorySessionRepository, createSessionStore } from '../../orchestrator/services/orchestrator/src/modules/auth/session-store';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';
const isolation = createWorkflowApiIsolation();
const baseDb = createDb(isolation.baseDatabaseUrl);
const sessions = createSessionStore({ repo: createMemorySessionRepository() });
const tenant = randomUUID();
const foreignTenant = randomUUID();
const ownerKey = `orv11-owner-${randomUUID()}`;
const otherKey = `orv11-other-${randomUUID()}`;
const foreignKey = `orv11-foreign-${randomUUID()}`;
const adminToken = `orv11-admin-${randomUUID()}`;
const operationId = randomUUID();
let app: App | undefined;
let publicUrl = '';
let internalUrl = '';
let schemaCreated = false;
beforeAll(async () => {
  process.env.DU_SEED_DEV_FALLBACK = 'false';
  await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
  schemaCreated = true;
  app = await createApp({ host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: 0,
    databaseUrl: isolation.databaseUrl, redisUrl: isolation.redisUrl, autoMigrate: true,
    autoDispatch: false, leaseRecoveryIntervalMs: 0, adminToken, adminSessionStore: sessions,
    metadataEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: 'du-orch-metadata-v1' } });
  const server = await app.listen();
  publicUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  internalUrl = `http://127.0.0.1:${(app.internalServer.address() as AddressInfo).port}`;
  await app.db.query('INSERT INTO tenants (id,name) VALUES ($1,$2),($3,$4)', [tenant,'ORV11 owner',foreignTenant,'ORV11 other']);
  let ownerId = '';
  for (const [key, tenantId] of [[ownerKey, tenant], [otherKey, tenant], [foreignKey, foreignTenant]]) {
    const inserted = await app.db.query<{ id: string }>('INSERT INTO api_keys (tenant_id,hash,prefix,status) VALUES ($1,$2,$3,\'ACTIVE\') RETURNING id', [tenantId, createHash('sha256').update(key!).digest('hex'), 'orv11']);
    if (key === ownerKey) ownerId = inserted.rows[0]!.id;
  }
  await app.db.query(`INSERT INTO operations (id,tenant_id,api_key_id,business_id,business_version,action,state,correlation_id,output_content,output_format) VALUES ($1,$2,$3,'document-core','1.0.0','extract','SUCCEEDED','orv11-vfy','historical-result-bytes','txt')`, [operationId,tenant,ownerId]);
}, 120000);
afterAll(async () => {
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  if (schemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
  await baseDb.close();
  isolation.context.cleanupArtifactDir();
}, 30000);
const headersFor = (identity: string): Record<string, string> => identity === 'admin' ? { authorization: `Bearer ${adminToken}` } : { 'x-api-key': identity };

test.each(['key', 'admin'])('public retired controls deny %s with 404', async (identity) => {
  const headers = headersFor(identity === 'key' ? ownerKey : identity);
  for (const [method, path] of [['GET',''],['GET','/metrics'],['GET',`/${operationId}/result`],['POST',`/${operationId}/cancel`],['POST',`/${operationId}/resume`],['POST',`/${operationId}/retry`],['DELETE',`/${operationId}`]]) {
    const response = await fetch(`${publicUrl}/api/v1/operations${path}`, { method, headers });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
  }
});
test('public own-key history result and exact download bytes, same-tenant and cross-tenant keys denied', async () => {
  for (const suffix of ['', '/download']) {
    const own = await fetch(`${publicUrl}/api/v1/operations/${operationId}${suffix}`, { headers: headersFor(ownerKey) });
    expect(own.status).toBe(200);
    const content = await own.text();
    if (suffix) expect(content).toBe('historical-result-bytes');
    else expect(content).toContain('historical-result-bytes');
    for (const key of [otherKey, foreignKey]) {
      const denied = await fetch(`${publicUrl}/api/v1/operations/${operationId}${suffix}`, { headers: headersFor(key) });
      expect(denied.status).toBe(404);
    }
    const admin = await fetch(`${publicUrl}/api/v1/operations/${operationId}${suffix}`, { headers: headersFor('admin') });
    expect(admin.status).toBe(404);
  }
});
test('internal read only on internal listener and only with admin credentials', async () => {
  const path = `/api/internal/operations/${operationId}`;
  expect((await fetch(publicUrl + path, { headers: headersFor('admin') })).status).toBe(404);
  expect((await fetch(internalUrl + path, { headers: headersFor(ownerKey) })).status).toBe(401);
  expect((await fetch(internalUrl + path, { headers: headersFor('admin') })).status).toBe(200);
  expect((await fetch(`${internalUrl}/api/internal/operations?tenantId=${tenant}`, { headers: headersFor('admin') })).status).toBe(200);
});
test('internal sessions enforce tenant, viewer mutation denial and CSRF', async () => {
  const operator = await sessions.create({ issuer: 'orv11', sub: 'operator', role: 'operator', tenantId: tenant });
  const foreignOperator = await sessions.create({ issuer: 'orv11', sub: 'foreign', role: 'operator', tenantId: foreignTenant });
  const viewer = await sessions.create({ issuer: 'orv11', sub: 'viewer', role: 'viewer', tenantId: tenant });
  const route = `${internalUrl}/api/internal/operations/${operationId}`;
  expect((await fetch(route, { headers: { cookie: `du_session=${operator.sessionId}` } })).status).toBe(200);
  expect((await fetch(route, { headers: { cookie: `du_session=${foreignOperator.sessionId}` } })).status).toBe(404);
  expect((await fetch(route, { method: 'DELETE', headers: { cookie: `du_session=${operator.sessionId}` } })).status).toBe(403);
  expect((await fetch(route, { method: 'DELETE', headers: { cookie: `du_session=${viewer.sessionId}`, 'x-csrf-token': viewer.csrfToken } })).status).toBe(403);
  expect((await fetch(route, { method: 'DELETE', headers: { cookie: `du_session=${operator.sessionId}`, 'x-csrf-token': operator.csrfToken } })).status).toBe(200);
  expect((await fetch(`${publicUrl}/api/v1/operations/${operationId}`, { headers: headersFor(ownerKey) })).status).toBe(404);
  const audit = await app!.db.query("SELECT action FROM admin_audit_events WHERE action='operation.delete'");
  expect(audit.rowCount).toBe(1);
});


test.each(['paused contention', 'expired exhausted lease'])('real PG cancellation recovery: %s', async (scenario) => {
  const id=randomUUID(), taskId=randomUUID();
  await app!.db.query(`INSERT INTO operations (id,tenant_id,business_id,business_version,action,state,correlation_id,callback_url) VALUES ($1,$2,'document-core','1.0.0','extract',$3,'orv11-cancel','https://example.invalid/callback')`,[id,tenant,scenario==='paused contention'?'WAITING_INPUT':'RUNNING']);
  await app!.db.query(`INSERT INTO tasks(id,operation_id,task_key,kind,state,attempt,max_attempts,lease_expires_at) VALUES($1,$2,'root','document-core',$3,3,3,$4)`,[taskId,id,scenario==='paused contention'?'WAITING_INPUT':'RUNNING',scenario==='paused contention'?null:new Date(Date.now()+60000)]);
  await app!.db.query(`INSERT INTO human_waits(operation_id,task_id,wait_key,wait_id,input_schema,expires_at) VALUES($1,$2,'review',$3,'{}',now()+interval '1 hour')`,[id,taskId,randomUUID()]);
  const lock=await app!.db.pool.connect();
  try{
    if(scenario==='paused contention'){await lock.query('BEGIN');await lock.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);}
    const response=await fetch(`${internalUrl}/api/internal/operations/${id}/cancel`,{method:'POST',headers:headersFor('admin')});
    expect(response.status).toBe(200);
    expect((await app!.db.query('SELECT state FROM operations WHERE id=$1',[id])).rows[0].state).toBe('CANCEL_REQUESTED');
  }finally{await lock.query('ROLLBACK');lock.release();}
  if(scenario==='expired exhausted lease')await app!.db.query("UPDATE tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[taskId]);
  const lifecycle=createLifecycleService(app!.db);
  expect(await lifecycle.sweepCancellations!(50)).toBe(1);
  expect(await lifecycle.sweepCancellations!(50)).toBe(0);
  expect((await app!.db.query('SELECT state FROM operations WHERE id=$1',[id])).rows[0].state).toBe('CANCELLED');
  expect((await app!.db.query('SELECT state FROM tasks WHERE id=$1',[taskId])).rows[0].state).toBe('CANCELLED');
  expect((await app!.db.query('SELECT status FROM human_waits WHERE operation_id=$1',[id])).rows[0].status).toBe('CANCELLED');
  expect((await app!.db.query('SELECT count(*)::int AS count FROM webhook_deliveries WHERE operation_id=$1',[id])).rows[0].count).toBe(1);
},30000);
