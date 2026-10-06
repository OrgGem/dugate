'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');

const project = 'arch-phase-b-20261006';
const compose = ['compose', '--env-file', '.env.docker', '--project-name', project, '-f', 'docker-compose.yml'];
const summaryPath = 'coordination/reports/phase-b-live-summary-2026-10-06.json';
const summary = { project, phases: {}, offlineOrLive: 'live-local Docker/Postgres/Valkey/worker stack' };
const fixtureText = '# Synthetic Shipping 887\
\
Invoice sample: invoice INV-887, supplier Northwind Test Ltd, total 42.50 USD.\
';
const tenantId = '8f8db07e-b8ed-4c74-a8d4-202610068874';

function docker(args, opts = {}) {
  return execFileSync('docker', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}
function requireHttpStatus(response, expected, phase) {
  if (response.status !== expected) {
    throw new Error(phase + '_HTTP_' + response.status);
  }
}
function stateOf(op) {
  return (op && op.metadata && op.metadata.state) || (op && op.state) || (op && op.status) || null;
}

(async () => {
  let phase = 'manifest';
  try {
    const manifestPath = 'coordination/reports/raw/live-stack-deploy-e2e-2026-10-06/document-core.manifest.json';
    docker([...compose, 'cp', manifestPath, 'orchestrator:/tmp/document-core.manifest.json']);
    summary.phases.manifest_copied = true;

    phase = 'provision';
    const bootstrap = [
      "'use strict';",
      "const fs=require('node:fs'); const crypto=require('node:crypto'); const {Pool}=require('pg');",
      "const tenantId='" + tenantId + "'; const apiKey='du_live_e2e_'+crypto.randomBytes(32).toString('hex');",
      "const pool=new Pool({connectionString:process.env.DATABASE_URL}); let phase='tenant';",
      "async function checked(r,expected,label){if(r.status!==expected && !((label==='register'||label==='activate') && r.status===200)){let c='';try{const b=await r.json();c=b.code||'';}catch{}throw new Error(label+'_HTTP_'+r.status+(c?'_'+c:''));}return r.json();}",
      "(async()=>{try{await pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING',[tenantId,'Live E2E 887']);",
      "phase='register'; const manifest=JSON.parse(fs.readFileSync('/tmp/document-core.manifest.json','utf8'));",
      "await checked(await fetch('http://127.0.0.1:3002/api/runtime/v1/businesses/document-core/versions/1.0.0',{method:'PUT',headers:{authorization:'Bearer '+process.env.RUNTIME_TOKEN,'content-type':'application/json'},body:JSON.stringify(manifest)}),201,'register');",
      "phase='enable'; await checked(await fetch('http://127.0.0.1:3002/api/v1/admin/businesses/document-core/versions/1.0.0/enable',{method:'PUT',headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN}}),200,'enable');",
      "phase='activate'; await checked(await fetch('http://127.0.0.1:3002/api/v1/admin/businesses/document-core/versions/1.0.0/activate',{method:'PUT',headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN}}),202,'activate');",
      "phase='api_key'; const issued=await checked(await fetch('http://127.0.0.1:3002/api/v1/admin/actions',{method:'POST',headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN,'content-type':'application/json','idempotency-key':'live-e2e-issue-'+tenantId},body:JSON.stringify({action:'apikey.issue',params:{tenantId,apiKey}})}),201,'apikey_issue');",
      "if(issued.rawKey!==apiKey)throw new Error('api_key_copy_once_mismatch'); process.stdout.write(apiKey);",
      "}catch(e){process.stderr.write('BOOTSTRAP_FAIL phase='+phase+' reason='+String(e&&e.message||'unknown')+'\
');process.exitCode=1;}finally{await pool.end();}})();",
    ].join('\
');
    const key = docker([...compose, 'exec', '-T', 'orchestrator', 'node', '-e', bootstrap]).trim();
    if (!/^du_live_e2e_[a-f0-9]{64}$/.test(key)) throw new Error('api_key_setup_failed');
    summary.phases.business_registered_enabled_activated = true;
    summary.phases.tenant_api_key_created = true;

    phase = 'host_health';
    const base = 'http://127.0.0.1:3360';
    const health = await fetch(base + '/health');
    requireHttpStatus(health, 200, 'host_health');
    const healthBody = await health.json();
    summary.phases.host_public_health = {
      http: health.status,
      db: healthBody.db === true,
      redis: healthBody.redis === true,
    };
    if (healthBody.db !== true || healthBody.redis !== true) throw new Error('health_dependencies_not_ready');

    phase = 'submit_ingest';
    const idempotencyKey = 'live-e2e-887-' + crypto.randomUUID();
    const submit = await fetch(base + '/api/v1/businesses/document-core/actions/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ input: { mode: 'parse', text: fixtureText } }),
    });
    requireHttpStatus(submit, 202, 'submit_ingest');
    const submission = await submit.json();
    if (!submission.operationId) throw new Error('submit_missing_operation_id');
    summary.phases.ingest_accepted = { http: submit.status, state: submission.state, hasOperationId: true };
    summary.operationId = submission.operationId;

    phase = 'poll_operation';
    let operation = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const response = await fetch(base + '/api/v1/operations/' + encodeURIComponent(submission.operationId), {
        headers: { 'x-api-key': key },
      });
      requireHttpStatus(response, 200, 'poll_operation');
      operation = await response.json();
      const state = stateOf(operation);
      if (state === 'SUCCEEDED' || state === 'COMPLETED' || state === 'FAILED' || state === 'TIMED_OUT') break;
      if (operation.done === true) break;
    }
    const finalState = stateOf(operation);
    summary.phases.operation_terminal = { state: finalState, done: operation && operation.done === true };
    if (!operation || (finalState !== 'SUCCEEDED' && finalState !== 'COMPLETED')) throw new Error('operation_not_succeeded_' + String(finalState));

    phase = 'fetch_result';
    const resultResponse = await fetch(base + '/api/v1/operations/' + encodeURIComponent(submission.operationId) + '/result', {
      headers: { 'x-api-key': key },
    });
    requireHttpStatus(resultResponse, 200, 'fetch_result');
    const resultBody = await resultResponse.json();
    const resultSerialized = JSON.stringify(resultBody);
    const resultContainsFixture = resultSerialized.includes(fixtureText.trim());
    const artifacts = Array.isArray(resultBody.artifacts) ? resultBody.artifacts :
      (resultBody.data && Array.isArray(resultBody.data.artifacts) ? resultBody.data.artifacts : []);
    summary.phases.result = {
      http: resultResponse.status,
      schemaVersion: resultBody.schemaVersion || null,
      artifactCount: artifacts.length,
      fixtureTextInResult: resultContainsFixture,
    };
    let downloadVerified = false;
    if (artifacts.length > 0) {
      const downloadRef = artifacts[0].download || artifacts[0].downloadUrl;
      if (typeof downloadRef !== 'string') throw new Error('result_artifact_missing_download');
      const downloadResponse = await fetch(new URL(downloadRef, base), { headers: { 'x-api-key': key } });
      requireHttpStatus(downloadResponse, 200, 'download_result');
      const contentType = downloadResponse.headers.get('content-type') || '';
      const bytes = Buffer.from(await downloadResponse.arrayBuffer());
      let downloadedContent = bytes.toString('utf8');
      if (contentType.includes('json')) {
        try { downloadedContent = JSON.stringify(JSON.parse(downloadedContent)); } catch {}
      }
      downloadVerified = downloadedContent.includes(fixtureText.trim());
      summary.phases.result_download = { http: downloadResponse.status, contentType, bytes: bytes.length, fixtureTextPresent: downloadVerified };
    }
    if (!resultContainsFixture && !downloadVerified) throw new Error('fixture_text_absent_from_result_and_download');

    phase = 'idempotency_replay';
    const replay = await fetch(base + '/api/v1/businesses/document-core/actions/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ input: { mode: 'parse', text: fixtureText } }),
    });
    requireHttpStatus(replay, 200, 'idempotency_replay');
    const replayBody = await replay.json();
    const replayed = replayBody.replayed === true && replayBody.operationId === submission.operationId;
    summary.phases.idempotency_replay = { http: replay.status, sameOperationId: replayBody.operationId === submission.operationId, replayed };
    if (!replayed) throw new Error('idempotency_replay_mismatch');

    phase = 'checkpoint_summary';
    const checkpointCode = [
      "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL});",
      "const opId=process.argv[1]; (async()=>{try{const r=await p.query(",
      "\"SELECT (SELECT count(*)::int FROM tasks WHERE operation_id=$1) AS task_count,\"+",
      "\"(SELECT count(*)::int FROM tasks WHERE operation_id=$1 AND state IN ('SUCCEEDED','COMPLETED')) AS task_succeeded,\"+",
      "\"(SELECT count(*)::int FROM step_checkpoints WHERE task_id IN (SELECT id FROM tasks WHERE operation_id=$1)) AS checkpoint_count\",[opId]);",
      "process.stdout.write(JSON.stringify(r.rows[0]));}catch(e){process.stderr.write('CHECKPOINT_QUERY_FAIL '+String(e&&e.message||'unknown'));process.exitCode=1;}finally{await p.end();}})();",
    ].join('\
');
    const checkpointRaw = docker([...compose, 'exec', '-T', 'orchestrator', 'node', '-e', checkpointCode, submission.operationId]).trim();
    const checkpoint = JSON.parse(checkpointRaw);
    summary.phases.runtime_checkpoint_and_task_rows = checkpoint;
    if (!(checkpoint.task_count >= 1) || !(checkpoint.task_succeeded >= 1) || !(checkpoint.checkpoint_count >= 1)) {
      throw new Error('worker_task_or_checkpoint_not_observed');
    }

    summary.verdict = 'PASS ingest input -> public Orchestrator -> BullMQ worker -> task/checkpoints -> result output';
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\
');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\
');
  } catch (error) {
    summary.failurePhase = phase;
    summary.failure = String(error && error.message || 'unknown').replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 160);
    summary.verdict = 'FAIL or blocked';
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\
');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\
');
    process.exitCode = 1;
  }
})();





