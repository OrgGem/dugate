/**
 * Live-gates TLS fixture: a private CA + server cert covering the harness
 * names used by the candidate container.
 *
 * The candidate Orchestrator trusts the CA via `NODE_EXTRA_CA_CERTS` set by
 * `compose/live-gates.override.yml`; the harness passes the same CA to its own
 * HTTPS probes. Synthetic test-only material — never a production key.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SAN_ENTRIES = [
  'DNS:idp.live-gates.test',
  'DNS:receiver.live-gates.test',
  'DNS:host.docker.internal',
  'DNS:localhost',
  'IP:127.0.0.1',
];

function candidateOpensslPaths() {
  return [
    process.env.OPENSSL_BIN,
    'openssl',
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
    '/opt/homebrew/bin/openssl',
  ].filter(Boolean);
}

function findOpenssl() {
  for (const candidate of candidateOpensslPaths()) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runOpenssl(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  }
}

/**
 * Create (or reuse) CA + server cert/key in `certDir`. Returns absolute paths.
 * Throws a config error with remediation when openssl is unavailable.
 */
function ensureCerts(certDir, options = {}) {
  const dir = path.resolve(certDir);
  const caPath = path.join(dir, 'ca.pem');
  const certPath = path.join(dir, 'server.pem');
  const keyPath = path.join(dir, 'server.key');
  const info = { dir, caPath, certPath, keyPath, generated: false };
  if (!options.force && fs.existsSync(caPath) && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return info;
  }
  fs.mkdirSync(dir, { recursive: true });
  const bin = findOpenssl();
  if (!bin) {
    const error = new Error(
      'openssl not found (set OPENSSL_BIN; Git for Windows ships it at C:\\Program Files\\Git\\usr\\bin\\openssl.exe)',
    );
    error.harnessConfig = true;
    throw error;
  }
  const sanFile = path.join(dir, 'san.cnf');
  fs.writeFileSync(sanFile, `subjectAltName=${SAN_ENTRIES.join(',')}\n`, 'utf8');
  runOpenssl(bin, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3',
    '-subj', '/CN=du-live-gates-ca',
  ], dir);
  runOpenssl(bin, [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=receiver.live-gates.test',
  ], dir);
  runOpenssl(bin, [
    'x509', '-req', '-in', 'server.csr',
    '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.pem', '-days', '3', '-extfile', 'san.cnf',
  ], dir);
  fs.rmSync(path.join(dir, 'server.csr'), { force: true });
  info.generated = true;
  info.openssl = bin;
  return info;
}

function tmpCertDir() {
  return path.join(os.tmpdir(), 'du-live-gates-certs');
}

module.exports = { ensureCerts, findOpenssl, tmpCertDir, SAN_ENTRIES };
