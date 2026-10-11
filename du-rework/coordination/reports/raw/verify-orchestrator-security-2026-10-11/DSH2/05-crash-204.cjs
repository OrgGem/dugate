/* DSH2 SEC-04 crash probe: an upstream 204 must not be able to kill the process.
   Runs as its own process (the review's crash probe did the same). Loopback only:
   no external network, no product file written. */
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

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/probe';

  console.log(JSON.stringify({
    probe: 'pinned-fetch-204',
    runtime: process.version,
    upstreamStatus: 204,
    scope: 'isolated node process, loopback only',
  }));

  const fetchPinned = createPinnedFetch({ allowHosts: new Set(['127.0.0.1']), allowPrivateNetworks: true });
  try {
    const response = await fetchPinned(url);
    console.log('CALLER_CAUGHT_NOTHING status=' + response.status);
  } catch (error) {
    console.log('CALLER_CAUGHT ' + (error && error.name) + ': ' + (error && error.message));
  }
  await new Promise((resolve) => server.close(resolve));
  console.log('PROCESS_SURVIVED');
})().catch((error) => {
  console.log('TOP_LEVEL_CATCH ' + String(error && error.message || error));
});
