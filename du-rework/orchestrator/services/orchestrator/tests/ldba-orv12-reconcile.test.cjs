'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inventory,hash } = require('../scripts/ldba-inventory.cjs');
const { prepare,apply,createAdminClient,pointer } = require('../scripts/ldba-reconcile.cjs');
const tenantId='10000000-0000-4000-8000-000000000001';
const apiKeyId='20000000-0000-4000-8000-000000000001';
const connectionId='30000000-0000-4000-8000-000000000001';
function fixture() {
  const settings=[{key:'ai_generate_prompt',value:'private fixture prompt',updated_at:'2026-10-11T00:00:00.000Z'},{key:'s3_bucket',value:'bucket',updated_at:'2026-10-11T00:00:00.000Z'}];
  let journal;
  const pool={query:async(sql,values=[])=>{
    let rows=[];
    if (/FROM legacy_migration_runs/.test(sql)) rows=[{source_sha256:'a'.repeat(64),plan_sha256:'b'.repeat(64),source_counts:{AppSetting:2},destination_counts:{legacy_app_settings:2}}];
    else if (/FROM legacy_configuration_reconciliations/.test(sql)) rows=journal?[journal]:[];
    else if (/FROM legacy_app_settings/.test(sql)) rows=settings;
    else if (/AS size FROM artifacts/.test(sql)) rows=[{size:'0'}];
    else if (/INSERT INTO legacy_configuration/.test(sql)) journal={baseline_inventory_sha256:values[3],progress:{}};
    else if (/UPDATE legacy_configuration/.test(sql)) journal.progress[values[3]]=JSON.parse(values[4]);
    return {rows,rowCount:rows.length};
  }};
  pool.connect=async()=>({query:pool.query,release(){}});
  return {pool,settings};
}
async function setup() {
  const f=fixture(); const report=await inventory(f.pool,tenantId,'snapshot');
  const manifest={version:'ldba-effective-config-v1',tenantId,sourceVersion:'snapshot',sourceSha256:report.sourceSha256,archivedSettingsSha256:report.archivedSettingsSha256,baselineInventorySha256:report.inventorySha256,reviewedBy:'fixture reviewer',scopes:[{apiKeyId,endpointSlug:'generate:summary',expectedActiveRevision:null}],mappings:[{sourceKey:'ai_generate_prompt',sourceValueSha256:hash(f.settings[0].value),disposition:'settings-revision',targets:[{apiKeyId,endpointSlug:'generate:summary',connectionId,stepId:'_default',semanticEvidence:'fixture worker selected reasoning processor accepts this prompt'}]},{sourceKey:'s3_bucket',sourceValueSha256:hash('bucket'),disposition:'deployment',reason:'requires deployment config'}]};
  return {...f,report,manifest,digest:'c'.repeat(64)};
}
test('inventory/report does not expose setting values or prompt text',async()=>{
  const {report}=await setup(); const serialized=JSON.stringify(report);
  assert.ok(!serialized.includes('private fixture prompt')); assert.ok(!serialized.includes('"bucket"')); assert.equal(report.cutoverReady,false);
});
test('preflight binds source/archive/target inventory and requires complete dispositions',async()=>{
  const f=await setup(); const plan=await prepare(f.pool,f.manifest,f.digest);
  assert.equal(plan.report.diffs[0].consumer,'connector_prompt_overrides');assert.equal(plan.report.holds.length,1);assert.ok(!JSON.stringify(plan.report).includes('private fixture prompt'));
  for(const change of [{sourceSha256:'d'.repeat(64)},{archivedSettingsSha256:'d'.repeat(64)},{baselineInventorySha256:'d'.repeat(64)},{mappings:f.manifest.mappings.slice(0,1)}]) await assert.rejects(prepare(f.pool,{...f.manifest,...change},f.digest));
});
test('source change and unsupported automatic secret mapping fail closed',async()=>{
  const f=await setup(); f.settings[0].value='changed'; await assert.rejects(prepare(f.pool,f.manifest,f.digest),error=>error.code==='SOURCE_ARCHIVE_BINDING_MISMATCH');
  f.settings[0].value='private fixture prompt';f.manifest.mappings[1]={...f.manifest.mappings[1],disposition:'settings-revision',targets:[{}]};
  await assert.rejects(prepare(f.pool,f.manifest,f.digest),error=>error.code==='SETTING_REQUIRES_EXPLICIT_EXTERNAL_RECONCILIATION');
});
test('apply calls audited settings lifecycle and resumed run does not reapply active revision',async()=>{
  const f=await setup(); let active=null;let applies=0;const keys=[];
  const admin={read:async()=>({configuration:{activeRevision:active,activeRevisionMatchesEffective:true},promptOverrides:[{connectionId,stepId:'_default',promptOverride:'private fixture prompt'}]}),action:async(action,params,key)=>{keys.push(key);if(action.endsWith('.create')){assert.equal(params.changes.prompts[0].promptOverride,'private fixture prompt');return {revision:1};}if(action.endsWith('.validate'))return {valid:true};if(action.endsWith('.apply')){active=params.revision;applies++;return {revision:active};}}};
  const first=await apply(f.pool,f.manifest,f.digest,await prepare(f.pool,f.manifest,f.digest),admin);
  assert.equal(first.outcomes[0].status,'APPLIED_AND_ACTIVE');
  const second=await apply(f.pool,f.manifest,f.digest,await prepare(f.pool,f.manifest,f.digest),admin);
  assert.equal(second.outcomes[0].revision,1);assert.equal(applies,1);assert.equal(keys[0],keys.at(-1));
});
test('validation failure never invokes apply',async()=>{
  const f=await setup();const called=[];
  const admin={read:async()=>({configuration:{activeRevision:null}}),action:async(action)=>{called.push(action);return action.endsWith('.create')?{revision:1}:{valid:false};}};
  await assert.rejects(apply(f.pool,f.manifest,f.digest,await prepare(f.pool,f.manifest,f.digest),admin),error=>error.code==='SETTINGS_VALIDATION_FAILED');assert.ok(!called.includes('settings.revision.apply'));
});
test('admin client blocks insecure external origins/redirects and hides response errors',async()=>{
  assert.throws(()=>createAdminClient('http://external.test','token'),/SECURE_ADMIN/);
  assert.throws(()=>createAdminClient('https://user:password@example.test','token'),/SECURE_ADMIN/);
  const admin=createAdminClient('https://example.test','private token',async(url,options)=>{assert.equal(options.redirect,'error');return {ok:false,status:403,json:async()=>({secret:'server body must not escape'})};});
  await assert.rejects(admin.read({tenantId}),error=>error.message==='ADMIN_REQUEST_FAILED_403');
});
test('semantic pointer forbids credential extraction',()=>{
  assert.throws(()=>pointer({headers:{Authorization:'secret'}},'/headers/Authorization'),/UNSUPPORTED/);assert.equal(pointer({baseUrl:'https://provider.test'},'/baseUrl'),'https://provider.test');
});

test('replay after direct effective edit reports drift without reapplying',async()=>{
  const f=await setup();let active=null;let drift=false;let applied=0;
  const admin={read:async()=>({configuration:{activeRevision:active,activeRevisionMatchesEffective:!drift},promptOverrides:[{connectionId,stepId:'_default',promptOverride:drift?'operator edit':'private fixture prompt'}]}),action:async(action,params)=>{if(action.endsWith('.create'))return {revision:1};if(action.endsWith('.validate'))return {valid:true};active=params.revision;applied++;return {revision:active};}};
  await apply(f.pool,f.manifest,f.digest,await prepare(f.pool,f.manifest,f.digest),admin);
  drift=true;
  await assert.rejects(apply(f.pool,f.manifest,f.digest,await prepare(f.pool,f.manifest,f.digest),admin),error=>error.code==='EFFECTIVE_CONFIGURATION_DRIFT');
  assert.equal(applied,1);
});
