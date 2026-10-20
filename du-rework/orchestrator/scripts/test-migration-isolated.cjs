'use strict';
// Opt-in test runner. Creates only isolated, disposable Docker fixtures.
const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'..');
const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'du-migration-test-'));
const fixture=path.join(fixtureRoot,'migration-fixture'); fs.mkdirSync(fixture);
const suffix=Date.now(); const pg=`du-migration-test-pg-${suffix}`; const artifacts=[];
const prefix=process.env.DU_MIGRATION_IMAGE_PREFIX || 'du-external-prep';
const tag=process.env.DU_MIGRATION_IMAGE_TAG; if(!tag)throw Error('DU_MIGRATION_IMAGE_TAG is required');
function docker(args,{capture=false}={}) {const r=spawnSync('docker',args,{encoding:'utf8',timeout:120000}); if(r.status!==0)throw Error(`Docker fixture operation failed (${args[0]}): ${r.stderr}`); if(!capture&&r.stdout)process.stdout.write(r.stdout); return r.stdout.trim();}
try {
 docker(['run','-d','--name',pg,'--network','none','--label','du.task=migration-isolated-test','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'],{capture:true});
 for(let i=0;;i++){const r=spawnSync('docker',['exec',pg,'pg_isready','-U','postgres'],{encoding:'utf8'});if(r.status===0)break;if(i===30)throw Error('Fixture database not ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);}
 for(const service of ['orchestrator','connector']) {
  const name=`du-migration-artifact-${service}-${suffix}`;
  docker(['create','--name',name,'--network','none',`${prefix}-${service}:${tag}`],{capture:true});artifacts.push(name);
  fs.mkdirSync(path.join(fixture,service));
  for(const file of service==='orchestrator'?['migrations.js','required-data.js']:['migration-runner.js'])docker(['cp',`${name}:/app/dist/db/${file}`,path.join(fixture,service,file)],{capture:true});
  docker(['cp',`${name}:${service==='orchestrator'?'/app/migrations':'/app/dist/db/migrations'}`,path.join(fixture,`sql-${service}`)],{capture:true});
 }
 fs.copyFileSync(path.join(source,'tests/migration-isolated.integration.cjs'),path.join(fixture,'migration-isolated.integration.cjs'));
 docker(['run','--rm','--network',`container:${pg}`,'--mount',`type=bind,source=${fixture},target=/fixture,readonly`,'--entrypoint','node',`${prefix}-orchestrator:${tag}`,'/fixture/migration-isolated.integration.cjs']);
 const r=spawnSync(process.execPath,[path.join(source,'tests/migration-image-startup.test.cjs')],{encoding:'utf8',env:{...process.env,DU_MIGRATION_TEST_PG:pg,DU_MIGRATION_FIXTURE_ROOT:fixtureRoot.replaceAll('\\','/'),DU_MIGRATION_IMAGE_PREFIX:prefix},timeout:240000});
 process.stdout.write(r.stdout||''); if(r.status!==0)throw Error(r.stderr||'Image startup test failed');
} finally {
 for(const name of [...artifacts,pg])spawnSync('docker',['rm','-f',name],{encoding:'utf8'});
 // The exact directory returned by mkdtemp is owned by this test process.
 fs.rmSync(fixtureRoot,{recursive:true,force:true});
}
