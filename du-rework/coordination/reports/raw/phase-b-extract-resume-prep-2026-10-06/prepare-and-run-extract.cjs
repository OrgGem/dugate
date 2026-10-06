'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const project = process.env.ARCH_PROJECT_NAME || 'arch-phase-b-20261006';
const tenantId = process.env.ARCH_TEST_TENANT_ID || '8f8db07e-b8ed-4c74-a8d4-202610068870';
const outputPath = path.join(__dirname, 'run-summary.json');
const overlayPath = 'coordination/reports/raw/phase-b-extract-resume-prep-2026-10-06/extract-mock-provider.compose.yml';
const compose = ['compose', '--env-file', '.env.docker', '--project-name', project, '-f', 'docker-compose.yml', '-f', overlayPath];
const invoiceNumber = 'INV-ARCH-PHASE-B-MOCK-001';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function embeddedNode(source) {
  return docker([...compose, 'exec', '-T', 'orchestrator', 'node', '-e', source]).trim();
}

function safeErrorCode(error) {
  const body = error && error.stdout ? String(error.stdout) : '';
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.code === 'string' ? parsed.code : 'runner_failed';
  } catch {
    return 'runner_failed';
  }
}

if (!process.argv.includes('--run-live')) {
  fail('LIVE_GUARD: pass --run-live only after the Coordinator opens the isolated live window.');
} else if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || !project.startsWith('arch-phase-b-')) {
  fail('PROJECT_GUARD: ARCH_PROJECT_NAME must name an isolated arch-phase-b-* Compose project.');
} else if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
  fail('TENANT_GUARD: ARCH_TEST_TENANT_ID must be a UUID.');
} else {
  try {
    const running = new Set(
      docker([...compose, 'ps', '--services', '--status', 'running'])
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    for (const service of ['postgres', 'valkey', 'orchestrator', 'connector', 'document-core']) {
      if (!running.has(service)) throw new Error(`preflight_missing_${service}`);
    }

    // Only this test project's Connector receives the temporary private-network
    // egress opt-in, and its allowlisted destination is the isolated sidecar.
    docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'extract-mock', 'connector']);
    const healthProbe = [
      "(async()=>{const hosts=(process.env.PROVIDER_ALLOW_HOSTS||'').split(/[\\s,]+/).filter(Boolean);",
      "if(process.env.ALLOW_PRIVATE_PROVIDER_NETWORKS!=='true'||!hosts.includes('extract-mock'))process.exit(2);",
      "const connector=await fetch('http://127.0.0.1:8080/health/ready');if(!connector.ok)process.exit(3);",
      "const r=await fetch('http://extract-mock:8090/health');if(!r.ok)process.exit(4);const b=await r.json();if(b.ok!==true)process.exit(5)})().catch(()=>process.exit(6));",
    ].join('');
    docker([...compose, 'exec', '-T', 'connector', 'node', '-e', healthProbe]);

    const connectorId = `arch-extract-mock-${Date.now().toString(36)}`;
    const credentialRef = `${connectorId}-credential`;
    const bootstrap = `
      'use strict';
      const crypto=require('node:crypto');
      const tenantId=${JSON.stringify(tenantId)};
      const connectorId=${JSON.stringify(connectorId)};
      const credentialRef=${JSON.stringify(credentialRef)};
      const invoiceNumber=${JSON.stringify(invoiceNumber)};
      const inputText='Synthetic invoice for live connector-bound Extract verification; total 42.50 USD.';
      const adminBase='http://127.0.0.1:3002/api/v1/admin/actions';
      const publicBase='http://127.0.0.1:3000';
      const runId=crypto.randomUUID();
      const result={project:${JSON.stringify(project)},connectorId,phases:{},verdict:'FAIL',safeToCleanup:true};
      function codeOf(body){return body&&body.error&&typeof body.error.code==='string'?body.error.code:(body&&typeof body.code==='string'?body.code:'unknown')}
      async function admin(action,params,status){
        const headers={authorization:'Bearer '+process.env.ADMIN_TOKEN,'content-type':'application/json'};
        // apikey.issue returns a raw key once; never use the response-body
        // idempotency ledger for that action because it could persist the key.
        if(action!=='apikey.issue')headers['idempotency-key']='extract-mock-'+runId+'-'+action;
        const response=await fetch(adminBase,{method:'POST',headers,body:JSON.stringify({action,params})});
        let body={};try{body=await response.json()}catch{}
        if(response.status!==status)throw Object.assign(new Error('admin_'+action),{code:'admin_'+action+'_http_'+response.status+'_'+codeOf(body)});
        return body;
      }
      function managementToken(){
        const secret=Buffer.from(process.env.SERVICE_IDENTITY_SECRET||'','base64');
        if(secret.byteLength!==32)throw Object.assign(new Error('identity'),{code:'service_identity_config_invalid'});
        const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
        const now=Math.floor(Date.now()/1000);
        const payload=Buffer.from(JSON.stringify({sub:'orchestrator-management',aud:'connector',scopes:['connector:manage'],iat:now,exp:now+60,jti:crypto.randomUUID()})).toString('base64url');
        const input=header+'.'+payload;
        return 'Bearer '+input+'.'+crypto.createHmac('sha256',secret).update(input).digest('base64url');
      }
      async function connector(method,path,body,status){
        const response=await fetch('http://connector:8080'+path,{method,headers:{authorization:managementToken(),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
        let value={};try{value=await response.json()}catch{}
        if(response.status!==status)throw Object.assign(new Error('connector_'+method),{code:'connector_'+method.toLowerCase()+'_http_'+response.status+'_'+codeOf(value)});
        return value;
      }
      function containsValue(value,wanted){
        if(value===wanted)return true;
        if(Array.isArray(value))return value.some((item)=>containsValue(item,wanted));
        if(value&&typeof value==='object')return Object.values(value).some((item)=>containsValue(item,wanted));
        return false;
      }
      function parseJsonIfString(value){
        if(typeof value!=='string')return value;
        try{return JSON.parse(value)}catch{return value}
      }
      function stateOf(operation){return (operation&&operation.metadata&&operation.metadata.state)||(operation&&operation.state)||(operation&&operation.status)||null}
      async function providerStats(){
        const response=await fetch('http://extract-mock:8090/stats');
        if(!response.ok)throw Object.assign(new Error('stats'),{code:'mock_stats_http_'+response.status});
        const body=await response.json();
        return {calls:Number(body.calls)||0};
      }
      async function checkpointCounts(operationId){
        const {Pool}=require('pg');
        const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
        const client=await pool.connect();
        try{
          await client.query('BEGIN READ ONLY');
          await client.query(\"SET LOCAL statement_timeout = '5000'\");
          const q=await client.query(\"SELECT o.state,o.error_code,(SELECT count(*)::int FROM tasks t WHERE t.operation_id=o.id) AS task_count,(SELECT count(*)::int FROM step_checkpoints s WHERE s.task_id IN (SELECT t.id FROM tasks t WHERE t.operation_id=o.id)) AS checkpoint_count FROM operations o WHERE o.id=$1\",[operationId]);
          await client.query('COMMIT');
          const row=q.rows[0]||{};
          return {state:row.state||null,errorCode:row.error_code||null,taskCount:Number(row.task_count)||0,checkpointCount:Number(row.checkpoint_count)||0};
        }catch(error){await client.query('ROLLBACK').catch(()=>{});throw Object.assign(new Error('db_counts'),{code:'readonly_counts_failed'})}
        finally{client.release();await pool.end()}
      }
      (async()=>{
        let apiKeyId=null;
        let operationId=null;
        try{
          const created=await connector('POST','/connectors',{connectorId,adapter:'json-http',config:{baseUrl:'http://extract-mock:8090',path:'/v1/extract',timeoutMs:5000},credentialRef,state:'ACTIVE'},201);
          result.phases.connectorRevision={created:true,revision:created.revision,adapter:created.adapter,state:created.state};
          if(created.connectorId!==connectorId||created.revision!==1||created.state!=='ACTIVE')throw Object.assign(new Error('revision'),{code:'connector_revision_shape_invalid'});

          // This is a non-secret fixture credential, written only in the disposable
          // Connector DB through its authenticated internal management route.
          const fixtureCredential='du-extract-mock-'+crypto.randomBytes(16).toString('hex');
          await connector('POST','/connectors/'+encodeURIComponent(connectorId)+'/credentials/rotate',{secret:fixtureCredential},204);
          const credentialCheck=await connector('POST','/connectors/'+encodeURIComponent(connectorId)+'/test',{},200);
          if(credentialCheck.ok!==true)throw Object.assign(new Error('credential_probe'),{code:'connector_fixture_credential_inactive'});
          result.phases.fixtureCredentialActive=true;

          const rawKey='du_arch_extract_mock_'+crypto.randomBytes(32).toString('hex');
          const issued=await admin('apikey.issue',{tenantId,apiKey:rawKey},201);
          if(issued.rawKey!==rawKey||typeof issued.id!=='string')throw Object.assign(new Error('apikey'),{code:'apikey_issue_contract_invalid'});
          apiKeyId=issued.id;
          const bound=await admin('apikey.bind-profile',{apiKey:rawKey,businessId:'document-core',businessVersion:'1.0.0',action:'extract',connectorBindings:{reasoning:{connectorId,revision:created.revision}}},201);
          if(typeof bound.profileId!=='string'||bound.revision!==1)throw Object.assign(new Error('profile'),{code:'profile_binding_contract_invalid'});
          result.phases.profileBinding={created:true,revision:bound.revision,slot:'reasoning',connectorRevision:created.revision};

          const submitted=await fetch(publicBase+'/api/v1/businesses/document-core/actions/extract',{method:'POST',headers:{'content-type':'application/json','x-api-key':rawKey,'idempotency-key':'extract-mock-submit-'+runId},body:JSON.stringify({input:{type:'invoice',text:inputText}})});
          let admission={};try{admission=await submitted.json()}catch{}
          if(submitted.status!==202||typeof admission.operationId!=='string')throw Object.assign(new Error('submit'),{code:'extract_submit_http_'+submitted.status+'_'+codeOf(admission)});
          operationId=admission.operationId;
          result.safeToCleanup=false;
          result.phases.submit={http:submitted.status,accepted:true,operationId};

          let operation=null;
          const deadline=Date.now()+120000;
          while(Date.now()<deadline){
            await new Promise((resolve)=>setTimeout(resolve,500));
            const poll=await fetch(publicBase+'/api/v1/operations/'+encodeURIComponent(operationId),{headers:{'x-api-key':rawKey}});
            let body={};try{body=await poll.json()}catch{}
            if(poll.status!==200)throw Object.assign(new Error('poll'),{code:'operation_poll_http_'+poll.status});
            operation=body;
            if(['SUCCEEDED','COMPLETED','FAILED','TIMED_OUT'].includes(stateOf(operation))||operation.done===true)break;
          }
          const finalState=stateOf(operation);
          result.phases.operation={state:finalState,done:!!(operation&&operation.done)};
          result.safeToCleanup=['SUCCEEDED','COMPLETED','FAILED','TIMED_OUT','CANCELLED'].includes(finalState)||(operation&&operation.done===true);
          result.phases.database=await checkpointCounts(operationId);
          result.phases.mockProvider=await providerStats();
          if(finalState!=='SUCCEEDED'&&finalState!=='COMPLETED')throw Object.assign(new Error('operation'),{code:'extract_terminal_'+String(finalState||'timeout')});
          const fetched=await fetch(publicBase+'/api/v1/operations/'+encodeURIComponent(operationId)+'/result',{headers:{'x-api-key':rawKey}});
          let resultBody={};try{resultBody=await fetched.json()}catch{}
          if(fetched.status!==200)throw Object.assign(new Error('result'),{code:'extract_result_http_'+fetched.status});
          const opaqueRef=resultBody&&resultBody.data&&resultBody.data.resultRef;
          const artifactId=typeof opaqueRef==='string'&&opaqueRef.startsWith('artifact://')?opaqueRef.slice('artifact://'.length):'';
          const artifactMatch=/^[0-9a-f-]{36}$/i.test(artifactId)?artifactId:null;
          if(!artifactMatch)throw Object.assign(new Error('result_ref'),{code:resultBody&&resultBody.ciphertext?'result_delivery_encrypted':'result_artifact_ref_missing'});
          const outputArtifact=Array.isArray(resultBody.artifacts)?resultBody.artifacts.find((item)=>item&&item.artifactId===artifactMatch):null;
          if(!outputArtifact||typeof outputArtifact.download!=='string'||outputArtifact.role!=='output')throw Object.assign(new Error('result_artifact'),{code:'result_output_artifact_missing'});
          const downloadUrl=new URL(outputArtifact.download,publicBase);
          if(downloadUrl.origin!==publicBase||downloadUrl.pathname!=='/api/v1/artifacts/'+artifactMatch+'/download')throw Object.assign(new Error('result_download'),{code:'result_download_url_invalid'});
          const downloaded=await fetch(downloadUrl,{headers:{'x-api-key':rawKey}});
          if(downloaded.status!==200)throw Object.assign(new Error('download'),{code:'extract_artifact_download_http_'+downloaded.status});
          const downloadedText=await downloaded.text();
          if(downloadedText.length>1024*1024)throw Object.assign(new Error('download_size'),{code:'extract_artifact_download_oversize'});
          const output= parseJsonIfString(downloadedText);
          if(!containsValue(output,invoiceNumber)||!containsValue(output,4250))throw Object.assign(new Error('result_shape'),{code:'extract_download_fixture_marker_missing'});
          result.phases.result={http:fetched.status,schemaVersion:resultBody.schemaVersion||null,opaqueArtifactRef:true,outputArtifactMatched:true,downloadHttp:downloaded.status,fixtureInvoicePresent:true,fixtureTotalPresent:true};
          if(result.phases.mockProvider.calls!==1)throw Object.assign(new Error('provider_count'),{code:'mock_provider_call_count_unexpected'});
          result.verdict='PASS';
        }catch(error){
          result.code=typeof error.code==='string'?error.code:'harness_error';
          if(operationId){
            try{result.phases.database=await checkpointCounts(operationId)}catch{}
            try{result.phases.mockProvider=await providerStats()}catch{}
          }
        }finally{
          // API key cleanup runs after the result has been read. Connector
          // revision is disabled too; no fake credential remains routable.
          if(result.safeToCleanup){
            if(apiKeyId){try{await admin('apikey.revoke',{apiKeyId},200);result.phases.apiKeyRevoked=true}catch{result.phases.apiKeyRevoked=false}}
            if(result.phases.connectorRevision&&result.phases.connectorRevision.created){try{await connector('POST','/connectors/'+encodeURIComponent(connectorId)+'/disable',undefined,204);result.phases.connectorDisabled=true}catch{result.phases.connectorDisabled=false}}
          }else{
            result.phases.cleanupDeferred='operation_not_terminal';
          }
          process.stdout.write(JSON.stringify(result));
        }
      })().catch(()=>{process.stdout.write(JSON.stringify({project:${JSON.stringify(project)},phases:{},verdict:'FAIL',code:'bootstrap_runtime_error'}))});
    `;

    const raw = embeddedNode(bootstrap);
    const summary = JSON.parse(raw);
    if (summary.safeToCleanup === true) {
      try {
        docker([...compose, 'stop', 'extract-mock']);
        docker([...compose, 'rm', '-f', 'extract-mock']);
        const baselineCompose = ['compose', '--env-file', '.env.docker', '--project-name', project, '-f', 'docker-compose.yml'];
        docker([...baselineCompose, 'up', '-d', 'connector']);
        summary.phases.networkCleanup = { mockSidecarStopped: true, connectorEgressPolicyRestored: true };
      } catch {
        summary.phases.networkCleanup = { mockSidecarStopped: false, connectorEgressPolicyRestored: false };
        summary.code = summary.code || 'network_cleanup_failed';
        if (summary.verdict === 'PASS') summary.verdict = 'FAIL';
      }
    }
    delete summary.safeToCleanup;
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.verdict !== 'PASS') process.exitCode = 1;
  } catch (error) {
    const summary = {
      project,
      verdict: 'FAIL',
      code: safeErrorCode(error),
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = 1;
  }
}
