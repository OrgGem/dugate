const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '../..');
const { buildEncryptionBootOptions } = require(path.join(root, 'services/orchestrator/dist/modules/encryption/boot-options.js'));
const { PostgresInvocationLedger } = require(path.join(root, 'services/connector/dist/db/repository.js'));
const { createS3PinnedSourceStorage } = require(path.join(root, 'services/orchestrator/dist/modules/operations/ingestion-storage-s3.js'));
let passed = 0;
function pass(name) { passed++; console.log('CONFIRMED ' + name); }
(async () => {
  assert.equal(buildEncryptionBootOptions({ ARTIFACT_STORAGE_BACKEND: 'postgres', NODE_ENV: 'production' }), null);
  pass('production postgres boot accepts both encryption flags absent');
  const request = { contractVersion:'1', invocationId:'audit-only', tenantId:'audit-tenant', operationId:'audit-op', taskId:'audit-task', stepKey:'audit-step', bindingSlot:'test', input:{text:'SYNTHETIC_SENSITIVE_REQUEST'}, deadlineAt:new Date().toISOString() };
  let writes = [];
  const db = {
    transaction: async fn => fn(db),
    query: async (sql, params) => {
      writes.push({sql, params});
      const row = { invocation_id:request.invocationId, tenant_id:request.tenantId, operation_id:request.operationId, task_id:request.taskId, step_key:request.stepKey, input_hash:'hash', request, state:sql.startsWith('INSERT')?'IN_FLIGHT':'SUCCEEDED', result:{ content:'SYNTHETIC_SENSITIVE_RESULT' }, error_code:null, provider_request_id:null, session_ref:null, updated_at:new Date().toISOString() };
      return {rows:[row], rowCount:1};
    }
  };
  const ledger = new PostgresInvocationLedger(db);
  await ledger.claim(request, 'hash');
  assert.ok(writes[0].params[6].includes('SYNTHETIC_SENSITIVE_REQUEST'));
  pass('Connector request reaches JSONB SQL parameters as plaintext');
  writes = [];
  await ledger.complete(request.invocationId, { content:'SYNTHETIC_SENSITIVE_RESULT' });
  assert.ok(writes[0].params[1].includes('SYNTHETIC_SENSITIVE_RESULT'));
  pass('Connector result reaches JSONB SQL parameters as plaintext');
  let captured;
  let bytes;
  const storage = createS3PinnedSourceStorage({bucket:'audit-no-network',db,send:async command => {
    captured=command.input; const chunks=[];
    for await(const chunk of captured.Body) chunks.push(Buffer.from(chunk));
    bytes=Buffer.concat(chunks);
    return {VersionId:'audit-version'};
  }});
  await storage.putVerified({storageKey:'audit-key',body:Readable.from([Buffer.from('SYNTHETIC_SENSITIVE_FILE')]),maxBytes:1024});
  assert.equal(bytes.toString(), 'SYNTHETIC_SENSITIVE_FILE');
  pass('source ingestion S3 PutObject body equals acquired plaintext');
  assert.equal(captured.Metadata, undefined);
  assert.equal(captured.SSEKMSKeyId, undefined);
  pass('source writer supplies neither envelope metadata nor explicit KMS key');
  const {createArtifactService}=require(path.join(root,'services/orchestrator/dist/modules/artifacts/artifacts.js'));
  const taskId='10000000-0000-4000-8000-000000000001';
  const artId='10000000-0000-4000-8000-000000000002';
  const artifactDb={tx:async fn=>fn(artifactDb),query:async sql=> {
    if(sql.includes('FROM tasks')) return {rowCount:1,rows:[{lease_epoch:1,state:'RUNNING',operationId:'audit-op',tenantId:'audit-tenant',submitArtifacts:[],lease_active:true}]};
    if(sql.includes('FROM artifacts')) return {rowCount:1,rows:[{tenantId:'audit-tenant',operationId:'audit-op',taskId,storageKey:'audit-key',storageBackend:'postgres',storageVersionId:'audit-version',sha256:'a'.repeat(64),sizeBytes:23,state:'READY',purpose:'input',expires_at:'2000-01-01T00:00:00Z'}]};
    return {rowCount:1,rows:[]};
  }};
  const grant=await createArtifactService(artifactDb).requestAccess(artId,{taskId,leaseEpoch:1,mode:'read'});
  assert.ok(grant.downloadUrl);
  pass('expired READY artifact still receives a fresh Runtime read grant');
  console.log(`${passed} probes passed: reproductions CONFIRM exposure, not security acceptance. Mock SQL/S3 only; no credentials, real DB, real AWS or user data used.`);
})().catch(error => {console.error(error);process.exitCode=1;});
