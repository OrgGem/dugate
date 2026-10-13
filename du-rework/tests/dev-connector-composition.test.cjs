const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  localConnectorManagementEnvironment,
  localSecrets,
  serviceEnvironment,
  validateRuntimeEnvironment,
} = require('../scripts/runtime-env.cjs');
const standaloneRuntimeEnv = require('../orchestrator/scripts/runtime-env.cjs');

const LOCAL_CONNECTOR_URL = 'http://127.0.0.1:8088';

test('local Orchestrator dev projects a static default Connector route only when none is configured', () => {
  const projected = localConnectorManagementEnvironment({}, {
    services: 'all',
    connectorUrl: LOCAL_CONNECTOR_URL,
  });
  assert.deepEqual(JSON.parse(projected.DU_CONNECTOR_BASE_URLS), { '*': LOCAL_CONNECTOR_URL });

  const custom = localConnectorManagementEnvironment({}, {
    services: 'orchestrator',
    connectorUrl: 'http://127.0.0.1:9090',
  });
  assert.deepEqual(JSON.parse(custom.DU_CONNECTOR_BASE_URLS), { '*': 'http://127.0.0.1:9090' });
  assert.deepEqual(
    standaloneRuntimeEnv.localConnectorManagementEnvironment({}, { services: 'all', connectorUrl: LOCAL_CONNECTOR_URL }),
    projected,
  );

  const explicit = JSON.stringify({ 'custom-connector': 'http://127.0.0.1:9090' });
  const overridden = localConnectorManagementEnvironment({ DU_CONNECTOR_BASE_URLS: explicit }, {
    services: 'orchestrator',
    connectorUrl: LOCAL_CONNECTOR_URL,
  });
  assert.equal(overridden.DU_CONNECTOR_BASE_URLS, explicit);
});

test('single-service modes that do not start Orchestrator keep the route unset', () => {
  for (const services of ['connector', 'workers']) {
    const projected = localConnectorManagementEnvironment({}, { services, connectorUrl: LOCAL_CONNECTOR_URL });
    assert.equal(projected.DU_CONNECTOR_BASE_URLS, undefined);
  }
});

test('Orchestrator and Connector receive the same reusable service identity secret', () => {
  const profile = localSecrets();
  const orchestrator = serviceEnvironment(profile, 'orchestrator');
  const connector = serviceEnvironment(profile, 'connector');
  assert.equal(orchestrator.SERVICE_IDENTITY_SECRET, profile.SERVICE_IDENTITY_SECRET);
  assert.equal(connector.SERVICE_IDENTITY_SECRET, profile.SERVICE_IDENTITY_SECRET);
});

test('local preflight fails clearly when the shared service identity secret is missing', () => {
  const env = {
    ...localSecrets(),
    DATABASE_URL: 'postgresql://localhost/dev',
    REDIS_URL: 'redis://localhost:6379',
    DU_DATA_MODE: 'synthetic',
    DU_SYNTHETIC_DATA_ACK: JSON.stringify({
      mode: 'synthetic-data-exempt',
      reason: 'isolated unit fixture',
      approvedBy: 'test',
      acknowledgedAt: new Date().toISOString(),
      isolatedFromRealData: true,
    }),
  };
  delete env.SERVICE_IDENTITY_SECRET;
  for (const validate of [validateRuntimeEnvironment, standaloneRuntimeEnv.validateRuntimeEnvironment]) {
    assert.throws(
      () => validate(env, { services: 'all' }),
      (error) => /SERVICE_IDENTITY_SECRET is required/.test(error.message)
        && /Orchestrator and Connector must share a Base64-encoded 32-byte secret/.test(error.message),
    );
  }
});

