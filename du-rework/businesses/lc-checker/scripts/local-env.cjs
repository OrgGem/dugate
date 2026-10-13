const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const { parseEnv } = require('node:util');

const INTERNAL_RUNTIME_PORT = 3002;
const INTERNAL_RUNTIME_PATH = '/api/runtime/v1';

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

function loadWorkerEnvironment(profilePath, overrides = {}) {
  const fromFile = profilePath ? parseEnv(fs.readFileSync(profilePath, 'utf8')) : {};
  const configured = { ...fromFile, ...overrides };

  const runtimePort = Number(configured.ORCHESTRATOR_INTERNAL_PORT || INTERNAL_RUNTIME_PORT);
  const publicPort = Number(configured.ORCHESTRATOR_PORT || 3000);
  if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535
    || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535 || runtimePort === publicPort) {
    throw new Error('ORCHESTRATOR_INTERNAL_PORT and ORCHESTRATOR_PORT must be valid, distinct TCP ports.');
  }
  const runtimeUrl = configured.RUNTIME_URL || `http://127.0.0.1:${runtimePort}${INTERNAL_RUNTIME_PATH}`;
  const runtimeEndpoint = requireUrl(runtimeUrl, 'RUNTIME_URL', ['http:', 'https:']);
  const effectiveRuntimePort = Number(runtimeEndpoint.port || (runtimeEndpoint.protocol === 'https:' ? 443 : 80));
  if (effectiveRuntimePort !== runtimePort || effectiveRuntimePort === publicPort
    || runtimeEndpoint.pathname.replace(/\/$/, '') !== INTERNAL_RUNTIME_PATH) {
    throw new Error(`RUNTIME_URL must target the internal Runtime API on port ${runtimePort}, not public ingress.`);
  }

  const connectorUrl = configured.CONNECTOR_URL || 'http://127.0.0.1:8088';
  const connectorEndpoint = requireUrl(connectorUrl, 'CONNECTOR_URL', ['http:', 'https:']);
  const redisUrl = configured.REDIS_URL || 'redis://127.0.0.1:16380';
  requireUrl(redisUrl, 'REDIS_URL', ['redis:', 'rediss:']);
  const runtimeToken = configured.RUNTIME_TOKEN;
  if (typeof runtimeToken !== 'string' || runtimeToken.trim() === '') {
    throw new Error('RUNTIME_TOKEN is required in this worker’s .env.local profile. Use the existing lc-checker business token.');
  }

  if (configured.SERVICE_IDENTITY_SECRET && configured.CONNECTOR_SERVICE_TOKEN) {
    throw new Error('Set CONNECTOR_SERVICE_TOKEN or SERVICE_IDENTITY_SECRET, not both.');
  }
  const connectorServiceToken = configured.SERVICE_IDENTITY_SECRET
    ? signedConnectorToken(configured.SERVICE_IDENTITY_SECRET)
    : configured.CONNECTOR_SERVICE_TOKEN;
  if (typeof connectorServiceToken !== 'string' || connectorServiceToken.trim() === '') {
    throw new Error('SERVICE_IDENTITY_SECRET or CONNECTOR_SERVICE_TOKEN is required for Connector authentication.');
  }

  const workerEnvironment = {
    RUNTIME_URL: runtimeEndpoint.toString().replace(/\/$/, ''),
    RUNTIME_TOKEN: runtimeToken,
    REDIS_URL: redisUrl,
    CONNECTOR_URL: connectorEndpoint.toString().replace(/\/$/, ''),
    CONNECTOR_SERVICE_TOKEN: connectorServiceToken,
    CONCURRENCY: configured.LC_CONCURRENCY || configured.CONCURRENCY || '1',
    HEARTBEAT_INTERVAL_MS: configured.HEARTBEAT_INTERVAL_MS || '10000',
    WORKER_INSTANCE_ID: configured.WORKER_INSTANCE_ID || '',
    IMAGE_DIGEST: configured.IMAGE_DIGEST || '',
    SHUTDOWN_GRACE_MS: configured.SHUTDOWN_GRACE_MS || '15000',
    MAX_ARTIFACT_BYTES: configured.MAX_ARTIFACT_BYTES || String(64 * 1024 * 1024),
    PORT: '0',
    HOST: '127.0.0.1',
  };

  return { workerEnvironment, runtimeUrl: workerEnvironment.RUNTIME_URL, connectorUrl: workerEnvironment.CONNECTOR_URL, redisUrl };
}

module.exports = { displayEndpoint, loadWorkerEnvironment, signedConnectorToken };
