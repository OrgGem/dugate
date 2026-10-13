const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const { parseEnv } = require('node:util');

const SAFE_PROCESS_ENV_KEYS = [
  'PATH', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'PANDOC_PATH', 'PANDOC', 'GS_PATH', 'GHOSTSCRIPT_PATH', 'GS_BIN',
];

function signedConnectorToken(identitySecret, now = Date.now()) {
  const key = Buffer.from(identitySecret || '', 'base64');
  if (key.length !== 32) throw new Error('SERVICE_IDENTITY_SECRET must encode 32 bytes.');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'local-business-workers',
    aud: 'connector',
    scopes: ['connector:invoke'],
    exp: Math.floor(now / 1000) + 86400,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

function requireUrl(value, name, protocols) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL.`); }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} must use ${protocols.join(' or ')}.`);
  return url;
}

function displayEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[configured]';
  }
}

function loadWorkerEnvironment(profilePath, overrides = process.env) {
  const fromFile = profilePath ? parseEnv(fs.readFileSync(profilePath, 'utf8')) : {};
  const configured = { ...overrides, ...fromFile };
  const runtimePort = Number(configured.ORCHESTRATOR_INTERNAL_PORT || 3002);
  const publicPort = Number(configured.ORCHESTRATOR_PORT || 3000);
  if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535
    || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    throw new Error('ORCHESTRATOR_INTERNAL_PORT and ORCHESTRATOR_PORT must be valid TCP ports.');
  }

  const runtimeUrl = configured.RUNTIME_URL || `http://127.0.0.1:${runtimePort}/api/runtime/v1`;
  const runtimeEndpoint = requireUrl(runtimeUrl, 'RUNTIME_URL', ['http:', 'https:']);
  const effectiveRuntimePort = Number(runtimeEndpoint.port || (runtimeEndpoint.protocol === 'https:' ? 443 : 80));
  if (effectiveRuntimePort !== runtimePort || effectiveRuntimePort === publicPort
    || runtimeEndpoint.pathname.replace(/\/$/, '') !== '/api/runtime/v1') {
    throw new Error(`RUNTIME_URL must target the internal Runtime API on port ${runtimePort}, not public ingress.`);
  }

  const connectorUrl = configured.CONNECTOR_URL || 'http://127.0.0.1:8088';
  const connectorEndpoint = requireUrl(connectorUrl, 'CONNECTOR_URL', ['http:', 'https:']);
  const redisUrl = configured.REDIS_URL || 'redis://127.0.0.1:16380';
  requireUrl(redisUrl, 'REDIS_URL', ['redis:', 'rediss:']);

  const runtimeToken = configured.RUNTIME_TOKEN || configured.DOCUMENT_CORE_RUNTIME_TOKEN;
  if (typeof runtimeToken !== 'string' || runtimeToken.trim() === '') {
    throw new Error('RUNTIME_TOKEN is required in this worker’s .env.local profile. Use the existing document-core business token.');
  }

  let connectorServiceToken = configured.CONNECTOR_SERVICE_TOKEN;
  if (configured.SERVICE_IDENTITY_SECRET) connectorServiceToken = signedConnectorToken(configured.SERVICE_IDENTITY_SECRET);
  if (!connectorServiceToken || !connectorServiceToken.trim()) {
    throw new Error('CONNECTOR_SERVICE_TOKEN or SERVICE_IDENTITY_SECRET is required when Connector is configured.');
  }

  const workerEnvironment = {};
  for (const name of SAFE_PROCESS_ENV_KEYS) {
    if (typeof overrides[name] === 'string') workerEnvironment[name] = overrides[name];
  }
  Object.assign(workerEnvironment, {
    RUNTIME_URL: runtimeEndpoint.toString().replace(/\/$/, ''),
    RUNTIME_TOKEN: runtimeToken,
    REDIS_URL: redisUrl,
    CONNECTOR_URL: connectorEndpoint.toString().replace(/\/$/, ''),
    CONNECTOR_SERVICE_TOKEN: connectorServiceToken,
  });
  const optionalWorkerSettings = {
    CONCURRENCY: configured.DOCUMENT_CORE_CONCURRENCY || configured.CONCURRENCY,
    HEARTBEAT_INTERVAL_MS: configured.HEARTBEAT_INTERVAL_MS,
    WORKER_INSTANCE_ID: configured.WORKER_INSTANCE_ID,
    IMAGE_DIGEST: configured.IMAGE_DIGEST,
    WORKFLOW_PRIVATE_HTTPS_ORIGINS: configured.WORKFLOW_PRIVATE_HTTPS_ORIGINS,
    SHUTDOWN_GRACE_MS: configured.SHUTDOWN_GRACE_MS,
  };
  for (const [name, value] of Object.entries(optionalWorkerSettings)) {
    if (typeof value === 'string' && value.trim()) workerEnvironment[name] = value;
  }

  return { workerEnvironment, runtimeUrl: workerEnvironment.RUNTIME_URL, connectorUrl: workerEnvironment.CONNECTOR_URL, redisUrl };
}

module.exports = { displayEndpoint, loadWorkerEnvironment, signedConnectorToken };
