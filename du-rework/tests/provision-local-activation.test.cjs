'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enableAndActivateBusinessVersion } = require('../scripts/provision-local-activation.cjs');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('uses fresh activation CAS revisions for enable and activate', async () => {
  const calls = [];
  const revisions = [10, 11];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    if (init.method === 'GET') return jsonResponse({ activationRevision: revisions.shift() });
    return jsonResponse({ activationRevision: init.body.includes('10') ? 11 : 12 });
  };

  const result = await enableAndActivateBusinessVersion({
    fetchImpl,
    internalUrl: 'http://runtime.test/',
    adminToken: 'offline-test-token',
    businessId: 'document-core',
    version: '1.1.0',
  });

  assert.equal(result.enabled.status, 200);
  assert.equal(result.activated.status, 200);
  assert.deepEqual(calls.map(({ method, body }) => [method, body]), [
    ['GET', undefined],
    ['PUT', { expectedActivationRevision: 10 }],
    ['GET', undefined],
    ['PUT', { expectedActivationRevision: 11 }],
  ]);
  assert.match(calls[1].url, /\/1\.1\.0\/enable$/);
  assert.match(calls[3].url, /\/1\.1\.0\/activate$/);
});

test('surfaces an activation CAS conflict without refreshing or retrying', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push({ method: init.method, body: init.body && JSON.parse(init.body) });
    if (init.method === 'GET') return jsonResponse({ activationRevision: 7 });
    return jsonResponse({ code: 'STATE_CONFLICT' }, 409);
  };

  await assert.rejects(
    enableAndActivateBusinessVersion({
      fetchImpl,
      internalUrl: 'http://runtime.test',
      adminToken: 'offline-test-token',
      businessId: 'document-core',
      version: '1.1.0',
    }),
    /activation revision conflict; no automatic retry was attempted/,
  );
  assert.deepEqual(calls, [
    { method: 'GET', body: undefined },
    { method: 'PUT', body: { expectedActivationRevision: 7 } },
  ]);
});

test('does not activate with a concurrent revision newer than its successful enable', async () => {
  const calls = [];
  const revisions = [7, 9];
  const fetchImpl = async (_url, init) => {
    calls.push({ method: init.method, body: init.body && JSON.parse(init.body) });
    if (init.method === 'GET') return jsonResponse({ activationRevision: revisions.shift() });
    return jsonResponse({ activationRevision: 8 });
  };

  await assert.rejects(
    enableAndActivateBusinessVersion({
      fetchImpl,
      internalUrl: 'http://runtime.test',
      adminToken: 'offline-test-token',
      businessId: 'document-core',
      version: '1.1.0',
    }),
    /enable returned 8, current 9\); activation was not attempted/,
  );
  assert.deepEqual(calls, [
    { method: 'GET', body: undefined },
    { method: 'PUT', body: { expectedActivationRevision: 7 } },
    { method: 'GET', body: undefined },
  ], 'the helper neither activates the newer revision nor retries the CAS');
});
