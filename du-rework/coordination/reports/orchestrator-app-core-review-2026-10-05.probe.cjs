// Read-only review probe. Real source, scripted DB; no live PG/Redis/Vault/provider.
// Run from repository root: node du-rework/coordination/reports/orchestrator-app-core-review-2026-10-05.probe.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = Module;
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const base = path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(base, 'services/orchestrator/package.json'));
const ts = localRequire('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText, filename);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
  if (/^@du\/(contracts|observability|egress)$/.test(name)) {
    return path.join(base, 'packages', name.slice(4), 'src/index.ts');
  }
  return originalResolve.call(this, name, parent, ...rest);
};
const { createRuntimeService } = localRequire('./src/modules/runtime/runtime.ts');
const { createSubmissionService } = localRequire('./src/modules/operations/submission.ts');
const { SaveStepRequestSchema, contentHash, canonicalRequestHash } = localRequire('@du/contracts');
const { HttpError } = localRequire('./src/http/errors.ts');
const { handlePublicRoutes } = localRequire('./src/http/routes/public.ts');
const observations = [];
const result = (rows = []) => ({ rows, rowCount: rows.length });
const taskId = '00000000-0000-4000-8000-000000000010';
const operationId = '00000000-0000-4000-8000-000000000020';
const tenantId = '00000000-0000-4000-8000-000000000030';
const taskRow = {
  id: taskId, lease_epoch: 1, lease_active: false, lease_expires_at: new Date(0),
  state: 'RUNNING', operation_id: operationId, tenant_id: tenantId,
  business_id: 'document-core', business_version: '1', action: 'extract',
  kind: 'root', correlation_id: 'review-only',
};
function scriptedRuntime(options = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });
    if (/^SELECT/.test(normalized)) {
      if (normalized.includes('FROM tasks t JOIN operations') || normalized.startsWith('SELECT lease_epoch, state, operation_id')) {
        return result([{ ...taskRow, ...(options.live ? { lease_active: true } : {}) }]);
      }
      if (normalized.includes('FROM step_checkpoints')) return result(options.existingCheckpoint ? [options.existingCheckpoint] : []);
      if (normalized.includes('FROM business_versions')) return result([{
        manifest: { runtime: { handlerKinds: ['child'] }, actions: [{ name: 'extract', defaultLimits: { maxParallelTasks: 10 } }] },
      }]);
      if (normalized.includes('count(*)')) return result([{ n: 0 }]);
      return result();
    }
    return { rows: [], rowCount: 1 };
  };
  return { calls, runtime: createRuntimeService({ query, tx: async (callback) => callback({ query }) }) };
}
async function probeLease() {
  const spawned = scriptedRuntime();
  const payloadRef = { review: true };
  const ack = await spawned.runtime.spawnChildren(taskId, {
    leaseEpoch: 1, children: [{ taskKey: 'child-review', kind: 'child', payloadRef, payloadHash: contentHash(payloadRef) }],
    joinPolicy: 'all-success', continuationRef: 'continuation-review',
  });
  assert.equal(ack.parentState, 'WAITING_CHILDREN');
  assert(spawned.calls.some((call) => call.sql.startsWith('INSERT INTO tasks')));
  assert(!spawned.calls.some((call) => call.sql.includes('lease_expires_at') || call.sql.includes('lease_active')));
  const waiting = scriptedRuntime();
  const wait = await waiting.runtime.waitInput(taskId, { leaseEpoch: 1, waitKey: 'input-review', inputSchema: { type: 'object' } });
  assert(wait.waitId);
  assert(waiting.calls.some((call) => call.sql.startsWith('INSERT INTO human_waits')));
  assert(!waiting.calls.some((call) => call.sql.includes('lease_expires_at') || call.sql.includes('lease_active')));
  observations.push({ id: 'RCR-02', observed: 'expired RUNNING lease with matching epoch accepts new spawn and human wait',
    spawnWrites: spawned.calls.filter((c) => /^(INSERT|UPDATE)/.test(c.sql)).length,
    waitWrites: waiting.calls.filter((c) => /^(INSERT|UPDATE)/.test(c.sql)).length,
    limit: 'scripted DB; verifies production code issues no lease-expiry predicate' });
}
async function probeCheckpoint() {
  const raw = { leaseEpoch: 1, inputHash: 'review-hash', outputRef: 'review-ref' };
  assert.equal(SaveStepRequestSchema.parse(raw).status, 'SUCCEEDED');
  const { runtime, calls } = scriptedRuntime({ live: true });
  await runtime.saveStep(taskId, 'review-step', raw, 'document-core');
  const insert = calls.find((c) => c.sql.startsWith('INSERT INTO step_checkpoints'));
  assert(insert);
  assert.equal(insert.params[5], undefined);
  assert(!/DEFAULT/.test(insert.sql));
  observations.push({ id: 'RCR-04', observed: 'contract-valid omitted status is bound as undefined in explicit NOT NULL status column',
    expectedDefault: SaveStepRequestSchema.parse(raw).status,
    actualBoundStatus: insert.params[5] === undefined ? 'undefined (pg binds NULL)' : insert.params[5],
    limit: 'scripted DB captures parameter; NOT NULL rejection follows from migration, no live PG used' });
  const session = scriptedRuntime({ live: true });
  await session.runtime.saveStep(taskId, 'review-session', { ...raw, status: 'SUCCEEDED', sessionRef: 'review-session-ref' }, 'document-core');
  const sessionInsert = session.calls.find((c) => c.sql.startsWith('INSERT INTO step_checkpoints'));
  assert(!JSON.stringify(sessionInsert).includes('review-session-ref'));
  observations.push({ id: 'RCR-05', observed: 'saveStep ignores provided sessionRef: absent from persisted SQL and parameters', limit: 'scripted DB; claim projection independently checked in source' });
}
async function probeIdempotency() {
  const calls = [];
  const submission = { input: { text: 'review-only' } };
  const stored = { operation_id: operationId, request_hash: canonicalRequestHash({ input: submission.input }) };
  const db = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM submission_keys')) return result([stored]);
    if (sql.includes('FROM business_versions')) return result(); // active version disabled after accepted submit
    throw new Error('unexpected query in review probe');
  } };
  const service = createSubmissionService(db, {}, {});
  await assert.rejects(service.submit({ tenantId, apiKeyId: taskId, businessId: 'document-core', action: 'extract',
    idempotencyKey: 'review-key', submission }), (error) => error instanceof HttpError && error.status === 404);
  assert(!calls.some((sql) => sql.includes('FROM submission_keys')));
  observations.push({ id: 'RCR-03', observed: 'same submission/key fails 404 after active version disabled; existing idempotency record never queried',
    limit: 'scripted DB holding a matching unexpired record; real submission source' });
}
function probeHttpBoundary() {
  const filename = path.join(base, 'services/orchestrator/src/app/bootstrap/create-app.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'createServer') callback = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(callback);
  const compiled = ts.transpileModule(`const handler = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', `
    const {createServer}=require('node:http');const {randomUUID}=require('node:crypto');const net=require('node:net');
    ${compiled}
    const server=createServer(handler);server.listen(0,'127.0.0.1',()=>{
      const socket=net.connect(server.address().port,'127.0.0.1',()=>socket.write('GET /health HTTP/1.1\\r\\nHost: [\\r\\nConnection: close\\r\\n\\r\\n'));
      socket.on('error',()=>{});
    });
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1, child.stderr);
  assert(child.stderr.includes('ERR_INVALID_URL'));
  observations.push({ id: 'RCR-01', observed: 'raw unauthenticated HTTP Host:[ terminates child listener process with uncaught ERR_INVALID_URL',
    childExit: child.status, limit: 'exact production callback extracted by TS AST; local child, no full application boot or infrastructure' });
}
async function probeLegacyDownload() {
  const content = 'Review output bytes which must be sent unchanged.';
  const ctx = {
    method: 'GET', pathname: `/api/v1/operations/${operationId}/download`,
    headers: { 'x-api-key': 'review-only-key' }, searchParams: new URLSearchParams(),
    body: undefined, correlationId: 'review-only', config: {},
    db: { query: async (sql) => {
      if (sql.includes('FROM api_keys')) return result([{ id: taskId, tenant_id: tenantId }]);
      if (sql.includes('SELECT * FROM operations')) return result([{ id: operationId, state: 'SUCCEEDED', output_format: 'txt' }]);
      if (sql.includes('SELECT output_content')) return result([{ output_content: content }]);
      throw new Error('unexpected legacy download query');
    } },
  };
  const response = await handlePublicRoutes(ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(content)));
  assert.equal(response.raw, undefined);
  assert.equal(JSON.stringify(response.body), '{}');
  observations.push({ id: 'RCR-06', observed: 'mounted public legacy download drops loaded bytes and returns JSON {}',
    declaredContentLength: Number(response.headers['content-length']), actualJsonBytes: Buffer.byteLength(JSON.stringify(response.body)),
    limit: 'real handlePublicRoutes -> legacy mount/host, scripted DB; listener serializer independently checked in source' });
}
(async () => {
  probeHttpBoundary(); await probeLease(); await probeIdempotency(); await probeCheckpoint(); await probeLegacyDownload();
  const files = ['services/orchestrator/src/app/bootstrap/create-app.ts', 'services/orchestrator/src/modules/runtime/runtime.ts',
    'services/orchestrator/src/modules/operations/submission.ts', 'services/orchestrator/src/http/routes/runtime.ts',
    'services/orchestrator/migrations/0001_platform_v1.sql', 'packages/contracts/src/runtime.ts',
    'services/orchestrator/src/http/routes/public.ts', 'services/orchestrator/src/compat/legacy-http-mount.ts',
    'services/orchestrator/src/compat/legacy-host-adapter.ts'];
  const digests = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex')]));
  const output = JSON.stringify({ timestamp: new Date().toISOString(), scope: 'review probes; confirmed defects, not product acceptance',
    infrastructure: 'offline; scripted DB; loopback child HTTP only', observations, digests }, null, 2);
  fs.writeFileSync(path.join(__dirname, 'orchestrator-app-core-review-2026-10-05.raw.json'), output + '\n', 'utf8');
  console.log(output);
})().catch((error) => { console.error(error); process.exitCode = 1; });
