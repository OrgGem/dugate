// Shared environment contracts for host-process development and local env generators.
const { createHmac, randomBytes } = require('node:crypto');

const WORKER_TOKEN_KEYS = {
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

function workerTokens(env) {
  let map;
  try { map = JSON.parse(env.WORKER_IDENTITY_TOKENS_BY_BUSINESS || '{}'); }
  catch { throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS must be a JSON object'); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS must be a JSON object');
  }
  for (const [business, key] of Object.entries(WORKER_TOKEN_KEYS)) {
    if (env[key] && map[business] && env[key] !== map[business]) {
      throw new Error(`${key} disagrees with WORKER_IDENTITY_TOKENS_BY_BUSINESS`);
    }
    if (env[key]) map[business] = env[key];
  }
  const reserved = [env.RUNTIME_TOKEN, env.ADMIN_TOKEN, env.USAGE_TOKEN].filter(Boolean);
  const seen = new Set(reserved);
  for (const token of Object.values(map)) {
    if (typeof token !== 'string' || !token.trim() || seen.has(token)) {
      throw new Error('Worker tokens must be non-empty, unique and separate from platform tokens');
    }
    seen.add(token);
  }
  return map;
}

function serviceEnvironment(env, service) {
  const result = { ...env };
  if (service === 'connector') {
    result.INVOCATION_GRANT_SECRET = env.CONNECTOR_INVOCATION_GRANT_SECRET
      || Buffer.from(env.INVOCATION_GRANT_SECRET || '', 'utf8').toString('base64');
    result.REDIS_KEY_PREFIX = env.CONNECTOR_REDIS_PREFIX || env.REDIS_KEY_PREFIX || 'du:connector:';
  } else if (WORKER_TOKEN_KEYS[service]) {
    result.RUNTIME_TOKEN = workerTokens(env)[service];
    result.WORKER_RUNTIME_TOKEN = result.RUNTIME_TOKEN;
    const concurrencyKey = { 'document-core': 'DOCUMENT_CORE_CONCURRENCY', 'lc-checker': 'LC_CONCURRENCY', 'example-review': 'EXAMPLE_REVIEW_CONCURRENCY' }[service];
    result.CONCURRENCY = env[concurrencyKey] || env.CONCURRENCY || '1';
    // Workers have no Vault identity. Encryption is mediated by Runtime APIs.
    for (const key of Object.keys(result)) if (key.startsWith('DU_VAULT_')) delete result[key];
    for (const key of ['ADMIN_TOKEN', 'ADMIN_SHELL_COOKIE_SECRET', 'SERVICE_IDENTITY_SECRET', 'CONNECTOR_ENCRYPTION_KEY', 'CONNECTOR_INVOCATION_ENCRYPTION_KEYS', 'INVOCATION_GRANT_SECRET', 'CONNECTOR_INVOCATION_GRANT_SECRET', 'WORKER_IDENTITY_TOKENS_BY_BUSINESS', ...Object.values(WORKER_TOKEN_KEYS)]) delete result[key];
  } else if (service === 'orchestrator') {
    result.WORKER_IDENTITY_TOKENS_BY_BUSINESS = JSON.stringify(workerTokens(env));
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

function localEncryptionKeyringConfigured(env) {
  const active = env.DU_LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION?.trim();
  const raw = env.DU_LOCAL_ENCRYPTION_KEYRING_JSON?.trim();
  if (active || raw) {
    if (!active || !raw || !/^[1-9][0-9]{0,9}$/.test(active)) {
      throw new Error('DU_LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION and DU_LOCAL_ENCRYPTION_KEYRING_JSON must be configured together');
    }
    const activeVersion = Number(active);
    if (!Number.isSafeInteger(activeVersion) || activeVersion > 2147483647) {
      throw new Error('DU_LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION must be a positive integer');
    }
    let keys;
    try { keys = JSON.parse(raw); } catch { throw new Error('DU_LOCAL_ENCRYPTION_KEYRING_JSON must be valid JSON'); }
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      throw new Error('DU_LOCAL_ENCRYPTION_KEYRING_JSON must be a version-to-base64-key object');
    }
    for (const [version, encoded] of Object.entries(keys)) {
      if (!/^[1-9][0-9]{0,9}$/.test(version) || Number(version) > 2147483647 || typeof encoded !== 'string') {
        throw new Error('DU_LOCAL_ENCRYPTION_KEYRING_JSON contains an invalid key version');
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) {
        throw new Error('Local encryption keys must be canonical Base64-encoded 32-byte values');
      }
    }
    if (!Object.hasOwn(keys, active)) throw new Error('The active local encryption key version is not present in the keyring');
    return true;
  }
  return Buffer.byteLength(env.ENCRYPTION_KEY || '', 'utf8') >= 32;
}

function validateVaultTransit(env, { metadataEnabled, publicUploadEnabled, backend }) {
  const optionsRaw = env.DU_VAULT_TRANSIT_OPTIONS?.trim();
  const encryptToken = env.DU_VAULT_TRANSIT_ENC_TOKEN?.trim();
  const decryptToken = env.DU_VAULT_TRANSIT_DEC_TOKEN?.trim();
  const anyConfigured = Boolean(optionsRaw || encryptToken || decryptToken);
  if (!anyConfigured) {
    if (backend === 's3') throw new Error('DU_VAULT_TRANSIT_OPTIONS is required for encrypted S3 artifact storage');
    return false;
  }
  if (!optionsRaw) throw new Error('DU_VAULT_TRANSIT_OPTIONS is required when either Vault Transit identity is configured');
  if (!encryptToken || !decryptToken) throw new Error('DU_VAULT_TRANSIT_ENC_TOKEN and DU_VAULT_TRANSIT_DEC_TOKEN are required with Vault Transit options');
  if (encryptToken === decryptToken) throw new Error('Vault encrypt/decrypt tokens must be distinct');

  let options;
  try { options = JSON.parse(optionsRaw); } catch { throw new Error('DU_VAULT_TRANSIT_OPTIONS must be valid JSON'); }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('DU_VAULT_TRANSIT_OPTIONS must be a JSON object');
  }
  try { new URL(options.vaultAddress); } catch { throw new Error('DU_VAULT_TRANSIT_OPTIONS requires a valid vaultAddress'); }
  const allowed = options.allowedKeyRefs;
  if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed) || Object.keys(allowed).length === 0
      || Object.values(allowed).some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('DU_VAULT_TRANSIT_OPTIONS.allowedKeyRefs must map allowed references to non-empty Transit key names');
  }
  for (const [enabled, field] of [[metadataEnabled, 'metadataKeyRef'], [publicUploadEnabled, 'publicUploadKeyRef']]) {
    if (enabled && (typeof options[field] !== 'string' || !Object.hasOwn(allowed, options[field]))) {
      throw new Error(`DU_VAULT_TRANSIT_OPTIONS requires an allowed ${field}`);
    }
  }
  return true;
}

function validateRuntimeEnvironment(env, { workers = [], services = 'all', workflow = false } = {}) {
  const required = ['DATABASE_URL', 'REDIS_URL', 'SERVICE_IDENTITY_SECRET', 'INVOCATION_GRANT_SECRET'];
  if (services === 'all' || services === 'orchestrator') required.push('RUNTIME_TOKEN', 'ADMIN_TOKEN', 'ENCRYPTION_KEY', 'ADMIN_SHELL_COOKIE_SECRET');
  for (const key of required) {
    if (!env[key]) {
      if (key === 'SERVICE_IDENTITY_SECRET') {
        throw new Error('SERVICE_IDENTITY_SECRET is required; Orchestrator and Connector must share a Base64-encoded 32-byte secret');
      }
      throw new Error(`${key} is required`);
    }
  }
  for (const key of ['SERVICE_IDENTITY_SECRET', 'CONNECTOR_ENCRYPTION_KEY']) {
    if (Buffer.from(env[key] || '', 'base64').length !== 32) throw new Error(`${key} must encode 32 bytes`);
  }
  if (!/^[\x21-\x7e]{32}$/.test(env.INVOCATION_GRANT_SECRET)) {
    throw new Error('INVOCATION_GRANT_SECRET must be 32 raw ASCII bytes; use a fresh profile or migrate the legacy Base64 key');
  }
  if (env.CONNECTOR_INVOCATION_GRANT_SECRET && !Buffer.from(env.CONNECTOR_INVOCATION_GRANT_SECRET, 'base64').equals(Buffer.from(env.INVOCATION_GRANT_SECRET, 'utf8'))) {
    throw new Error('CONNECTOR_INVOCATION_GRANT_SECRET must be Base64 of INVOCATION_GRANT_SECRET');
  }
  const map = workerTokens(env);
  for (const worker of workers) if (!map[worker]) throw new Error(`Missing worker identity for ${worker}; set ${WORKER_TOKEN_KEYS[worker]}`);
  if (workers.length) {
    let valid = false;
    try {
      const [header, payload, signature, extra] = (env.CONNECTOR_SERVICE_TOKEN || '').split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const algorithm = JSON.parse(Buffer.from(header, 'base64url').toString()).alg;
      const expected = createHmac('sha256', Buffer.from(env.SERVICE_IDENTITY_SECRET, 'base64')).update(`${header}.${payload}`).digest('base64url');
      valid = !extra && algorithm === 'HS256' && expected === signature && claims.aud === 'connector'
        && Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000
        && Array.isArray(claims.scopes) && claims.scopes.includes('connector:invoke');
    } catch {}
    if (!valid) throw new Error('CONNECTOR_SERVICE_TOKEN must be a valid unexpired connector:invoke identity; use --local-identity only for local development');
  }
  if (services !== 'orchestrator' || workers.length) {
    let keys;
    try { keys = JSON.parse(env.CONNECTOR_INVOCATION_ENCRYPTION_KEYS || '{}'); }
    catch { throw new Error('CONNECTOR_INVOCATION_ENCRYPTION_KEYS must be valid JSON'); }
    if (!keys.keyRef || !Number.isInteger(keys.activeVersion) || Buffer.from(keys.keys?.[keys.activeVersion] || '', 'base64').length !== 32) {
      throw new Error('CONNECTOR_INVOCATION_ENCRYPTION_KEYS requires keyRef, activeVersion and a Base64 32-byte active key');
    }
  }
  if (services !== 'connector') {
    const synthetic = env.DU_DATA_MODE === 'synthetic';
    if (env.DU_DATA_MODE && !['real', 'synthetic'].includes(env.DU_DATA_MODE)) throw new Error('DU_DATA_MODE must be real or synthetic');
    if (synthetic) {
      let ack;
      try { ack = JSON.parse(env.DU_SYNTHETIC_DATA_ACK || '{}'); } catch {}
      if (!ack || ack.mode !== 'synthetic-data-exempt' || !ack.reason || !ack.approvedBy || !Number.isFinite(Date.parse(ack.acknowledgedAt)) || ack.isolatedFromRealData !== true) {
        throw new Error('DU_SYNTHETIC_DATA_ACK requires a complete synthetic-data exemption');
      }
    }
    const backend = env.ARTIFACT_STORAGE_BACKEND || 'postgres';
    if (!['postgres', 's3'].includes(backend)) throw new Error('ARTIFACT_STORAGE_BACKEND must be postgres or s3');
    for (const key of ['DU_ENCRYPTION_METADATA_ENABLED', 'DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED']) {
      if (env[key] !== undefined && !['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false`);
    }
    const metadataEnabled = !synthetic || backend === 's3' || env.DU_ENCRYPTION_METADATA_ENABLED === 'true';
    const publicUploadEnabled = !synthetic || backend === 's3' || env.DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED === 'true';
    const encrypted = metadataEnabled || publicUploadEnabled || workflow;
    if (workflow && (env.DU_ENCRYPTION_METADATA_ENABLED !== 'true' || env.DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED !== 'true')) {
      throw new Error('Workflow runtime requires both DU_ENCRYPTION_METADATA_ENABLED=true and DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED=true');
    }
    if (encrypted) {
      if (!env.DU_METADATA_PLAINTEXT_READ_MODE) throw new Error('DU_METADATA_PLAINTEXT_READ_MODE is required for encrypted runtime');
      if (!['forbid', 'window'].includes(env.DU_METADATA_PLAINTEXT_READ_MODE)) throw new Error('DU_METADATA_PLAINTEXT_READ_MODE must be forbid or window');
      if (env.DU_METADATA_PLAINTEXT_READ_MODE === 'forbid'
          && (env.DU_METADATA_PLAINTEXT_WINDOW_START || env.DU_METADATA_PLAINTEXT_WINDOW_END)) {
        throw new Error('DU_METADATA_PLAINTEXT_READ_MODE=forbid must not be combined with plaintext window timestamps');
      }
      if (env.DU_METADATA_PLAINTEXT_READ_MODE === 'window') {
        const start = Date.parse(env.DU_METADATA_PLAINTEXT_WINDOW_START);
        const end = Date.parse(env.DU_METADATA_PLAINTEXT_WINDOW_END);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 14 * 86400000) throw new Error('Metadata plaintext window requires ordered timestamps within 14 days');
      }
      const transitConfigured = validateVaultTransit(env, { metadataEnabled, publicUploadEnabled, backend });
      if (!transitConfigured && !localEncryptionKeyringConfigured(env)) {
        throw new Error('PostgreSQL-backed encryption requires a retained ENCRYPTION_KEY of at least 32 bytes or a complete local encryption keyring');
      }
    }
  }
}

function localSecrets(now = Date.now()) {
  const rawGrant = randomBytes(16).toString('hex');
  const identity = randomBytes(32).toString('base64');
  const map = Object.fromEntries(Object.keys(WORKER_TOKEN_KEYS).map(b => [b, randomBytes(32).toString('hex')]));
  return {
    RUNTIME_TOKEN: randomBytes(32).toString('hex'), ADMIN_TOKEN: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'), ADMIN_SHELL_COOKIE_SECRET: randomBytes(32).toString('hex'),
    SERVICE_IDENTITY_SECRET: identity, INVOCATION_GRANT_SECRET: rawGrant,
    CONNECTOR_INVOCATION_GRANT_SECRET: Buffer.from(rawGrant).toString('base64'),
    CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: JSON.stringify({ keyRef: 'du-connector-invocation-v1', activeVersion: 1, keys: { 1: randomBytes(32).toString('base64') } }),
    WORKER_IDENTITY_TOKENS_BY_BUSINESS: JSON.stringify(map),
    ...Object.fromEntries(Object.entries(WORKER_TOKEN_KEYS).map(([b, k]) => [k, map[b]])),
    CONNECTOR_SERVICE_TOKEN: signedConnectorToken(identity, now),
  };
}

module.exports = {
  serviceEnvironment,
  localConnectorManagementEnvironment,
  validateRuntimeEnvironment,
  localEncryptionKeyringConfigured,
  validateVaultTransit,
  workerTokens,
  signedConnectorToken,
  localSecrets,
};
