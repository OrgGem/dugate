const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'services/orchestrator/package.json'));
const { Pool } = req('pg');
const { retryOperation } = require(path.join(root, 'services/orchestrator/dist/modules/operations/retry.js'));
const { toOperationView } = require(path.join(root, 'services/orchestrator/dist/modules/operations/facade.js'));
const { createLifecycleService } = require(path.join(root, 'services/orchestrator/dist/modules/lifecycle/lifecycle.js'));
const { createMetadataCrypto } = require(path.join(root, 'services/orchestrator/dist/modules/runtime/metadata-crypto.js'));
const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:15446/request_controls' });
const passed = [];
async function check(name, body) { await body(); passed.push(name); console.log('PASS ' + name); }
async function tx(body) { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await body(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
const tenant = randomUUID(), foreign = randomUUID();
async function seed(input = { mode: 'parse' }, payload = input, state = 'FAILED', crypto) {
  const id = randomUUID(), taskId = randomUUID();
  const sealedInput = crypto ? await crypto.seal(input, { tenantId: tenant, slot: 'operations.input_ref', refId: id }) : input;
  const sealedPayload = crypto ? await crypto.seal(payload, { tenantId: tenant, slot: 'tasks.payload_ref', refId: taskId }) : payload;
  await pool.query(`INSERT INTO operations(id,tenant_id,business_id,business_version,action,state,root_task_id,input_ref,correlation_id) VALUES($1,$2,'document-core','1','ingest',$3,$4,$5,$6)`, [id,tenant,state,taskId,JSON.stringify(sealedInput),randomUUID()]);
  await pool.query(`INSERT INTO tasks(id,operation_id,task_key,kind,payload_ref,state) VALUES($1,$2,'root','root',$3,'FAILED')`, [taskId,id,JSON.stringify(sealedPayload)]);
  return { id, taskId };
}
async function row(id) { return (await pool.query('SELECT * FROM operations WHERE id=$1',[id])).rows[0]; }
(async () => {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'request_controls');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const migrations = fs.readdirSync(path.join(root,'services/orchestrator/migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const file of migrations.filter(f => !f.startsWith('0034'))) await pool.query(fs.readFileSync(path.join(root,'services/orchestrator/migrations',file),'utf8'));
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)',[tenant,'request-controls',foreign,'foreign']);
  const historical = await seed();
  const historicalActive = await seed({}, {}, 'RUNNING');
  await pool.query(fs.readFileSync(path.join(root,'services/orchestrator/migrations/0034_operation_execution_times.sql'),'utf8'));
  await check('historical terminal timestamps remain unknown after maintenance', async () => {
    await pool.query("UPDATE operations SET updated_at=now()+interval '10 days', input_ref='{}' WHERE id=$1",[historical.id]);
    assert.equal((await row(historical.id)).completed_at,null);
    assert.equal(toOperationView(await row(historical.id)).completedAt,null);
  });
  await check('migration does not assign maintenance time as historical RUNNING start', async () => {
    await pool.query('UPDATE operations SET updated_at=now() WHERE id=$1',[historicalActive.id]);
    assert.equal((await row(historicalActive.id)).started_at,null);
    await pool.query("UPDATE operations SET state='RETRY_PENDING' WHERE id=$1",[historicalActive.id]);
    await pool.query("UPDATE operations SET state='RUNNING' WHERE id=$1",[historicalActive.id]);
    assert.equal((await row(historicalActive.id)).started_at,null);
  });
  const operation = await seed({ mode: 'parse' }, { mode: 'parse' }, 'ACCEPTED');
  let start, end;
  await check('first RUNNING records execution start', async () => {
    await pool.query("UPDATE operations SET state='RUNNING', updated_at=now() WHERE id=$1",[operation.id]);
    start=(await row(operation.id)).started_at.toISOString(); assert.ok(start);
  });
  await check('wait/retry cycles preserve first start', async () => {
    await pool.query("UPDATE operations SET state='RETRY_PENDING' WHERE id=$1",[operation.id]);
    await pool.query("UPDATE operations SET state='RUNNING' WHERE id=$1",[operation.id]);
    assert.equal((await row(operation.id)).started_at.toISOString(),start);
  });
  await check('terminal transition records completion', async () => {
    await pool.query("UPDATE operations SET state='FAILED' WHERE id=$1",[operation.id]);
    end=(await row(operation.id)).completed_at.toISOString(); assert.ok(end); assert.ok(end>=start);
  });
  await check('cache cleanup cannot alter completion/start/creation', async () => {
    const before=await row(operation.id);
    await pool.query("UPDATE operations SET updated_at=now()+interval '30 days', input_ref='{}', started_at=now()+interval '20 days', completed_at=now()+interval '20 days', created_at=now() WHERE id=$1",[operation.id]);
    const after=await row(operation.id); assert.equal(after.completed_at.toISOString(),end); assert.equal(after.started_at.toISOString(),start); assert.equal(after.created_at.toISOString(),before.created_at.toISOString());
  });
  await check('terminal operation cannot be reopened', async () => { await assert.rejects(pool.query("UPDATE operations SET state='RUNNING' WHERE id=$1",[operation.id]), /terminal operations are immutable/); });
  const failed = await seed(); let child;
  await check('retry creates linked fresh task and outbox, leaves old timestamps intact', async () => {
    const before=await row(failed.id); child=await tx(c=>retryOperation(c,failed.id,tenant));
    const after=await row(failed.id), fresh=await row(child.operationId);
    assert.notEqual(child.operationId,failed.id); assert.equal(fresh.retry_of,failed.id); assert.equal(fresh.state,'ACCEPTED'); assert.equal(fresh.started_at,null); assert.equal(fresh.completed_at,null); assert.equal(after.completed_at.toISOString(),before.completed_at.toISOString());
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1',[fresh.root_task_id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT attempt FROM tasks WHERE id=$1',[fresh.root_task_id])).rows[0].attempt,0);
  });
  await check('concurrent retry clicks coalesce to one active child', async () => {
    const attempts=await Promise.all([tx(c=>retryOperation(c,failed.id,tenant)),tx(c=>retryOperation(c,failed.id,tenant))]);
    assert.equal(attempts[0].operationId,child.operationId); assert.equal(attempts[1].operationId,child.operationId);
  });
  await check('foreign tenant retry is indistinguishable not-found', async () => { await assert.rejects(tx(c=>retryOperation(c,failed.id,foreign)), e=>e.status===404); });
  await check('active/successful requests cannot be retried', async () => {
    const succeeded=await seed({}, {}, 'SUCCEEDED');
    await assert.rejects(tx(c=>retryOperation(c,succeeded.id,tenant)),e=>e.code==='STATE_CONFLICT');
    await assert.rejects(tx(c=>retryOperation(c,child.operationId,tenant)),e=>e.code==='STATE_CONFLICT');
  });
  await check('expired cached input blocks retry without a child', async () => {
    const artifactId=randomUUID();
    await pool.query("INSERT INTO artifacts(id,tenant_id,purpose,mime_type,state,token,storage_key,storage_version_id,expires_at) VALUES($1,$2,'input','application/pdf','READY','test','input-cache','v1',now()-interval '1 day')",[artifactId,tenant]);
    const expired=await seed({source:{storageKey:'input-cache',versionId:'v1',sha256:'a'.repeat(64),sizeBytes:1,artifactId}});
    await assert.rejects(tx(c=>retryOperation(c,expired.id,tenant)),e=>e.code==='RETRY_INPUT_UNAVAILABLE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE retry_of=$1',[expired.id])).rows[0].n,0);
  });
  await check('pending S3 acquisition retries behind the ingestion gate', async () => {
    const failedSource=await seed({mode:'parse'},{input:{mode:'parse'},sourceUrl:'s3://documents/file.pdf',ingestionState:'PENDING'});
    const fresh=await tx(c=>retryOperation(c,failedSource.id,tenant)); const operation=await row(fresh.operationId);
    assert.equal(operation.state,'PENDING_INGESTION'); const dispatch=(await pool.query('SELECT payload FROM outbox WHERE aggregate_id=$1',[operation.root_task_id])).rows[0].payload;
    assert.equal(dispatch.gate,'ingestion'); assert.equal(dispatch.sourceUrl,'s3://documents/file.pdf');
  });
  await check('encrypted retry rebinds input/task/prompt envelopes to new identities', async () => {
    const deks=new Map(); const crypto=createMetadataCrypto({
      async wrapDek(dek,keyRef){ const wrappedKey=randomUUID();deks.set(wrappedKey,Buffer.from(dek));return {version:1,keyName:keyRef,keyVersion:1,wrappedKey}; },
      async unwrapDek(wrapped){ return Buffer.from(deks.get(wrapped.wrappedKey)); }
    },'test-key');
    const op=await seed({mode:'parse',secret:'private'}, {mode:'parse'}, 'FAILED',crypto);
    const prompts=await crypto.seal([{stepId:'parse',content:'private prompt'}],{tenantId:tenant,slot:'operations.prompt_overrides_ref',refId:op.id});
    await pool.query('UPDATE operations SET prompt_overrides_ref=$2 WHERE id=$1',[op.id,JSON.stringify(prompts)]);
    const fresh=await tx(c=>retryOperation(c,op.id,tenant,crypto)); const r=await row(fresh.operationId);
    assert.equal((await crypto.open(r.input_ref,{tenantId:tenant,slot:'operations.input_ref',refId:r.id})).secret,'private');
    const freshTask=(await pool.query('SELECT payload_ref FROM tasks WHERE id=$1',[r.root_task_id])).rows[0];
    assert.equal((await crypto.open(freshTask.payload_ref,{tenantId:tenant,slot:'tasks.payload_ref',refId:r.root_task_id})).secret,'private');
    await assert.rejects(crypto.open(r.input_ref,{tenantId:tenant,slot:'operations.input_ref',refId:op.id}));
    assert.equal((await crypto.open(r.prompt_overrides_ref,{tenantId:tenant,slot:'operations.prompt_overrides_ref',refId:r.id}))[0].content,'private prompt');
  });
  await check('stop records immutable completion and cancels queued root', async () => {
    const stopped=await seed({}, {}, 'ACCEPTED');await pool.query("UPDATE tasks SET state='READY' WHERE id=$1",[stopped.taskId]);
    const lifecycle=createLifecycleService({query:(...a)=>pool.query(...a),tx}); await lifecycle.cancelOperation(stopped.id,tenant);
    const before=await row(stopped.id);assert.equal(before.state,'CANCELLED');assert.ok(before.completed_at);assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1',[stopped.taskId])).rows[0].state,'CANCELLED');
    await pool.query("UPDATE operations SET updated_at=now()+interval '1 year' WHERE id=$1",[stopped.id]);assert.equal((await row(stopped.id)).completed_at.toISOString(),before.completed_at.toISOString());
  });
  await check('successful request completion survives input cleanup', async () => {
    const success=await seed({}, {}, 'ACCEPTED');
    await pool.query("UPDATE operations SET state='RUNNING' WHERE id=$1",[success.id]);
    await pool.query("UPDATE operations SET state='SUCCEEDED' WHERE id=$1",[success.id]);
    const before=toOperationView(await row(success.id));
    await pool.query("UPDATE operations SET input_ref='{}',updated_at=now()+interval '90 days' WHERE id=$1",[success.id]);
    const after=toOperationView(await row(success.id));assert.equal(after.completedAt,before.completedAt);assert.equal(after.startedAt,before.startedAt);
  });
  await check('real PostgreSQL keyset pages are newest first and reversible', async () => {
    const {parseOperationsListQuery,listOperationsPage}=require(path.join(root,'services/orchestrator/dist/modules/operations/list-query.js'));
    const context={db:{query:(...a)=>pool.query(...a)}};
    const query=cursor=>parseOperationsListQuery(new URLSearchParams({limit:'2',sort:'created_at:desc',...(cursor?{cursor}: {})}));
    const first=await listOperationsPage(context,query(),tenant,toOperationView);
    const second=await listOperationsPage(context,query(first.nextCursor),tenant,toOperationView);
    const previous=await listOperationsPage(context,query(second.prevCursor),tenant,toOperationView);
    assert.deepEqual(previous.items.map(x=>x.id),first.items.map(x=>x.id));
    assert.ok(previous.nextCursor);
    const again=await listOperationsPage(context,query(previous.nextCursor),tenant,toOperationView);
    assert.deepEqual(again.items.map(x=>x.id),second.items.map(x=>x.id));
    assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,4);
    assert.ok(Date.parse(first.items[0].createdAt)>=Date.parse(first.items[1].createdAt));
    assert.ok(Date.parse(first.items[1].createdAt)>=Date.parse(second.items[0].createdAt));
  });
  await check('admin detail projects actual task status and lifecycle timestamps', async () => {
    const {buildAdminOperationDetail}=require(path.join(root,'services/orchestrator/dist/modules/operations/mappers.js'));
    const detail=await buildAdminOperationDetail({db:{query:(...a)=>pool.query(...a)},runtime:{getOperation:row},usage:{project:async()=>({})}},failed.id);
    assert.equal(detail.operation.completedAt,(await row(failed.id)).completed_at.toISOString());assert.equal(detail.tasks[0].id,failed.taskId);
  });
  await check('plaintext JSON string input is preserved instead of reparsed', async () => {
    const old=await seed('text input','text input');const fresh=await tx(c=>retryOperation(c,old.id,tenant));
    assert.equal((await row(fresh.operationId)).input_ref,'text input');
  });
  await check('audited admin retry and idempotency commit once', async () => {
    const { dispatchAdminAction } = require(path.join(root,'services/orchestrator/dist/modules/admin-actions/dispatcher.js'));
    const { createAuditService } = require(path.join(root,'services/orchestrator/dist/modules/audit/audit.js'));
    const db = { query: (...a)=>pool.query(...a), tx };
    const deps={db,audit:createAuditService(db),lifecycle:createLifecycleService(db),correlationId:randomUUID()};
    const old=await seed();const call={action:'operations.retry',params:{operationId:old.id},idempotencyKey:'request-controls-once'};
    const auth={kind:'bearer',principal:{role:'platform'}};
    const first=await dispatchAdminAction(deps,auth,call);const second=await dispatchAdminAction(deps,auth,call);
    assert.equal(first.body.operationId,second.body.operationId);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE resource=$1 AND action='operation.retry'",[`operation:${old.id}`])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE retry_of=$1',[old.id])).rows[0].n,1);
  });
  await check('audit failure rolls back retry task and operation', async () => {
    const { dispatchAdminAction } = require(path.join(root,'services/orchestrator/dist/modules/admin-actions/dispatcher.js'));
    const db={query:(...a)=>pool.query(...a),tx};const old=await seed();
    const deps={db,audit:{record:async()=>{throw new Error('audit unavailable');}},lifecycle:createLifecycleService(db),correlationId:randomUUID()};
    await assert.rejects(dispatchAdminAction(deps,{kind:'bearer',principal:{role:'platform'}},{action:'operations.retry',params:{operationId:old.id}}),/audit unavailable/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE retry_of=$1',[old.id])).rows[0].n,0);
  });
  console.log(JSON.stringify({passed:passed.length,failed:0,namespace:'dedicated container du-request-controls-20261006',tests:passed},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
