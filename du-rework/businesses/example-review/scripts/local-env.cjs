const fs = require('node:fs');
const { parseEnv } = require('node:util');

const INTERNAL_RUNTIME_PORT = 3002;
const INTERNAL_RUNTIME_PATH = '/api/runtime/v1';

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

  const redisUrl = configured.REDIS_URL || 'redis://127.0.0.1:16380';
  requireUrl(redisUrl, 'REDIS_URL', ['redis:', 'rediss:']);
  const runtimeToken = configured.RUNTIME_TOKEN;
  if (typeof runtimeToken !== 'string' || runtimeToken.trim() === '') {
    throw new Error('RUNTIME_TOKEN is required in this worker’s .env.local profile. Use the existing example-review business token.');
  }

  const workerEnvironment = {
    RUNTIME_URL: runtimeEndpoint.toString().replace(/\/$/, ''),
    RUNTIME_TOKEN: runtimeToken,
    REDIS_URL: redisUrl,
    CONCURRENCY: configured.EXAMPLE_REVIEW_CONCURRENCY || configured.CONCURRENCY || '1',
    HEARTBEAT_INTERVAL_MS: configured.HEARTBEAT_INTERVAL_MS || '10000',
    WORKER_INSTANCE_ID: configured.WORKER_INSTANCE_ID || '',
    IMAGE_DIGEST: configured.IMAGE_DIGEST || '',
    SHUTDOWN_GRACE_MS: configured.SHUTDOWN_GRACE_MS || '15000',
    PORT: '0',
    HOST: '127.0.0.1',
  };

  return { workerEnvironment, runtimeUrl: workerEnvironment.RUNTIME_URL, redisUrl };
}

module.exports = { displayEndpoint, loadWorkerEnvironment };
