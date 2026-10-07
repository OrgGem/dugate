#!/usr/bin/env node
/**
 * R1-C harness aggregator (BR-Q3-01 offline harness, plan qwen3.md sec.6.2).
 * Runs each boundary suite in its own package via explicit file path (never relying on
 * jest "projects" magic — see report W46-Q3-3 correction), prints the evidence block:
 * per-suite exit code + literal "Tests:" line + SHA-256 of every production file the
 * harness pins. [OPEN:*] reds are EXPECTED (they gate the fix); exit 0 means every suite
 * that exists produced a Tests: line. Missing suite files are reported as ABSENT (exit 1).
 *
 * Usage: node tests/harness/network-boundaries/verify-r1c.cjs   (cwd anywhere)
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // du-rework/

const SUITES = [
  { pkg: 'orchestrator/packages/egress', file: 'tests/egress-boundaries.boundary.test.ts' },
  { pkg: 'orchestrator/packages/egress', file: 'tests/egress-ssrf-deny-matrix.boundary.test.ts' },
  { pkg: 'orchestrator/packages/egress', file: 'tests/egress-ssrf-redirect-matrix.boundary.test.ts' },
  { pkg: 'orchestrator/services/connector', file: 'tests/network-boundaries.boundary.test.ts' },
  { pkg: 'orchestrator/services/orchestrator', file: 'tests/webhook-error-boundaries.boundary.test.ts' },
  { pkg: 'orchestrator/services/orchestrator', file: 'tests/graceful-shutdown.boundary.test.ts' },
  { pkg: 'orchestrator/services/orchestrator', file: 'tests/gsec-sentinel-rbac.boundary.test.ts' },
  { pkg: 'orchestrator/services/connector', file: 'tests/gsec-redaction.boundary.test.ts' },
  { pkg: 'orchestrator/packages/connector-client', file: 'tests/network-boundaries.boundary.test.ts' },
  { pkg: 'orchestrator/packages/worker-sdk', file: 'tests/network-boundaries.boundary.test.ts' },
];

const SOURCES = [
  'orchestrator/packages/egress/src/pinned-fetch.ts',
  'orchestrator/services/connector/src/adapters/pinned-fetch.ts',
  'orchestrator/services/connector/src/adapters/transport.ts',
  'orchestrator/services/orchestrator/src/modules/webhooks/webhooks.ts',
  'orchestrator/services/orchestrator/src/server.ts',
  'orchestrator/services/orchestrator/src/shutdown.ts',
  'orchestrator/services/orchestrator/src/main.ts',
  'orchestrator/packages/connector-client/src/transport.ts',
  'orchestrator/packages/worker-sdk/src/artifact-streams.ts',
  'orchestrator/packages/worker-sdk/src/task-context.ts',
  'orchestrator/packages/contracts/src/errors.ts',
  'orchestrator/packages/contracts/src/operations.ts',
  'orchestrator/packages/observability/src/redaction.ts',
];

function sha256(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return 'ABSENT';
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

let hardFailure = false;
const results = [];
for (const s of SUITES) {
  const abs = path.join(ROOT, s.pkg, s.file);
  if (!fs.existsSync(abs)) {
    results.push({ suite: s.pkg + '/' + s.file, status: 'ABSENT' });
    hardFailure = true;
    continue;
  }
  const r = spawnSync('pnpm', ['--dir', s.pkg, 'exec', 'jest', s.file, '--runInBand'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const testsLine = (out.match(/Tests: .*/g) || []).pop() || 'NO_TESTS_LINE';
  const suitesLine = (out.match(/Test Suites: .*/g) || []).pop() || 'NO_SUITES_LINE';
  const crashed = testsLine === 'NO_TESTS_LINE';
  if (crashed) hardFailure = true;
  results.push({ suite: s.pkg + '/' + s.file, exit: r.status, tests: testsLine.trim(), suites: suitesLine.trim() });
}

console.log('===== R1-C harness evidence =====');
for (const x of results) console.log(JSON.stringify(x));
console.log('----- pinned production digests (sha256) -----');
for (const src of SOURCES) console.log(sha256(src) + '  ' + src);
console.log('----- note: non-zero suite exits with [OPEN:*] cases failing are EXPECTED until the fixes land -----');
process.exit(hardFailure ? 1 : 0);
