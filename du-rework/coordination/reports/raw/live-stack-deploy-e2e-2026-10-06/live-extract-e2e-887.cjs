'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const project = 'pm-m02-verify-20261006-887';
const compose = ['compose', '--env-file', '.env.docker', '--project-name', project, '-f', 'docker-compose.yml'];
const summaryPath = 'coordination/reports/raw/live-stack-deploy-e2e-2026-10-06/extract-summary.json';
const summary = { project, phases: {}, connectorRevisionCount: 0, profileBindingCount: 0 };
const inputText = 'Invoice INV-EXTRACT-887 from Northwind Test Ltd, total 42.50 USD.';
function docker(args, opts = {}) {
  return execFileSync('docker', args, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts });
}
async function getJson(response) {
  try { return await response.json(); } catch { return {}; }
}
function stateOf(op) {
  return (op && op.metadata && op.metadata.state) || (op && op.state) || (op && op.status) || null;
}
(async () => {
  let phase = 'issue_api_key';
  try {
    const tenantId = '8f8db07e-b8ed-4c74-a8d4-202610068870';
    const bootstrap = [
      "const crypto=require('node:crypto'); const tenantId='" + tenantId + "'; const apiKey='du_live_extract_'+crypto.randomBytes(32).toString('hex');",
      "(async()=>{try{const r=await fetch('http://127.0.0.1:3002/api/v1/admin/actions',{method:'POST',headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN,'content-type':'application/json','idempotency-key':'live-e2e-extract-'+crypto.randomUUID()},body:JSON.stringify({action:'apikey.issue',params:{tenantId,apiKey}})});if(r.status!==201){let c='';try{c=(await r.json()).code||''}catch{}throw new Error('apikey_issue_HTTP_'+r.status+'_'+c)}const b=await r.json();if(b.rawKey!==apiKey)throw new Error('apikey_copy_once_mismatch');process.stdout.write(apiKey)}catch(e){process.stderr.write('BOOTSTRAP_FAIL '+String(e&&e.message||'unknown'));process.exitCode=1}})();",
    ].join('\n');
    const apiKey = docker([...compose, 'exec', '-T', 'orchestrator', 'node', '-e', bootstrap]).trim();
    if (!/^du_live_extract_[a-f0-9]{64}$/.test(apiKey)) throw new Error('api_key_setup_failed');
    summary.phases.apiKeyIssued = true;

    phase = 'submit_extract';
    const base = 'http://127.0.0.1:3300';
    const idempotencyKey = 'live-e2e-extract-887-' + crypto.randomUUID();
    const submit = await fetch(base + '/api/v1/businesses/document-core/actions/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ input: { type: 'invoice', text: inputText } }),
    });
    const submission = await getJson(submit);
    summary.phases.submit = { http: submit.status, state: submission.state || null, hasOperationId: !!submission.operationId };
    if (submit.status !== 202 || !submission.operationId) throw new Error('extract_submit_HTTP_' + submit.status);

    phase = 'poll_extract';
    let op = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const response = await fetch(base + '/api/v1/operations/' + encodeURIComponent(submission.operationId), { headers: { 'x-api-key': apiKey } });
      op = await getJson(response);
      if (response.status !== 200) throw new Error('poll_HTTP_' + response.status);
      const state = stateOf(op);
      if (['SUCCEEDED', 'COMPLETED', 'FAILED', 'TIMED_OUT'].includes(state) || op.done === true) break;
    }
    summary.phases.operation = { state: stateOf(op), done: !!(op && op.done), operationId: submission.operationId };
    const dbCode = [
      "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});const id=process.argv[1];",
      "(async()=>{try{const r=await p.query(\"SELECT o.state,o.error_code,(SELECT count(*)::int FROM tasks t WHERE t.operation_id=o.id) AS task_count,(SELECT count(*)::int FROM step_checkpoints s WHERE s.task_id IN (SELECT t.id FROM tasks t WHERE t.operation_id=o.id)) AS checkpoint_count FROM operations o WHERE o.id=$1\",[id]);process.stdout.write(JSON.stringify(r.rows[0]||{}))}catch(e){process.stderr.write('DB_SUMMARY_FAIL');process.exitCode=1}finally{await p.end()}})();",
    ].join('\n');
    summary.phases.db = JSON.parse(docker([...compose, 'exec', '-T', 'orchestrator', 'node', '-e', dbCode, submission.operationId]).trim());
    summary.phases.connectorAvailability = { connectorRevisions: summary.connectorRevisionCount, profileBindings: summary.profileBindingCount };
    if (stateOf(op) === 'SUCCEEDED' || stateOf(op) === 'COMPLETED') {
      phase = 'fetch_result';
      const result = await fetch(base + '/api/v1/operations/' + encodeURIComponent(submission.operationId) + '/result', { headers: { 'x-api-key': apiKey } });
      const body = await getJson(result);
      summary.phases.result = { http: result.status, bodyPresent: !!body };
      if (result.status !== 200) throw new Error('result_HTTP_' + result.status);
      summary.verdict = 'PASS extract result returned';
    } else {
      summary.verdict = 'FAIL extract did not complete on the empty local Connector/profile setup';
      summary.failurePhase = phase;
    }
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    if (!summary.verdict.startsWith('PASS')) process.exitCode = 1;
  } catch (error) {
    summary.failurePhase = phase;
    summary.failure = String(error && error.message || 'unknown').replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 140);
    summary.verdict = 'FAIL or blocked';
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.exitCode = 1;
  }
})();