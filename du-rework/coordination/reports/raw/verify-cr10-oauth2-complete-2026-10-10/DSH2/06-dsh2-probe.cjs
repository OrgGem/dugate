/* DSH2 independent probe for CR10-03/04 (OAuth2 token acquisition + pinned egress).
   READ-ONLY: loads the real working-tree TypeScript sources through a transpile
   hook. Uses synthetic streams and a loopback listener only; no external network,
   no repo writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ORCH = 'D:/Git/dugate/du-rework/orchestrator/services/orchestrator';
const EGRESS = 'D:/Git/dugate/du-rework/orchestrator/packages/egress';
const ts = require(path.join(ORCH, 'node_modules/typescript/lib/typescript.js'));

require.extensions['.ts'] = function loadTs(module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(out, filename);
};

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { OAuth2TokenClient } = require(path.join(ORCH, 'src/modules/webhooks/oauth2-client.ts'));
const { createPinnedFetch, DestinationDeniedError } = require(path.join(EGRESS, 'src/pinned-fetch.ts'));

const TOKEN_URL = 'https://idp.example/token';
const SCOPE = { tenantId: 'tenant-a' };
const CONFIG = { tokenUrl: TOKEN_URL, clientId: 'cid', clientSecret: 'secret', authMethod: 'client_secret_post' };

// A valid JSON token response of exactly 42 bytes with a 1-char access token.
const VALID_JSON = '{"access_token":"a","token_type":"bearer"}';
assert.equal(Buffer.byteLength(VALID_JSON, 'utf8'), 42, 'fixture size changed');

function client(options, config = CONFIG) {
  return new OAuth2TokenClient(config, SCOPE, { retryDelayMs: 0, ...options });
}

function jsonResponse(bodyText, extraHeaders = {}) {
  return new Response(bodyText, {
    status: 200,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** Response whose body streams the given byte chunks; records cancels.
    keepOpen mirrors a real socket that still has data pending: the source never
    closes on its own, so cancelling the reader is observable (a fully buffered
    and already-closed synthetic stream makes cancel a no-op by spec). */
function chunkedResponse(chunks, { headers = {}, cancelSpy = { count: 0 }, keepOpen = false } = {}) {
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        if (keepOpen) return new Promise(() => {});
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() { cancelSpy.count += 1; },
  });
  return { response: new Response(stream, { status: 200, headers: { 'content-type': 'application/json', ...headers } }), cancelSpy };
}

function bytes(text) { return new TextEncoder().encode(text); }

async function expectError(promise, code, messagePart) {
  try { await promise; } catch (error) {
    assert.equal(error.code, code, 'code=' + error.code + ' message=' + error.message);
    if (messagePart) assert.ok(String(error.message).includes(messagePart), 'message=' + error.message);
    return error;
  }
  throw new Error('expected a rejection with ' + code);
}

(async () => {
  // ---- A. CR10-03 bounds -------------------------------------------------
  await check('A1 a body of exactly the cap is accepted; the cap is on bytes, not on the header', async () => {
    let calls = 0;
    const c = client({ maxResponseBytes: 42, fetchImpl: async () => { calls += 1; return jsonResponse(VALID_JSON); } });
    assert.equal(await c.getToken(), 'a');
    assert.equal(calls, 1);
    const over = client({ maxResponseBytes: 41, fetchImpl: async () => { calls += 1; return jsonResponse(VALID_JSON); } });
    await expectError(over.getToken(), 'TOKEN_RESPONSE_TOO_LARGE');
    return 'cap 42 accepted; cap 41 refused with TOKEN_RESPONSE_TOO_LARGE';
  });

  await check('A2 one byte over the cap across MANY 1-byte chunks is refused and the stream is cancelled', async () => {
    const chunks = [];
    for (let i = 0; i < 43; i += 1) chunks.push(bytes('a'));
    const { response, cancelSpy } = chunkedResponse(chunks, { keepOpen: true });
    let calls = 0;
    const c = client({ maxResponseBytes: 42, fetchImpl: async () => { calls += 1; return response; } });
    await expectError(c.getToken(), 'TOKEN_RESPONSE_TOO_LARGE');
    await sleep(20); // cancelQuietly is deliberately fire-and-forget (non-blocking)
    assert.equal(cancelSpy.count, 1, 'reader was not cancelled');
    assert.equal(calls, 1, 'an over-cap refusal must be terminal (no retry)');
    return 'refused at the offending chunk; cancel=1; attempts=1';
  });

  await check('A3 a content-length BELOW the real size does not wave the body through', async () => {
    const { response, cancelSpy } = chunkedResponse([bytes('a'.repeat(43))], { headers: { 'content-length': '5' }, keepOpen: true });
    const c = client({ maxResponseBytes: 42, fetchImpl: async () => response });
    await expectError(c.getToken(), 'TOKEN_RESPONSE_TOO_LARGE');
    await sleep(20); // cancelQuietly is deliberately fire-and-forget (non-blocking)
    assert.equal(cancelSpy.count, 1);
    return 'header said 5, accumulator refused at 43; cancel=1';
  });

  await check('A4 a body without a bounded reader fails closed WITHOUT calling text()', async () => {
    let textCalled = false;
    const fake = {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { cancel: async () => undefined },
      text: async () => { textCalled = true; return VALID_JSON; },
    };
    const c = client({ maxResponseBytes: 42, fetchImpl: async () => fake });
    await expectError(c.getToken(), 'TOKEN_RESPONSE_INVALID');
    assert.equal(textCalled, false, 'text() must never be the fallback');
    return 'TOKEN_RESPONSE_INVALID; text() untouched';
  });

  await check('A5 a null body is treated as empty (no text() fallback)', async () => {
    let textCalled = false;
    const fake = {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: async () => { textCalled = true; return VALID_JSON; },
    };
    const c = client({ maxResponseBytes: 42, fetchImpl: async () => fake });
    await expectError(c.getToken(), 'TOKEN_RESPONSE_INVALID', 'not valid JSON');
    assert.equal(textCalled, false);
    return 'empty body -> JSON parse refusal; text() untouched';
  });

  await check('A6 a body that never ends is cut by the deadline, cancelled, and not retried', async () => {
    let cancelCount = 0;
    const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelCount += 1; } });
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    let calls = 0;
    const c = client({ maxResponseBytes: 4096, timeoutMs: 60, maxAttempts: 3, fetchImpl: async () => { calls += 1; return response; } });
    const started = Date.now();
    await expectError(c.getToken(), 'TOKEN_REQUEST_FAILED', 'deadline');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 400, 'deadline did not cut the read: ' + elapsed + 'ms');
    assert.equal(calls, 1, 'a timed-out acquisition must not retry');
    assert.equal(cancelCount, 1, 'the stalled reader was not cancelled');
    return 'cut at ~' + elapsed + 'ms; attempts=1; cancel=1';
  });

  await check('A7 the client-secret resolver sits INSIDE the deadline and receives an aborted signal', async () => {
    let resolverSignal = null;
    let fetchCalls = 0;
    const c = client({
      timeoutMs: 50,
      fetchImpl: async () => { fetchCalls += 1; return jsonResponse(VALID_JSON); },
    }, { ...CONFIG, clientSecret: (signal) => { resolverSignal = signal; return new Promise(() => {}); } });
    const started = Date.now();
    await expectError(c.getToken(), 'TOKEN_REQUEST_FAILED', 'deadline');
    assert.ok(Date.now() - started < 400, 'slow resolver was not inside the deadline');
    assert.equal(fetchCalls, 0, 'a late fetch was started after the deadline');
    assert.ok(resolverSignal !== null, 'provider received no signal');
    assert.equal(resolverSignal.aborted, true, 'provider signal was not aborted');
    return 'no fetch after timeout; provider signal aborted';
  });

  await check('A8 the retry delay consumes the SAME deadline instead of starting a later attempt', async () => {
    let calls = 0;
    const c = client({
      timeoutMs: 60, maxAttempts: 4, retryDelayMs: 500,
      fetchImpl: async () => { calls += 1; return new Response('nope', { status: 503, headers: { 'content-type': 'application/json' } }); },
    });
    const started = Date.now();
    await expectError(c.getToken(), 'TOKEN_REQUEST_FAILED', 'deadline');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 400, 'backoff was not cut by the deadline: ' + elapsed + 'ms');
    assert.equal(calls, 1, 'a later attempt started after the deadline');
    return 'cut during backoff at ~' + elapsed + 'ms; attempts=1';
  });

  await check('A9 a response that lands AFTER the deadline is cancelled instead of leaked', async () => {
    let cancelCount = 0;
    const stream = new ReadableStream({ pull(c) { c.enqueue(bytes(VALID_JSON)); c.close(); }, cancel() { cancelCount += 1; } });
    const late = new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    const c = client({ timeoutMs: 40, fetchImpl: async () => { await sleep(120); return late; } });
    await expectError(c.getToken(), 'TOKEN_REQUEST_FAILED', 'deadline');
    await sleep(150);
    assert.equal(cancelCount, 1, 'the late response body was not cancelled');
    return 'late response cancelled once';
  });

  // ---- B. CR10-04 pinned egress -----------------------------------------
  await check('B1 an already-aborted signal rejects before DNS is consulted', async () => {
    let resolverCalls = 0;
    const fetchPinned = createPinnedFetch({ resolve: async () => { resolverCalls += 1; return ['93.184.216.34']; } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchPinned('https://pinned.example/x', { signal: controller.signal }), (e) => e.name === 'AbortError');
    assert.equal(resolverCalls, 0, 'DNS ran despite an aborted signal');
    return 'AbortError; resolver calls=0';
  });

  await check('B2 an abort DURING dns resolution wins over a slow resolver', async () => {
    const fetchPinned = createPinnedFetch({ resolve: async () => { await sleep(250); return ['93.184.216.34']; } });
    const controller = new AbortController();
    const started = Date.now();
    const pending = fetchPinned('https://pinned.example/x', { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, (e) => e.name === 'AbortError');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 200, 'abort did not beat the resolver: ' + elapsed + 'ms');
    return 'AbortError after ~' + elapsed + 'ms (resolver needs 250ms)';
  });

  await check('B3 every DNS answer is adjudicated as a SET before any dial', async () => {
    const cases = [
      [['10.0.0.1'], 'private only'],
      [['93.184.216.34', '10.0.0.1'], 'mixed public+private'],
      [['169.254.169.254'], 'link-local metadata'],
      [[], 'empty answer'],
    ];
    for (const [answers, label] of cases) {
      const fetchPinned = createPinnedFetch({ resolve: async () => answers });
      await assert.rejects(fetchPinned('https://pinned.example/x'), (e) => e instanceof DestinationDeniedError,
        label + ' was not denied');
    }
    return cases.length + ' answer sets denied before connect';
  });

  await check('B4 the adjudicated answer is the address actually dialed (Host header keeps the name)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('dialed:' + String(req.headers.host));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const fetchPinned = createPinnedFetch({ resolve: async () => ['127.0.0.1'], allowPrivateNetworks: true });
      const response = await fetchPinned('http://pinned.example:' + port + '/probe');
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.equal(text, 'dialed:pinned.example:' + port);
      return 'loopback dialled, Host preserved: ' + text;
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  await check('B5 a redirect is adjudicated, never followed by egress', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const fetchPinned = createPinnedFetch({ resolve: async () => ['127.0.0.1'], allowPrivateNetworks: true });
      const response = await fetchPinned('http://pinned.example:' + port + '/start');
      assert.equal(response.status, 302, 'egress followed the redirect');
      assert.equal(requests, 1, 'a second hop was requested');
      return '302 returned untouched; requests=1';
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
