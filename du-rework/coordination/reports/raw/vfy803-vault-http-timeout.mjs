import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVaultKv2CredentialWriter } = require('../../../services/orchestrator/dist/modules/connector-credentials/vault-kv2-writer.js');
const sentinel = 'VFY803-TEMPORARY-SECRET-SENTINEL';
const observed = { requests: 0, method: '', path: '', tokenPresent: false, bodyHasSentinel: false, responseClosed: false, signalPresent: false, signalAborted: false };

const server = http.createServer((req, res) => {
  observed.requests += 1;
  observed.method = req.method ?? '';
  observed.path = req.url ?? '';
  observed.tokenPresent = req.headers['x-vault-token'] === 'local-probe-token';
  const chunks = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    observed.bodyHasSentinel = Buffer.concat(chunks).toString('utf8').includes(sentinel);
    // The local endpoint intentionally holds the response beyond the writer's
    // timeout; it is a real HTTP server/socket, not a rejected fetch stub.
    res.on('close', () => { observed.responseClosed = true; });
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { version: 77 } }));
      }
    }, 1000);
  });
});

const listen = (instance) => new Promise((resolve, reject) => {
  instance.once('error', reject);
  instance.listen(0, '127.0.0.1', () => resolve(instance.address().port));
});
const close = (instance) => new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));

const port = await listen(server);
const actualFetch = globalThis.fetch;
const fetchImpl = (input, init = {}) => {
  observed.signalPresent = init.signal instanceof AbortSignal;
  init.signal?.addEventListener('abort', () => { observed.signalAborted = true; }, { once: true });
  return actualFetch(input, init);
};
const writer = createVaultKv2CredentialWriter({
  vaultAddress: `http://127.0.0.1:${port}`,
  token: () => 'local-probe-token',
  requestTimeoutMs: 80,
  fetchImpl,
});
const started = Date.now();
const error = await writer.writeCas(
  { account: 'a1', mount: 'secret', path: 'du/tenants/t1/connectors/c1/accounts/a1', key: 'api_key' },
  sentinel,
  3,
).then(() => null, (caught) => caught);
const elapsedMs = Date.now() - started;
await close(server);

assert.equal(observed.requests, 1);
assert.equal(observed.method, 'POST');
assert.match(observed.path, /^\/v1\/secret\/data\/du\/tenants\/t1\/connectors\/c1\/accounts\/a1$/);
assert.equal(observed.tokenPresent, true);
assert.equal(observed.bodyHasSentinel, true);
assert.equal(observed.signalPresent, true);
assert.equal(observed.signalAborted, true);
assert.equal(error?.name, 'VaultKv2WriterError');
assert.equal(error?.code, 'VAULT_UNAVAILABLE');
assert.equal(error?.retryable, true);
assert.equal(String(error?.message).includes(sentinel), false);
assert.ok(elapsedMs >= 60 && elapsedMs < 1000, `unexpected timeout ${elapsedMs}ms`);

console.log('LOCAL_DELAYED_HTTP_RESULT=PASS');
console.log(`request_count=${observed.requests}; method=${observed.method}; token_present=${observed.tokenPresent}; sentinel_received_by_local_stub=${observed.bodyHasSentinel}`);
console.log(`abort_signal_present=${observed.signalPresent}; abort_signal_fired=${observed.signalAborted}; elapsed_ms=${elapsedMs}; timeout_ms=80`);
console.log(`error_name=${error.name}; code=${error.code}; retryable=${error.retryable}; error_sentinel_leak=false`);
