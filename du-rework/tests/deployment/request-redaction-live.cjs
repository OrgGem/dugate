// Only runs against a task-owned isolated Compose stack; no shared data cleanup.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const filename = process.env.DU_SMOKE_ENV_FILE;
const project = process.env.DU_SMOKE_PROJECT;
assert.ok(filename && fs.existsSync(filename));
assert.equal(project, 'du-fix-redaction-20261005');
const script = `
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDb } = require('./dist/db/db');
const { createProfileService } = require('./dist/modules/profiles/profiles');
const { createLogger } = require('@du/observability');
(async () => {
 const db = createDb(process.env.DATABASE_URL);
 try {
 const tenant = crypto.randomUUID(), key = crypto.randomUUID(), profile = crypto.randomUUID(), op = crypto.randomUUID();
 const hash = crypto.randomUUID();
 await db.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenant,'privacy-test']);
 await db.query('INSERT INTO api_keys (id,tenant_id,hash,prefix) VALUES ($1,$2,$3,$4)', [key,tenant,hash,'privacy']);
 const service = createProfileService(db);
 const input = { profileId: profile, apiKeyHash: hash, businessId: 'privacy-test', businessVersion: 'v1', action: 'extract', connectorBindings: {} };
 await service.createRevision({ ...input, policy: { requestRedaction: [{ pattern: '[^ ]+@[^ ]+' }] } });
 await service.createRevision({ ...input, policy: { requestRedaction: [{ pattern: '(090)1234567', replacement: '$1*******' }] } });
 await service.createRevision({ ...input, policy: { enabled: true } });
 const row = await db.query('SELECT request_redaction FROM profile_bindings WHERE profile_id=$1 AND revision=3', [profile]);
 assert.deepEqual(row.rows[0].request_redaction, [{ pattern: '(090)1234567', replacement: '$1*******' }]);
 console.log('CHECK persistence');
 const original = { email: 'private@example.com', phone: '0901234567' };
 await db.query('INSERT INTO operations (id,tenant_id,api_key_id,business_id,business_version,action,state,input_ref,profile_id,profile_revision,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [op,tenant,key,'privacy-test','v1','extract','RUNNING',JSON.stringify(original),profile,1,op]);
 const read = async () => {
  const response = await fetch('http://127.0.0.1:3000/api/v1/operations/' + op, { headers: { authorization: 'Bearer ' + process.env.ADMIN_TOKEN } });
  assert.equal(response.status,200); return response.json();
 };
 const view = await read();
 assert.equal(view.requestInput.status,'REDACTED');
 assert.deepEqual(view.requestInput.data,{ email: '[REDACTED]', phone: '090*******' });
 const stored = await db.query('SELECT input_ref FROM operations WHERE id=$1',[op]);
 assert.deepEqual(stored.rows[0].input_ref,original);
 console.log('CHECK historical-http-and-original');
 await service.createRevision({ ...input, policy: { requestRedaction: [] } });
 const cleared = await read();
 assert.deepEqual(cleared.requestInput.data,{ email: '[REDACTED]', phone: original.phone });
 console.log('CHECK clear-with-pinned-protection');
 const logs=[];
 createLogger({service:'privacy-test',sink:{write:line=>logs.push(line)}}).info('worker task completed',{operationId:op,input:original,output:original,freeText:'private@example.com'});
 assert.equal(logs.length,1);
 assert.ok(!logs[0].includes(original.email) && !logs[0].includes(original.phone));
 assert.equal(JSON.parse(logs[0]).operationId,op);
 console.log('CHECK compiled-metadata-logger');
 } finally { await db.close(); }
})().catch(error => { console.error(JSON.stringify({ event:'privacy-test-failed', name:error.name, code:error.code, column:error.column, stackLocations:String(error.stack).split('\\n').slice(1), actual: typeof error.actual === 'number' ? error.actual : undefined })); process.exitCode=1; });
`;
let output;
function run() {
 if (output !== undefined) return output;
 const result = spawnSync('docker', ['compose','--env-file',filename,'-p',project,'exec','-T','orchestrator','node','-'], { input: script, encoding:'utf8', cwd:require('node:path').resolve(__dirname,'../..') });
 assert.equal(result.status,0, result.stderr + result.stdout);
 return output=result.stdout;
}
for (const name of ['persistence','historical-http-and-original','clear-with-pinned-protection','compiled-metadata-logger']) {
 test(name, () => assert.ok(run().includes('CHECK '+name)));
}
