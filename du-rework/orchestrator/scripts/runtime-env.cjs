// Shared environment helpers for orchestrator standalone development.
const { createHmac, randomBytes } = require('node:crypto');

function signedConnectorToken(identitySecret, now = Date.now()) {
  const key = Buffer.from(identitySecret || '', 'base64');
  if (key.length !== 32) throw new Error('SERVICE_IDENTITY_SECRET must encode 32 bytes');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'local-business-workers', aud: 'connector', scopes: ['connector:invoke'],
    exp: Math.floor(now / 1000) + 86400,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

function serviceEnvironment(env, service) {
  const result = { ...env };
  if (service === 'connector') {
    result.INVOCATION_GRANT_SECRET = env.CONNECTOR_INVOCATION_GRANT_SECRET
      || Buffer.from(env.INVOCATION_GRANT_SECRET || '', 'utf8').toString('base64');
    result.REDIS_KEY_PREFIX = env.CONNECTOR_REDIS_PREFIX || env.REDIS_KEY_PREFIX || 'du:connector:';
  }
  return result;
}

function validateRuntimeEnvironment(env, { services = 'all' } = {}) {
  const required = ['DATABASE_URL', 'REDIS_URL', 'SERVICE_IDENTITY_SECRET', 'INVOCATION_GRANT_SECRET'];
  if (services === 'all' || services === 'orchestrator') {
    required.push('RUNTIME_TOKEN', 'ADMIN_TOKEN', 'ENCRYPTION_KEY', 'ADMIN_SHELL_COOKIE_SECRET');
  }
  for (const key of required) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  for (const key of ['SERVICE_IDENTITY_SECRET', 'CONNECTOR_ENCRYPTION_KEY']) {
    if (env[key] && Buffer.from(env[key], 'base64').length !== 32) {
      throw new Error(`${key} must encode 32 bytes`);
    }
  }
  if (!/^[\x21-\x7e]{32}$/.test(env.INVOCATION_GRANT_SECRET)) {
    throw new Error('INVOCATION_GRANT_SECRET must be 32 raw ASCII bytes; use a fresh profile or migrate the legacy Base64 key');
  }
  if (env.CONNECTOR_INVOCATION_GRANT_SECRET && !Buffer.from(env.CONNECTOR_INVOCATION_GRANT_SECRET, 'base64').equals(Buffer.from(env.INVOCATION_GRANT_SECRET, 'utf8'))) {
    throw new Error('CONNECTOR_INVOCATION_GRANT_SECRET must be Base64 of INVOCATION_GRANT_SECRET');
  }
  if (services !== 'orchestrator') {
    let keys;
    try { keys = JSON.parse(env.CONNECTOR_INVOCATION_ENCRYPTION_KEYS || '{}'); }
    catch { throw new Error('CONNECTOR_INVOCATION_ENCRYPTION_KEYS must be valid JSON'); }
    if (!keys.keyRef || !Number.isInteger(keys.activeVersion) || Buffer.from(keys.keys?.[keys.activeVersion] || '', 'base64').length !== 32) {
      throw new Error('CONNECTOR_INVOCATION_ENCRYPTION_KEYS requires keyRef, activeVersion and a Base64 32-byte active key');
    }
  }
}

function localSecrets(now = Date.now()) {
  const rawGrant = randomBytes(16).toString('hex');
  const identity = randomBytes(32).toString('base64');
  return {
    RUNTIME_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_TOKEN: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_SHELL_COOKIE_SECRET: randomBytes(32).toString('hex'),
    SERVICE_IDENTITY_SECRET: identity,
    INVOCATION_GRANT_SECRET: rawGrant,
    CONNECTOR_INVOCATION_GRANT_SECRET: Buffer.from(rawGrant).toString('base64'),
    CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: JSON.stringify({
      keyRef: 'du-connector-invocation-v1',
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') }
    }),
    CONNECTOR_SERVICE_TOKEN: signedConnectorToken(identity, now),
  };
}

module.exports = {
  serviceEnvironment,
  validateRuntimeEnvironment,
  signedConnectorToken,
  localSecrets,
};
