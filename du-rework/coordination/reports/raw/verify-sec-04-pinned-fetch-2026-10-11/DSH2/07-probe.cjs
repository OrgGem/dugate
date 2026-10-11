/* DSH2 independent probe for the SEC-OR-04 fix in packages/egress.
   Runs as its own process. Loopback only; no external network; read-only. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'D:/Git/dugate/du-rework/orchestrator';
const ts = require(path.join(ROOT, 'services/orchestrator/node_modules/typescript/lib/typescript.js'));

require.extensions['.ts'] = function loadTs(module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(out, filename);
};

const { createPinnedFetch } = require(path.join(ROOT, 'packages/egress/src/pinned-fetch.ts'));
const PAYLOAD = 'pinned-fetch probe payload - 200 body must stay readable';

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}

(async () => {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/204') { res.writeHead(204); res.end(); return; }
    if (url === '/205') { res.writeHead(205); res.end(); return; }
    if (url === '/304') { res.writeHead(304); res.end(); return; }
    if (url === '/stall') { return; } // never responds
    if (url === '/200') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(PAYLOAD)) });
      res.end(PAYLOAD);
      return;
    }
    if (url === '/head') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(PAYLOAD)) });
      res.end(PAYLOAD);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const fetchPinned = createPinnedFetch({ allowHosts: new Set(['127.0.0.1']), allowPrivateNetworks: true });

  for (const status of [204, 205, 304]) {
    await check('S' + status + ' a ' + status + ' response resolves with a NULL body and does not kill the process', async () => {
      const response = await fetchPinned(base + '/' + status);
      assert.equal(response.status, status, 'status=' + response.status);
      assert.equal(response.body, null, 'body was not null: ' + String(response.body));
      return 'status=' + status + ' body=null';
    });
  }

  await check('HEAD returns a null body (no stream is handed to the caller)', async () => {
    const response = await fetchPinned(base + '/head', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.body, null, 'HEAD body was not null: ' + String(response.body));
    return 'status=200 body=null';
  });

  await check('a 200 body is still streamed byte-for-byte (no regression)', async () => {
    const response = await fetchPinned(base + '/200');
    assert.equal(response.status, 200);
    assert.ok(response.body, 'body missing');
    const text = await response.text();
    assert.equal(text, PAYLOAD);
    return 'text length=' + text.length;
  });

  await check('the connection stays usable after the null-body paths (drained, not hung)', async () => {
    const first = await fetchPinned(base + '/204');
    assert.equal(first.status, 204);
    const second = await fetchPinned(base + '/200');
    const text = await second.text();
    assert.equal(text, PAYLOAD);
    return '204 then 200 on the same client both completed';
  });

  await check('the timeout bound still rejects a stalled response', async () => {
    const bounded = createPinnedFetch({ allowHosts: new Set(['127.0.0.1']), allowPrivateNetworks: true, timeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(() => bounded(base + '/stall'), (e) => e.name === 'TimeoutError' || /timeout/i.test(String(e.message)));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, 'took too long: ' + elapsed + 'ms');
    return 'rejected after ~' + elapsed + 'ms';
  });

  await new Promise((resolve) => server.close(resolve));

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  console.log('PROCESS_SURVIVED');
  process.exitCode = failed.length === 0 ? 0 : 1;
})().catch((error) => {
  console.log('TOP_LEVEL_CATCH ' + String((error && error.message) || error));
  process.exitCode = 2;
});
