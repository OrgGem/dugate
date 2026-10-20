'use strict';
const {spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const root=process.env.DU_MIGRATION_FIXTURE_ROOT;
assert.ok(root, 'Set DU_MIGRATION_FIXTURE_ROOT to disposable fixture directory');
fs.writeFileSync(root+'/migration-fixture/server-ready.cjs',"console.log('SERVER_READY');\n");
fs.writeFileSync(root+'/migration-fixture/fail-migration.cjs',"console.error('FIXTURE_MIGRATION_FAILED');process.exit(42);\n");
for(const service of ['orchestrator','connector']) {
 const image=`${process.env.DU_MIGRATION_IMAGE_PREFIX || 'du-external-prep'}-${service}:${process.env.DU_MIGRATION_IMAGE_TAG || '33a64dc-auto-migration'}`;
 const server=service==='orchestrator'?'main':'entrypoint';
 const common=['run','--rm','--network',`container:${process.env.DU_MIGRATION_TEST_PG}`,'--mount',`type=bind,source=${root}/migration-fixture/server-ready.cjs,target=/app/dist/${server}.js,readonly`];
 function run(args){return spawnSync('docker',[...common,...args,image],{encoding:'utf8',timeout:120000});}
 let result=run(['-e','DU_MIGRATION_ENABLED=false','-e','DATABASE_URL=postgresql://unreachable.invalid/ignored']); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/SERVER_READY/); assert.doesNotMatch(result.stdout,/migration/);
 result=run(['-e','DU_MIGRATION_ENABLED=typo']); assert.equal(result.status,64); assert.doesNotMatch(result.stdout,/SERVER_READY/);
 const db=service==='orchestrator'?'migration_test_orchestrator':'migration_test_connector';
 result=run(['-e','DU_MIGRATION_ENABLED=true','-e',`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/${db}`]); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/SERVER_READY/);
 result=run(['-e','DU_MIGRATION_ENABLED=true','-e',`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/${db}`,'--mount',`type=bind,source=${root}/migration-fixture/fail-migration.cjs,target=/app/dist/migrate-cli.js,readonly`]); assert.equal(result.status,42,result.stderr); assert.doesNotMatch(result.stdout,/SERVER_READY/);
 console.log(`PASS ${service} exact image startup true/false/invalid/migration-failure-before-server`);
}
