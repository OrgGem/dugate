'use strict';

const net = require('node:net');

function parseEndpoint(raw, name, protocols, defaultPort) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error(`${name} is required`);
  let url;
  try { url = new URL(raw); } catch {
    throw new Error(`${name} must be a valid URL; credentials are not shown`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}; credentials are not shown`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : defaultPort;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must include a valid host and port; credentials are not shown`);
  }
  return { name, host, port };
}

function probeTcp(endpoint, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    socket.once('connect', () => finish());
    socket.once('error', () => finish(new Error('unreachable')));
  });
}

async function assertExternalDependenciesReachable(env, { timeoutMs = 1500 } = {}) {
  const endpoints = [
    parseEndpoint(env.DATABASE_URL, 'DATABASE_URL', ['postgres:', 'postgresql:'], 5432),
    parseEndpoint(env.REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:'], 6379),
  ];
  const results = await Promise.allSettled(endpoints.map((endpoint) => probeTcp(endpoint, timeoutMs)));
  const errors = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${endpoints[index].name} endpoint ${endpoints[index].host}:${endpoints[index].port} is unreachable; verify the externally managed service and URL. This command does not start databases or containers.`]
    : []);
  if (errors.length) throw new Error(errors.join('\n'));
}

module.exports = { assertExternalDependenciesReachable, parseEndpoint, probeTcp };
