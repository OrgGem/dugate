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

function validateRuntimeEnvironment(env, { workers = [], services = 'all', workflow = false } = {}) {
  const required = ['DATABASE_URL', 'REDIS_URL', 'SERVICE_IDENTITY_SECRET', 'INVOCATION_GRANT_SECRET'];
  if (services === 'all' || services === 'orchestrator') required.push('RUNTIME_TOKEN', 'ADMIN_TOKEN', 'ENCRYPTION_KEY', 'ADMIN_SHELL_COOKIE_SECRET');
  for (const key of required) if (!env[key]) throw new Error(`${key} is required`);
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
    const encrypted = !synthetic || workflow || env.ARTIFACT_STORAGE_BACKEND === 's3'
      || env.DU_ENCRYPTION_METADATA_ENABLED === 'true' || env.DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED === 'true';
    if (workflow && (env.DU_ENCRYPTION_METADATA_ENABLED !== 'true' || env.DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED !== 'true')) {
      throw new Error('Workflow runtime requires both DU_ENCRYPTION_METADATA_ENABLED=true and DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED=true');
    }
    if (encrypted) {
      for (const key of ['DU_VAULT_TRANSIT_OPTIONS', 'DU_VAULT_TRANSIT_ENC_TOKEN', 'DU_VAULT_TRANSIT_DEC_TOKEN', 'DU_METADATA_PLAINTEXT_READ_MODE']) {
        if (!env[key]) throw new Error(`${key} is required for encrypted runtime`);
      }
      if (env.DU_VAULT_TRANSIT_ENC_TOKEN === env.DU_VAULT_TRANSIT_DEC_TOKEN) throw new Error('Vault encrypt/decrypt tokens must be distinct');
      let options;
      try { options = JSON.parse(env.DU_VAULT_TRANSIT_OPTIONS); } catch { throw new Error('DU_VAULT_TRANSIT_OPTIONS must be valid JSON'); }
      for (const key of ['metadataKeyRef', 'publicUploadKeyRef']) if (!options[key] || !options.allowedKeyRefs?.[options[key]]) throw new Error(`DU_VAULT_TRANSIT_OPTIONS requires an allowed ${key}`);
      try { new URL(options.vaultAddress); } catch { throw new Error('DU_VAULT_TRANSIT_OPTIONS requires a valid vaultAddress'); }
      if (!['forbid', 'window'].includes(env.DU_METADATA_PLAINTEXT_READ_MODE)) throw new Error('DU_METADATA_PLAINTEXT_READ_MODE must be forbid or window');
      if (env.DU_METADATA_PLAINTEXT_READ_MODE === 'window') {
        const start = Date.parse(env.DU_METADATA_PLAINTEXT_WINDOW_START);
        const end = Date.parse(env.DU_METADATA_PLAINTEXT_WINDOW_END);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 14 * 86400000) throw new Error('Metadata plaintext window requires ordered timestamps within 14 days');
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

module.exports = { serviceEnvironment, validateRuntimeEnvironment, workerTokens, signedConnectorToken, localSecrets };
