/**
 * LIVE-GATES harness shared helpers (Claude review §10.7-5 / §11.4-5).
 *
 * These scripts prepare and run the live gates on the TAGGED candidate image
 * `candidate-portal-swagger-20261006-r4.1`:
 *   1. byte-scan PG / S3 / Vault for plaintext credential sentinels,
 *   2. migration 0035/0036 applied-state on the candidate DB,
 *   3. live HTTPS webhook IdP + receiver dispatch.
 *
 * Harness-only: no product code is imported for the DB/S3/Vault scans, and
 * nothing outside `tools/live-gates` + the evidence directory is written.
 *
 * Exit codes (shared): 0 PASS, 1 FAIL (leak/mismatch), 2 CONFIG/PREREQ error.
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG = 2;

/** du-rework root (this file lives in tools/live-gates/lib). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ORCHESTRATOR_PKG = path.join(REPO_ROOT, 'services', 'orchestrator', 'package.json');
const HARNESS_DIR = path.resolve(__dirname, '..');

function requireFromOrchestrator(name) {
  return createRequire(ORCHESTRATOR_PKG)(name);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function defaultReportsDir() {
  return path.join(REPO_ROOT, 'coordination', 'reports', 'raw', `live-gates-${todayStamp()}`);
}

/** `--key=value`, `--key value`, and bare `--flag` argv parser. */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * Minimal .env reader (KEY=VALUE, `#` comments). Existing process.env wins.
 * Values are trimmed of a single pair of quotes; no shell expansion.
 */
function loadEnvFile(file, env = process.env) {
  if (!file || !fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function configError(message) {
  const error = new Error(message);
  error.harnessConfig = true;
  return error;
}

/** Compose invocation from env: DU_LIVE_COMPOSE_FILES (comma list, ordered). */
function composeFiles(env = process.env) {
  const configured = env.DU_LIVE_COMPOSE_FILES;
  const files = configured
    ? configured.split(',').map((part) => part.trim()).filter(Boolean)
    : [path.join(REPO_ROOT, 'docker-compose.yml')];
  return files;
}

function composeBaseArgs(env = process.env) {
  const args = [];
  for (const file of composeFiles(env)) {
    if (!fs.existsSync(file)) throw configError(`compose file not found: ${file}`);
    args.push('-f', file);
  }
  if (env.DU_LIVE_PROJECT) args.push('--project-name', env.DU_LIVE_PROJECT);
  if (env.DU_LIVE_ENV_FILE) args.push('--env-file', env.DU_LIVE_ENV_FILE);
  return args;
}

function runCompose(args, opts = {}) {
  const result = spawnSync('docker', ['compose', ...composeBaseArgs(opts.env), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
    ...(opts.input === undefined ? {} : { input: opts.input }),
    timeout: opts.timeoutMs ?? 120_000,
  });
  if (result.error) throw configError(`docker compose failed to start: ${result.error.message}`);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Async compose runner. REQUIRED whenever the caller's process is also the
 * live HTTPS fixture: spawnSync blocks the event loop, so the container's
 * requests to the in-process IdP/receiver would time out while the exec is in
 * flight (found live during the r4.1 execution packet).
 */
function runComposeAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...composeBaseArgs(opts.env), ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(configError(`docker compose timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(configError(`docker compose failed to start: ${error.message}`));
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Evidence writer: `<name>.json` (machine) + `<name>.log` (human lines).
 * Returns EXIT_PASS/EXIT_FAIL based on `pass`.
 */
function writeReport(reportsDir, name, payload, lines = []) {
  ensureDir(reportsDir);
  const jsonPath = path.join(reportsDir, `${name}.json`);
  const logPath = path.join(reportsDir, `${name}.log`);
  const body = {
    harness: 'live-gates',
    candidate: process.env.DU_LIVE_IMAGE_TAG ?? 'candidate-portal-swagger-20261006-r4.1',
    generatedAt: new Date().toISOString(),
    ...payload,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(body, null, 2), 'utf8');
  fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
  const verdict = body.pass === true ? 'PASS' : 'FAIL';
  process.stdout.write(`[live-gates] ${name}: ${verdict} -> ${jsonPath}\n`);
  for (const line of lines) process.stdout.write(`[live-gates] ${line}\n`);
  return body.pass === true ? EXIT_PASS : EXIT_FAIL;
}

/** High-confidence credential shapes (values are never printed in reports). */
const DEFAULT_PATTERNS = [
  { name: 'bearer-literal', re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'vault-token', re: /hvs\.[A-Za-z0-9_-]{10,}/g },
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Load explicit sentinels: `--sentinels a,b` and/or a JSON/line file. */
function loadSentinels(args, env = process.env) {
  const sentinels = new Set();
  const inline = args.sentinels ?? env.DU_LIVE_SENTINELS;
  if (typeof inline === 'string' && inline.length > 0) {
    for (const part of inline.split(',')) {
      const value = part.trim();
      if (value.length >= 8) sentinels.add(value);
    }
  }
  const file = args['sentinels-file'] ?? env.DU_LIVE_SENTINELS_FILE;
  if (typeof file === 'string' && file.length > 0 && fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    let values = [];
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sentinels) ? parsed.sentinels : [];
    } catch {
      values = raw.split(/\r?\n/);
    }
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length >= 8) sentinels.add(value.trim());
    }
  }
  return [...sentinels];
}

/** Scan a Buffer/string for sentinels + patterns; returns bounded hit list. */
function scanBytes(bytes, sentinels, patterns = DEFAULT_PATTERNS) {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('latin1');
  const hits = [];
  for (const sentinel of sentinels) {
    const index = text.indexOf(sentinel);
    if (index !== -1) {
      hits.push({ kind: 'sentinel', label: `sentinel-${sentinels.indexOf(sentinel) + 1}`, offset: index });
    }
  }
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    const match = pattern.re.exec(text);
    if (match) hits.push({ kind: 'pattern', label: pattern.name, offset: match.index });
    pattern.re.lastIndex = 0;
  }
  return hits;
}

function resolveDatabaseUrl(args, env = process.env) {
  const url = args['pg-url'] ?? env.DU_LIVE_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) {
    throw configError(
      'no database URL: pass --pg-url, or set DU_LIVE_DATABASE_URL/DATABASE_URL '
      + '(live infra default postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test)',
    );
  }
  return url;
}

module.exports = {
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_CONFIG,
  REPO_ROOT,
  HARNESS_DIR,
  ORCHESTRATOR_PKG,
  requireFromOrchestrator,
  defaultReportsDir,
  parseArgs,
  loadEnvFile,
  configError,
  composeFiles,
  composeBaseArgs,
  runCompose,
  runComposeAsync,
  ensureDir,
  writeReport,
  DEFAULT_PATTERNS,
  loadSentinels,
  scanBytes,
  resolveDatabaseUrl,
};
