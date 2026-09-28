/* Targeted plan/code mismatch characterization. No DB/Redis/provider access.
 * One ephemeral loopback Connector HTTP listener, closed in finally.
 * Assertions describe CURRENT defects, not acceptance of desired behavior.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(root, 'services/orchestrator/package.json'));
const ts = localRequire('typescript');
const sourceSha256 = {};
const digest = (s) => createHash('sha256').update(s).digest('hex');
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  sourceSha256[path.relative(root, filename).replaceAll('\\', '/')] = digest(source);
  mod._compile(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
};
const load = (rel) => require(path.join(root, rel));
const { createConnectorServer } = load('services/connector/src/http/server.ts');
const { HmacServiceIdentityVerifier } = load('services/connector/src/identity.ts');
const { createConnectorInvoker } = load('packages/worker-sdk/src/connector-invoker.ts');
const { invokeAdapter } = load('services/connector/src/invoke.ts');
const { toOperationView } = load('services/orchestrator/src/modules/operations/facade.ts');
const { freezePlatformDigests, provisionWorkerIdentity } = load('businesses/example-review/src/registry-tool.ts');
const { OperationViewSchema } = localRequire('@du/contracts');

async function main() {
  const findings = [];
  let invokeCount = 0;
  const server = createConnectorServer({
    management: {}, capabilities: () => [], ready: async () => true,
    identityVerifier: new HmacServiceIdentityVerifier(Buffer.alloc(32, 1)),
    runtime: { invoke: async () => { invokeCount++; throw new Error('must not reach invocation'); } },
  });
  const payload = {
    contractVersion: '1', invocationId: randomUUID(), grant: 'synthetic-unused-grant',
    operationId: randomUUID(), taskId: randomUUID(), stepKey: 'step', bindingSlot: 'reasoning',
    input: { text: 'synthetic' }, deadlineAt: new Date(Date.now() + 60000).toISOString(),
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const invoke = createConnectorInvoker({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
    let failure;
    try { await invoke({}, payload); } catch (err) { failure = { status: err.status, code: err.code, message: err.message }; }
    assert.equal(failure.status, 401);
    assert.equal(invokeCount, 0);
    findings.push({ id: 'MM-01', observation: failure, serviceRuntimeReached: false });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  for (const state of ['IN_FLIGHT', 'CANCELLED', 'PENDING']) {
    let providerCalls = 0;
    const result = await invokeAdapter({ ...payload, tenantId: 'tenant' }, {
      ledger: {
        claim: async () => ({ kind: 'replay', record: { state, nextPollAt: new Date(0).toISOString() } }),
        complete: async () => undefined, fail: async () => undefined, markUnknown: async () => undefined,
      },
      quota: { acquire: async () => ({ leaseId: 'lease', key: 'account', expiresAt: Date.now() + 30000 }), release: async () => undefined },
      quotaKey: 'account', config: { timeoutMs: 1000 },
      adapter: { buildRequest: () => ({}), normalizeResponse: () => ({ data: 'synthetic-result' }) },
      transport: { send: async () => { providerCalls++; return { status: 200, body: {} }; } },
    });
    assert.equal(providerCalls, state === 'PENDING' ? 0 : 1);
    findings.push({ id: state === 'PENDING' ? 'MM-06' : 'MM-07', replayedState: state, providerCalls, outcome: result.state, seam: 'real invokeAdapter; scripted ledger/quota/provider' });
  }

  const view = toOperationView({
    id: randomUUID(), tenant_id: 'tenant', business_id: 'example-review', business_version: '1.0.0',
    action: 'review', state: 'WAITING_INPUT', state_version: 3,
    wait: { waitId: 'wait', inputSchema: { type: 'object' }, expiresAt: '2026-09-24T00:00:00Z' },
  });
  assert.equal(view.wait, undefined);
  const contract = OperationViewSchema.safeParse(view);
  assert.equal(contract.success, false);
  findings.push({ id: 'MM-04/11', waitingInputMetadataExposed: false, schemaErrors: contract.error.issues.map((x) => ({ path: x.path, code: x.code })) });
  const frozen = freezePlatformDigests();
  const lengths = Object.fromEntries(Object.entries(frozen).map(([key, value]) => [key, value.split('sha256:')[1]?.length]));
  findings.push({ id: 'MM-09', declaredDigestLengths: lengths, identityIsDescriptorOnly: typeof provisionWorkerIdentity().aclMatrix.canClaim === 'boolean' });
  for (const [file, sha] of Object.entries(sourceSha256)) {
    assert.equal(digest(fs.readFileSync(path.join(root, file), 'utf8')), sha, `changed during probe: ${file}`);
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), scope: 'loopback HTTP + offline scripted seams; no DB/Redis', findings, sourceSha256 }, null, 2));
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
