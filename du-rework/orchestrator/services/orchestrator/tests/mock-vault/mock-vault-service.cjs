'use strict';

// HashiCorp Vault MOCKUP service - local dev + offline tests ONLY.
//
// Serves the slice of the Vault HTTP API the Orchestrator actually calls,
// seeded from mock-vault.json:
//   POST /v1/auth/token/create, POST /v1/sys/leases/{renew,revoke}
//   GET|POST /v1/{mount}/data/{path}      KV v2 read + CAS write (412)
//   GET      /v1/{mount}/metadata/{path}  versions WITHOUT values
//   POST     /v1/{mount}/{encrypt,decrypt,rewrap}/{key}  Transit
// GET /v1/sys/health answers 503 on purpose: a live-gated suite must never
// false-green against the mock.
//
// Activation is DU_VAULT_MOCK=true (see bootstrap.cjs). Three identities
// (kv, encrypt, decrypt) mirror the least-privilege split the production
// boot enforces, so a wrong-token call is a real 403 on the wire. Request
// records carry route/status/path only - never bodies (zero-secret logging,
// same rule as tests/harness/mock-vault/server.ts).

const { createServer } = require('node:http');
const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('node:crypto');
const { loadFixture } = require('./mock-vault-fixture.cjs');

const DEFAULT_PORT = 41900;
const MAX_BODY_BYTES = 1048576;
const KEY_SALT = 'du-mock-vault-transit';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CIPHERTEXT = /^vault:v([1-9][0-9]*):([A-Za-z0-9+/_=-]+)$/;

class WireError extends Error {
  constructor(status, errors) {
    super('mock vault wire error ' + status);
    this.status = status;
    this.errors = errors;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        resolve(undefined); // oversized body - caller answers 400
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Bind loopback OUTSIDE the OS dynamic/ephemeral band: Windows intermittently
 * filters connections to freshly chosen ephemeral ports while LISTEN succeeds
 * (evidence and rationale in tests/harness/listen-loopback.ts). Fixed
 * candidates with an EADDRINUSE advance keep the bind deterministic.
 */
async function bindLoopback(server, preferPort) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const port = preferPort + attempt;
    const bound = await new Promise((resolve) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        resolve(error && error.code === 'EADDRINUSE' ? false : null);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (bound === true) return port;
    if (bound === null) throw new Error('mock vault listener failed');
  }
  throw new Error('mock vault exhausted its loopback port band');
}

function transitKeyMaterial(keyName, version) {
  return scryptSync(keyName + ':' + version, KEY_SALT, 32);
}

function transitEncrypt(keyName, plaintext, version) {
  const material = transitKeyMaterial(keyName, version);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', material, nonce);
  cipher.setAAD(Buffer.from(keyName + ':' + version));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([nonce, body, tag]).toString('base64');
  return 'vault:v' + version + ':' + payload;
}

function transitDecrypt(keyName, ciphertext) {
  const match = CIPHERTEXT.exec(ciphertext);
  if (!match) throw new WireError(400, ['invalid ciphertext']);
  const version = Number(match[1]);
  const payload = Buffer.from(match[2], 'base64');
  if (payload.length <= NONCE_BYTES + TAG_BYTES) throw new WireError(400, ['invalid ciphertext']);
  const nonce = payload.subarray(0, NONCE_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const body = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES);
  const material = transitKeyMaterial(keyName, version);
  const decipher = createDecipheriv('aes-256-gcm', material, nonce);
  decipher.setAAD(Buffer.from(keyName + ':' + version));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new WireError(400, ['ciphertext authentication failed']);
  }
}

function resolveVersion(requested, keyState) {
  if (requested === undefined) return keyState.currentVersion;
  if (!Number.isInteger(requested) || requested < 1) throw new WireError(400, ['key_version must be a positive integer']);
  return requested;
}

/** Mock rotation: material for a newer version is derived on demand, exactly as a rewrap pin needs it. */
function ensureTransitVersion(keyName, keyState, version) {
  if (version <= keyState.currentVersion) return;
  for (let next = keyState.currentVersion + 1; next <= version; next++) {
    keyState.versions.set(next, transitKeyMaterial(keyName, next));
  }
  keyState.currentVersion = version;
}

/**
 * Boot the mock Vault on loopback and return the wiring the composition
 * layers need: origin plus the three identities and the allowlisted key
 * refs, so DU_VAULT_KV_OPTIONS / DU_VAULT_TRANSIT_OPTIONS can be pointed
 * here instead of a live Vault.
 */
async function startMockVaultService(options = {}) {
  const fixture = loadFixture(options.fixturePath);
  const tokenRoles = new Map([
    [fixture.tokens.kv, 'kv'],
    [fixture.tokens.encrypt, 'encrypt'],
    [fixture.tokens.decrypt, 'decrypt'],
  ]);
  const kvSecrets = new Map();
  for (const seed of fixture.kv.secrets) {
    const versions = [];
    for (let version = 1; version <= seed.versions; version++) {
      versions.push({ version, createdAt: Date.now(), data: { ...seed.data } });
    }
    kvSecrets.set(seed.path, versions);
  }
  const transitKeys = new Map();
  for (const seed of fixture.transit.keys) {
    const versions = new Map();
    for (let version = 1; version <= seed.versions; version++) {
      versions.set(version, transitKeyMaterial(seed.name, version));
    }
    transitKeys.set(seed.name, { currentVersion: seed.versions, versions });
  }
  let clock = Date.now();
  let issued = 0;
  const leases = new Map();
  const counters = { tokenCreates: 0, renews: 0, revokes: 0, expiredLeases: 0, reads: 0, writes: 0, denied: 0 };
  const requestLog = [];

  const now = () => clock;
  const record = (route, status, routePath) => {
    requestLog.push({ route, status, path: routePath });
    if (status === 403) counters.denied += 1;
  };
  const headerToken = (req) => {
    const raw = req.headers['x-vault-token'];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const requireRole = (token, role) => {
    if (typeof token !== 'string' || tokenRoles.get(token) !== role) throw new WireError(403, ['permission denied']);
    const lease = [...leases.values()].find((entry) => entry.token === token);
    if (lease !== undefined && (lease.revoked || clock >= lease.expiresAt)) {
      throw new WireError(403, ['permission denied']);
    }
  };
  const latest = (secretPath) => {
    const versions = kvSecrets.get(secretPath);
    return versions && versions.length > 0 ? versions[versions.length - 1] : undefined;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const routePath = new URL(req.url ?? '/', 'http://mock-vault').pathname;

      if (method === 'GET' && routePath === '/v1/sys/health') {
        record('sys-health', 503, routePath);
        sendJson(res, 503, { errors: ['mock vault: not a real HashiCorp Vault'] });
        return;
      }

      if (method === 'POST' && routePath === '/v1/auth/token/create') {
        const body = await readBody(req);
        const role = typeof body.role === 'string' ? body.role : 'kv';
        if (!Object.prototype.hasOwnProperty.call(fixture.tokens, role)) {
          record('token-denied', 403, routePath);
          sendJson(res, 403, { errors: ['unknown role'] });
          return;
        }
        const token = fixture.tokens[role];
        const leaseId = 'lease-' + (++issued);
        leases.set(leaseId, {
          token,
          expiresAt: clock + fixture.leaseDurationMs,
          renewable: fixture.renewable,
          revoked: false,
        });
        counters.tokenCreates += 1;
        record('token-create', 200, routePath);
        sendJson(res, 200, {
          auth: {
            client_token: token,
            lease_id: leaseId,
            lease_duration: Math.round(fixture.leaseDurationMs / 1000),
            renewable: fixture.renewable,
            accessor: 'acc-' + leaseId,
          },
        });
        return;
      }

      if (method === 'POST' && (routePath === '/v1/sys/leases/renew' || routePath === '/v1/sys/leases/revoke')) {
        const body = await readBody(req);
        const lease = typeof body.lease_id === 'string' ? leases.get(body.lease_id) : undefined;
        if (!lease || lease.revoked) {
          record('lease-denied', 403, routePath);
          sendJson(res, 403, { errors: ['permission denied'] });
          return;
        }
        if (clock >= lease.expiresAt) {
          lease.revoked = true;
          counters.expiredLeases += 1;
          record('lease-expired', 403, routePath);
          sendJson(res, 403, { errors: ['permission denied: lease expired'] });
          return;
        }
        if (routePath.endsWith('/revoke')) {
          lease.revoked = true;
          counters.revokes += 1;
          record('lease-revoke', 204, routePath);
          res.writeHead(204);
          res.end();
          return;
        }
        if (!lease.renewable) {
          record('lease-unrenewable', 400, routePath);
          sendJson(res, 400, { errors: ['lease is not renewable'] });
          return;
        }
        lease.expiresAt = clock + fixture.leaseDurationMs;
        counters.renews += 1;
        record('lease-renew', 200, routePath);
        sendJson(res, 200, {
          lease_id: body.lease_id,
          renewable: true,
          lease_duration: Math.round(fixture.leaseDurationMs / 1000),
        });
        return;
      }

      const dataMatch = /^\/v1\/([^/]+)\/data\/(.+)$/.exec(routePath);
      const metaMatch = /^\/v1\/([^/]+)\/metadata\/(.+)$/.exec(routePath);
      if (dataMatch || metaMatch) {
        const mount = (dataMatch ?? metaMatch)[1];
        const secretPath = (dataMatch ?? metaMatch)[2];
        if (mount !== fixture.kv.mount) {
          record('unknown-mount', 404, routePath);
          sendJson(res, 404, { errors: [] });
          return;
        }
        requireRole(headerToken(req), 'kv');
        if (secretPath !== fixture.kv.allowedPrefix && !secretPath.startsWith(fixture.kv.allowedPrefix + '/')) {
          record('policy-denied', 403, routePath);
          sendJson(res, 403, { errors: ['1 error occurred:: permission denied: path outside role prefix'] });
          return;
        }
        if (metaMatch) {
          const versions = kvSecrets.get(secretPath);
          if (!versions) {
            record('metadata-missing', 404, routePath);
            sendJson(res, 404, { errors: [] });
            return;
          }
          counters.reads += 1;
          record('metadata-read', 200, routePath);
          sendJson(res, 200, {
            data: {
              current_version: versions.length,
              versions: versions.map(entry => entry.version),
              created_time: versions[0].createdAt,
            },
          });
          return;
        }
        if (method === 'GET') {
          const head = latest(secretPath);
          if (!head) {
            record('data-missing', 404, routePath);
            sendJson(res, 404, { errors: [] });
            return;
          }
          counters.reads += 1;
          record('data-read', 200, routePath);
          sendJson(res, 200, {
            data: {
              data: head.data,
              metadata: { version: head.version, created_time: head.createdAt, destroyed: false, deletion_time: '' },
            },
          });
          return;
        }
        const body = await readBody(req);
        if (body === undefined) {
          record('write-rejected', 400, routePath);
          sendJson(res, 400, { errors: ['request body is too large'] });
          return;
        }
        const versions = kvSecrets.get(secretPath) ?? [];
        const current = versions.length > 0 ? versions[versions.length - 1].version : 0;
        const cas = body.options && typeof body.options.cas === 'number' ? body.options.cas : undefined;
        if (cas !== undefined && cas !== current) {
          record('write-cas-conflict', 412, routePath);
          sendJson(res, 412, { errors: ['Check-and-Set failed'] });
          return;
        }
        const next = {
          version: current + 1,
          createdAt: clock,
          data: { ...(versions.length > 0 ? versions[versions.length - 1].data : {}), ...body.data },
        };
        versions.push(next);
        kvSecrets.set(secretPath, versions);
        counters.writes += 1;
        record('write', 200, routePath);
        sendJson(res, 200, { data: { version: next.version, created_time: next.createdAt, destroyed: false } });
        return;
      }

      const transitMatch = /^\/v1\/([^/]+)\/(encrypt|decrypt|rewrap)\/([^/]+)$/.exec(routePath);
      if (transitMatch) {
        const mount = transitMatch[1];
        const operation = transitMatch[2];
        const keyName = transitMatch[3];
        if (mount !== fixture.transit.mount) {
          record('unknown-mount', 404, routePath);
          sendJson(res, 404, { errors: [] });
          return;
        }
        requireRole(headerToken(req), operation === 'decrypt' ? 'decrypt' : 'encrypt');
        const keyState = transitKeys.get(keyName);
        if (!keyState) {
          record('transit-unknown-key', 404, routePath);
          sendJson(res, 404, { errors: [] });
          return;
        }
        const body = await readBody(req);
        if (operation === 'encrypt') {
          if (typeof body.plaintext !== 'string' || body.plaintext.length === 0) {
            record('transit-rejected', 400, routePath);
            sendJson(res, 400, { errors: ['plaintext is required'] });
            return;
          }
          const version = resolveVersion(body.key_version, keyState);
          ensureTransitVersion(keyName, keyState, version);
          const ciphertext = transitEncrypt(keyName, Buffer.from(body.plaintext, 'base64'), version);
          counters.reads += 1;
          record('transit-encrypt', 200, routePath);
          sendJson(res, 200, { data: { ciphertext, key_version: version } });
          return;
        }
        if (typeof body.ciphertext !== 'string') {
          record('transit-rejected', 400, routePath);
          sendJson(res, 400, { errors: ['ciphertext is required'] });
          return;
        }
        const match = CIPHERTEXT.exec(body.ciphertext);
        const source = match ? Number(match[1]) : 0;
        const plaintext = transitDecrypt(keyName, body.ciphertext);
        if (operation === 'decrypt') {
          counters.reads += 1;
          record('transit-decrypt', 200, routePath);
          sendJson(res, 200, { data: { plaintext: plaintext.toString('base64') } });
          return;
        }
        const target = resolveVersion(body.key_version, keyState);
        if (target < source) {
          record('transit-rejected', 400, routePath);
          sendJson(res, 400, { errors: ['rewrap cannot downgrade the key version'] });
          return;
        }
        ensureTransitVersion(keyName, keyState, target);
        const ciphertext = transitEncrypt(keyName, plaintext, target);
        counters.writes += 1;
        record('transit-rewrap', 200, routePath);
        sendJson(res, 200, { data: { ciphertext, key_version: target } });
        return;
      }

      record('not-found', 404, routePath);
      sendJson(res, 404, { errors: [] });
    })().catch((error) => {
      if (error instanceof WireError) {
        record('wire-error', error.status, 'redacted');
        sendJson(res, error.status, { errors: error.errors });
        return;
      }
      try {
        record('server-error', 500, 'redacted');
        sendJson(res, 500, { errors: ['internal server error'] });
      } catch {
        // socket gone
      }
    });
  });

  const port = await bindLoopback(server, options.port ?? DEFAULT_PORT);
  server.keepAliveTimeout = 0;

  return {
    url: 'http://127.0.0.1:' + port,
    port,
    tokens: { ...fixture.tokens },
    kvMount: fixture.kv.mount,
    transitMount: fixture.transit.mount,
    allowedKeyRefs: { ...fixture.transit.allowedKeyRefs },
    metadataKeyRef: fixture.transit.metadataKeyRef,
    publicUploadKeyRef: fixture.transit.publicUploadKeyRef,
    now,
    advance(ms) {
      clock += ms;
    },
    counters: () => ({ ...counters }),
    requests: () => requestLog.map(entry => ({ ...entry })),
    versionsOf: (secretPath) => (kvSecrets.get(secretPath) ?? []).map(entry => entry.version),
    readValue: (secretPath, key) => {
      const head = latest(secretPath);
      return head && Object.prototype.hasOwnProperty.call(head.data, key)
        ? { value: head.data[key], version: head.version }
        : undefined;
    },
    stop: () =>
      new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

module.exports = { DEFAULT_PORT, WireError, startMockVaultService };

