'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { serviceEnvironment } = require('../scripts/runtime-env.cjs');

test('standalone development projects a stable local-only Connector runtime identity by port', () => {
  const env = { NODE_ENV: 'development', CONNECTOR_PORT: '8088' };
  const projected = serviceEnvironment(env, 'connector');
  const repeated = serviceEnvironment(env, 'connector');

  assert.equal(projected.CONNECTOR_RUNTIME_SLOT, 'blue');
  assert.equal(projected.CONNECTOR_RUNTIME_IDENTITY, 'connector-local-dev-8088');
  assert.equal(projected.CONNECTOR_REPLICA_ID, 'connector-local-8088');
  assert.equal(projected.CONNECTOR_RUNTIME_REVISION, 'local-dev');
  assert.match(
    projected.CONNECTOR_RUNTIME_IMAGE_DIGEST,
    /^local-dev-not-an-image@sha256:[a-f0-9]{64}$/,
  );
  assert.equal(projected.CONNECTOR_RUNTIME_IMAGE_DIGEST, repeated.CONNECTOR_RUNTIME_IMAGE_DIGEST);
  assert.equal(projected.CONNECTOR_REPLICA_ID, repeated.CONNECTOR_REPLICA_ID);

  const otherPort = serviceEnvironment({ ...env, CONNECTOR_PORT: '8089' }, 'connector');
  assert.equal(otherPort.CONNECTOR_REPLICA_ID, 'connector-local-8089');
  assert.notEqual(otherPort.CONNECTOR_REPLICA_ID, projected.CONNECTOR_REPLICA_ID);
  assert.equal(otherPort.CONNECTOR_RUNTIME_IMAGE_DIGEST, projected.CONNECTOR_RUNTIME_IMAGE_DIGEST);
});

test('local runtime identity fallback requires development and all five keys to be unset', () => {
  const base = { CONNECTOR_PORT: '8088' };
  for (const nodeEnv of ['production', 'test', undefined]) {
    const projected = serviceEnvironment({ ...base, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) }, 'connector');
    assert.equal(projected.CONNECTOR_RUNTIME_SLOT, undefined);
    assert.equal(projected.CONNECTOR_REPLICA_ID, undefined);
  }

  const empty = serviceEnvironment({
    ...base,
    NODE_ENV: 'development',
    CONNECTOR_RUNTIME_SLOT: '',
    CONNECTOR_RUNTIME_IDENTITY: '',
    CONNECTOR_REPLICA_ID: '',
    CONNECTOR_RUNTIME_REVISION: '',
    CONNECTOR_RUNTIME_IMAGE_DIGEST: '',
  }, 'connector');
  assert.equal(empty.CONNECTOR_RUNTIME_SLOT, 'blue');
  assert.equal(empty.CONNECTOR_REPLICA_ID, 'connector-local-8088');

  const partial = serviceEnvironment({
    ...base,
    NODE_ENV: 'development',
    CONNECTOR_RUNTIME_SLOT: 'green',
  }, 'connector');
  assert.equal(partial.CONNECTOR_RUNTIME_SLOT, 'green');
  for (const key of [
    'CONNECTOR_RUNTIME_IDENTITY',
    'CONNECTOR_REPLICA_ID',
    'CONNECTOR_RUNTIME_REVISION',
    'CONNECTOR_RUNTIME_IMAGE_DIGEST',
  ]) {
    assert.equal(partial[key], undefined);
  }

  const whitespace = serviceEnvironment({
    ...base,
    NODE_ENV: 'development',
    CONNECTOR_RUNTIME_SLOT: ' ',
  }, 'connector');
  assert.equal(whitespace.CONNECTOR_RUNTIME_SLOT, ' ');
  assert.equal(whitespace.CONNECTOR_REPLICA_ID, undefined);
});
