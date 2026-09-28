/* Offline characterization of review findings, NOT regression acceptance.
 * Run: node du-rework/coordination/review-evidence/code-review-2026-09-23.cjs
 * No DB, Redis, provider HTTP, installation, or product-source writes.
 * Intentionally asserts current defects; replace with desired-behavior tests
 * in the owning packages when fixes are implemented.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const packageRequire = createRequire(path.join(root, 'services/orchestrator/package.json'));
const ts = packageRequire('typescript');
const hashes = {};
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  hashes[path.relative(root, filename).replaceAll('\\', '/')] = hash(source);
  mod._compile(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
};
const { createUsageService } = require(path.join(root, 'services/orchestrator/src/modules/usage/usage.ts'));
const { createConnectorProxy } = require(path.join(root, 'services/orchestrator/src/modules/connectors/connectors.ts'));
const { deliverWebhooks } = require(path.join(root, 'services/orchestrator/src/modules/webhooks/webhooks.ts'));
const { createSubmissionService } = require(path.join(root, 'services/orchestrator/src/modules/operations/submission.ts'));
const { createRuntimeService } = require(path.join(root, 'services/orchestrator/src/modules/runtime/runtime.ts'));
const { createTempWorkspace, downloadArtifact } = require(path.join(root, 'packages/worker-sdk/src/artifact-streams.ts'));
const { CallbackConfigSchema, canonicalRequestHash } = packageRequire('@du/contracts');
const results = [];
const record = (id, observation) => results.push({ id, observation });
const response = (rows) => ({ rows, rowCount: rows.length });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Public callback value reaches fetch unchanged. Fetch is intercepted: no network.
  const callback = 'http://127.0.0.1:12345/private';
  assert.equal(CallbackConfigSchema.safeParse({ url: callback }).success, true);
  let captured;
  const whQuery = async (sql) => response(sql.startsWith('SELECT') ? [{
    delivery_id: 'review-only', destination_url: callback, payload: {}, attempts: 0, max_attempts: 5,
  }] : []);
  await deliverWebhooks({ query: whQuery, tx: (fn) => fn({ query: whQuery }) }, {
    secret: 'synthetic-review-secret',
    fetchFn: async (url, init) => { captured = { url, hasSignal: !!init.signal, redirect: init.redirect }; return { status: 204 }; },
  });
  assert.equal(captured.url, callback);
  assert.equal(captured.hasSignal, false);
  record('CR-01/02', { privateCallbackDispatched: captured.url, hasAbortSignal: captured.hasSignal, explicitRedirectPolicy: captured.redirect ?? null });

  // An expired idempotency row is excluded by the fast lookup, then replayed by the tx lookup.
  const input = { input: {} };
  const requestHash = canonicalRequestHash({ input: {} });
  const queries = [];
  const db = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('FROM business_versions')) return response([{
        version: '1', manifest: { actions: [{ name: 'review', inputSchema: { type: 'object' } }] }, digest: 'x', queue: 'q',
      }]);
      if (sql.includes('FROM submission_keys')) return response([]);
      if (sql.includes('FROM operations')) return response([{
        id: 'expired-operation', tenant_id: 'tenant', business_id: 'review', business_version: '1',
        action: 'review', state: 'SUCCEEDED', state_version: 1,
        created_at: new Date(0), updated_at: new Date(0), deadline_at: null,
      }]);
      throw new Error('unexpected SQL');
    },
    tx: (fn) => fn({ query: async (sql) => {
      queries.push(sql);
      assert(sql.includes('FROM submission_keys'));
      return response([{ operation_id: 'expired-operation', request_hash: requestHash }]);
    } }),
  };
  const context = { tenantId: 'tenant', apiKeyId: 'key', businessId: 'review', action: 'review', idempotencyKey: 'expired-key', submission: input };
  const replay = await createSubmissionService(db, {}, { resolveBinding: async () => ({ mode: 'legacy' }) }).submit(context);
  assert.equal(replay.replayed, true);
  assert(!queries.find((q) => q.includes('FOR UPDATE')).includes('expires_at'));
  record('CR-04', { expiredKeyReplayed: replay.replayed, operationId: replay.operation.id, seam: 'scripted DB rows; real submission service' });
  let lookupCount = 0;
  await assert.rejects(createSubmissionService({ query: async () => { lookupCount++; return response([]); } }, {}, {}).submit(context), (err) => err.status === 404);
  assert.equal(lookupCount, 1);
  record('CR-05', 'No active version -> 404 before looking up an existing idempotency key');

  // A cancelled/expired lease with the same epoch is renewed (SQL lacks state/expiry guards).
  let updateSql;
  const runtime = createRuntimeService({ query: async (sql) => {
    if (sql.startsWith('SELECT')) return response([{ lease_epoch: 3, lease_expires_at: new Date(0).toISOString() }]);
    updateSql = sql;
    return response([{ id: 'expired-task' }]);
  } });
  const hb = await runtime.heartbeatTask('expired-task', 3);
  assert(!updateSql.includes("state='RUNNING'"));
  assert(!updateSql.includes('lease_expires_at >'));
  assert.equal(hb.cancelRequested, false);
  record('CR-06', { renewedExpiredEpoch: true, cancelRequested: hb.cancelRequested, seam: 'scripted DB rows; SQL predicate inspection' });

  // Three normal provider-pending deliveries exhaust the task's default failure budget.
  const pendingWrites = [];
  const pendingQuery = async (sql) => {
    if (sql.includes('SELECT t.lease_epoch')) return response([{
      lease_epoch: 3, state: 'RUNNING', operation_id: 'op', attempt: 3, max_attempts: 3,
      kind: 'root', business_id: 'review', business_version: '1', action: 'review', correlation_id: 'c',
    }]);
    pendingWrites.push(sql);
    return response([]);
  };
  const pendingRuntime = createRuntimeService({ tx: (fn) => fn({ query: pendingQuery }) });
  const failed = await pendingRuntime.failTask('task', { leaseEpoch: 3, errorCode: 'PROVIDER_PENDING', retryable: true, retryAfterMs: 5000 });
  assert.equal(failed.operationState, 'FAILED');
  record('CR-07', { thirdPendingPoll: failed.operationState, errorCode: 'PROVIDER_PENDING', seam: 'real failTask with scripted attempt budget' });

  // Timeout and caller abort stop propagating as soon as headers arrive.
  const workspace = await createTempWorkspace('review-only');
  try {
    const outer = new AbortController();
    let bodyController;
    let innerSignal;
    let settled = false;
    const promise = downloadArtifact(workspace, 'test.bin', 'http://fixture.invalid/file', {
      maxBytes: 100, timeoutMs: 10, signal: outer.signal,
      fetcher: async (_url, init) => {
        innerSignal = init.signal;
        return new Response(new ReadableStream({ start(c) { bodyController = c; c.enqueue(new Uint8Array([1])); } }));
      },
    }).finally(() => { settled = true; });
    await delay(40);
    outer.abort();
    await delay(20);
    const observed = { settledAfterTimeoutAndAbort: settled, fetchSignalAborted: innerSignal.aborted };
    bodyController.close(); // bounded cleanup: never leave the test stream running
    await promise;
    assert.deepEqual(observed, { settledAfterTimeoutAndAbort: false, fetchSignalAborted: false });
    record('CR-08', observed);

    // Faithful HTTP body encoding from server.ts blob route + JSON responder.
    // This is a wire fixture, not a claim that a real HTTP server was started.
    const original = Buffer.from('{"output":{"ok":true}}');
    const wireBody = JSON.stringify(original.toString('base64'));
    const downloaded = await downloadArtifact(workspace, 'checkpoint.json', 'http://fixture.invalid/blob', {
      maxBytes: 1024,
      fetcher: async () => new Response(wireBody, { headers: { 'content-type': 'application/octet-stream' } }),
    });
    const stored = fs.readFileSync(downloaded.path);
    assert.equal(stored.equals(original), false);
    assert.equal(typeof JSON.parse(stored.toString()), 'string');
    record('CR-13', { original: original.toString(), downloaded: stored.toString(), checkpointDecodedType: typeof JSON.parse(stored.toString()) });
  } finally { await workspace.dispose(); }

  // Body read errors are swallowed and a 200 header is reported healthy.
  const proxy = createConnectorProxy({ baseUrlFor: () => 'http://fixture.invalid' }, {
    fetchFn: async () => ({ status: 200, arrayBuffer: async () => { throw new Error('body aborted'); } }),
  });
  const probe = await proxy.testConnector('fixture');
  assert.equal(probe.ok, true);
  record('CR-09', { failedBodyReportedHealthy: probe.ok });

  // Each input amount is a safe integer; their sum need not be.
  const rows = [Number.MAX_SAFE_INTEGER, 2].map((n) => ({ operation_id: 'op', payload: {
    units: { inputTokens: n, outputTokens: 0 }, costMicrousd: 0, measurement: 'measured',
  } }));
  const summary = await createUsageService({ query: async () => response(rows) }).getUsageSummary('tenant', new Date(0), new Date());
  assert.equal(Number.isSafeInteger(summary.totals.inputTokens), false);
  record('CR-10', { returnedInputTokens: summary.totals.inputTokens, exactExpected: (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString() });

  for (const [file, digest] of Object.entries(hashes)) {
    assert.equal(hash(fs.readFileSync(path.join(root, file), 'utf8')), digest, 'Source changed during review: ' + file);
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), environment: 'offline; scripted DB/fetch seams, no live services', results, sourceSha256: hashes }, null, 2));
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
