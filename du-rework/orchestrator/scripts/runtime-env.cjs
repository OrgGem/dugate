// Shared environment helpers for orchestrator standalone development.
const { createHash, createHmac, randomBytes } = require('node:crypto');

const LOCAL_WORKER_TOKEN_KEYS = {
  'document-core': 'DOCUMENT_CORE_RUNTIME_TOKEN',
  'lc-checker': 'LC_RUNTIME_TOKEN',
  'example-review': 'EXAMPLE_REVIEW_RUNTIME_TOKEN',
};

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
  // Keep the original local-dev-v1 derivation stable so existing local secret
  // rows remain readable. Production now derives the separate retained
  // encryption-key-v1 key in the Orchestrator boot parser when no explicit
  // Secret Catalog keyring is supplied.
  if (service === 'orchestrator' && env.NODE_ENV === 'development'
      && !env.DU_SECRET_CATALOG_ACTIVE_KEY_VERSION?.trim()
      && !env.DU_SECRET_CATALOG_KEYRING_JSON?.trim()
      && typeof env.ENCRYPTION_KEY === 'string' && env.ENCRYPTION_KEY.length > 0) {
    const version = 'local-dev-v1';
    const key = createHmac('sha256', Buffer.from(env.ENCRYPTION_KEY, 'utf8'))
      .update('du-secret-catalog/local-development/v1', 'utf8')
      .digest('base64');
    result.DU_SECRET_CATALOG_ACTIVE_KEY_VERSION = version;
    result.DU_SECRET_CATALOG_KEYRING_JSON = JSON.stringify({ [version]: key });
  }
  if (service === 'connector') {
    result.INVOCATION_GRANT_SECRET = env.CONNECTOR_INVOCATION_GRANT_SECRET
      || Buffer.from(env.INVOCATION_GRANT_SECRET || '', 'utf8').toString('base64');
    result.REDIS_KEY_PREFIX = env.CONNECTOR_REDIS_PREFIX || env.REDIS_KEY_PREFIX || 'du:connector:';

    // Standalone local development needs a runtime owner for Connector's
    // backup-effect fence. This deterministic identity is only a local
    // development marker; its digest is explicitly not image provenance.
    const runtimeIdentityKeys = [
      'CONNECTOR_RUNTIME_SLOT',
      'CONNECTOR_RUNTIME_IDENTITY',
      'CONNECTOR_REPLICA_ID',
      'CONNECTOR_RUNTIME_REVISION',
      'CONNECTOR_RUNTIME_IMAGE_DIGEST',
    ];
    if (env.NODE_ENV === 'development'
        && runtimeIdentityKeys.every((key) => env[key] === undefined || env[key] === '')) {
      const port = String(env.CONNECTOR_PORT ?? env.PORT ?? '8080');
      const markerDigest = createHash('sha256')
        .update('dugate-connector-local-dev-not-an-image-v1', 'utf8')
        .digest('hex');
      Object.assign(result, {
        CONNECTOR_RUNTIME_SLOT: 'blue',
        CONNECTOR_RUNTIME_IDENTITY: `connector-local-dev-${port}`,
        CONNECTOR_REPLICA_ID: `connector-local-${port}`,
        CONNECTOR_RUNTIME_REVISION: 'local-dev',
        CONNECTOR_RUNTIME_IMAGE_DIGEST: `local-dev-not-an-image@sha256:${markerDigest}`,
      });
    }
  }
  return result;
}

function localConnectorManagementEnvironment(env, { services = 'all', connectorUrl } = {}) {
  const result = { ...env };
  if (!['all', 'orchestrator'].includes(services) || result.DU_CONNECTOR_BASE_URLS !== undefined) return result;
  if (typeof connectorUrl !== 'string' || connectorUrl.trim() === '') {
    throw new Error('CONNECTOR_URL is required to compose local Connector management');
  }
  result.DU_CONNECTOR_BASE_URLS = JSON.stringify({ '*': connectorUrl });
  return result;
}

function validateRuntimeEnvironment(env, { services = 'all' } = {}) {
  const required = ['DATABASE_URL', 'REDIS_URL', 'SERVICE_IDENTITY_SECRET', 'INVOCATION_GRANT_SECRET'];
  if (services === 'all' || services === 'orchestrator') {
    required.push('RUNTIME_TOKEN', 'ADMIN_TOKEN', 'ENCRYPTION_KEY', 'ADMIN_SHELL_COOKIE_SECRET');
  }
  for (const key of required) {
    if (!env[key]) {
      if (key === 'SERVICE_IDENTITY_SECRET') {
        throw new Error('SERVICE_IDENTITY_SECRET is required; Orchestrator and Connector must share a Base64-encoded 32-byte secret');
      }
      throw new Error(`${key} is required`);
    }
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
  const map = Object.fromEntries(Object.keys(LOCAL_WORKER_TOKEN_KEYS).map(b => [b, randomBytes(32).toString('hex')]));
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
    WORKER_IDENTITY_TOKENS_BY_BUSINESS: JSON.stringify(map),
    ...Object.fromEntries(Object.entries(LOCAL_WORKER_TOKEN_KEYS).map(([business, key]) => [key, map[business]])),
    CONNECTOR_SERVICE_TOKEN: signedConnectorToken(identity, now),
  };
}

module.exports = {
  serviceEnvironment,
  localConnectorManagementEnvironment,
  validateRuntimeEnvironment,
  signedConnectorToken,
  localSecrets,
};
