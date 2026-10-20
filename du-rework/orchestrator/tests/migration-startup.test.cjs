'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { waitForDatabase } = require(path.join(root,'scripts/docker-wait-for-db.cjs'));
test('readiness retries transient failures and closes clients', async()=>{
 let attempts=0,closed=0;
 class Client {async connect(){if(++attempts===1)throw Object.assign(new Error('private URL'),{code:'ECONNREFUSED'});} async query(){} async end(){closed++;}}
 await waitForDatabase({Client,connectionString:'fixture',pause:async()=>{}});
 assert.equal(attempts,2); assert.equal(closed,2);
});
test('readiness fails immediately for credentials and never exposes them',async()=>{
 let attempts=0;
 class Client {async connect(){attempts++;throw Object.assign(new Error('secret'),{code:'28P01'});} async end(){}}
 await assert.rejects(waitForDatabase({Client,connectionString:'fixture',pause:async()=>{}}),e=>!e.message.includes('secret'));
 assert.equal(attempts,1);
});
test('readiness has a bounded timeout',async()=>{
 class Client {async connect(){throw new Error('private URL');} async end(){}}
 await assert.rejects(waitForDatabase({Client,connectionString:'fixture',timeoutMs:0}),/timed out/);
});
for(const service of ['orchestrator','connector']) test(`${service} image gates server on migration and has explicit false bypass`,()=>{
 const script=fs.readFileSync(path.join(root,`scripts/docker-${service}-entrypoint.sh`),'utf8');
 assert.ok(script.indexOf('du-wait-for-db.cjs')<script.indexOf('migrate-cli.js migrate'));
 assert.match(script,/false\) ;;/); assert.match(script,/DU_MIGRATION_ENABLED:-true/); assert.match(script,/exit 64/);
 const dockerfile=fs.readFileSync(path.join(root,`services/${service}/Dockerfile`),'utf8');
 assert.match(dockerfile,/ENV DU_MIGRATION_ENABLED=true/); assert.match(dockerfile,/scripts\/docker-wait-for-db.cjs/);
});
