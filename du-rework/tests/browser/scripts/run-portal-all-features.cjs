#!/usr/bin/env node
/**
 * Runner for the comprehensive Orchestrator Portal UI E2E suite.
 *
 * 1. Boots tests/browser/admin-web/harness.ts (real Orchestrator admin shell +
 *    real apps/admin-web/dist + scripted upstream stub) via `pnpm dlx tsx`.
 * 2. Runs tests/orchestrator-portal-all-features.spec.ts on desktop + mobile
 *    with PORTAL_E2E_* env pointing at that harness.
 * 3. Stops the harness and prints the summary paths.
 *
 * Usage (from anywhere): node tests/browser/scripts/run-portal-all-features.cjs
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BROWSER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BROWSER_DIR, '..', '..');
const ARTIFACTS = path.join(BROWSER_DIR, 'artifacts');
const HARNESS_JSON = path.join(ARTIFACTS, 'portal-harness.json');
const HARNESS_TS = path.join(BROWSER_DIR, 'admin-web', 'harness.ts');
const DIST_INDEX = path.join(REPO_ROOT, 'apps', 'admin-web', 'dist', 'index.html');

if (!fs.existsSync(DIST_INDEX)) {
  console.error('[portal-e2e] apps/admin-web/dist/index.html is missing. Build it first:');
  console.error('  pnpm --filter @du/admin-web build');
  process.exit(2);
}
fs.mkdirSync(ARTIFACTS, { recursive: true });
try {
  fs.unlinkSync(HARNESS_JSON);
} catch {
  /* first run */
}

const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

const harness = spawn(
  pnpm,
  ['dlx', 'tsx', path.relative(REPO_ROOT, HARNESS_TS), path.relative(REPO_ROOT, HARNESS_JSON)],
  { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin },
);
harness.stdout.on('data', (chunk) => process.stdout.write(`[harness] ${chunk}`));
harness.stderr.on('data', (chunk) => process.stderr.write(`[harness] ${chunk}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHarness(timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(HARNESS_JSON)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(HARNESS_JSON, 'utf8'));
        if (parsed.url && parsed.sessions && parsed.sessions.operator) return parsed;
      } catch {
        /* still being written */
      }
    }
    if (harness.exitCode !== null) {
      throw new Error(`harness exited early with code ${harness.exitCode}`);
    }
    await sleep(500);
  }
  throw new Error('harness did not become ready within 150s');
}

function stopHarness() {
  if (harness.exitCode !== null) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(harness.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    harness.kill('SIGTERM');
  }
}

(async () => {
  const info = await waitForHarness();
  console.log(`[portal-e2e] harness ready at ${info.url} (stub ${info.stubUrl})`);

  const run = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['playwright', 'test', 'tests/orchestrator-portal-all-features.spec.ts', '--reporter=list'],
    {
      cwd: BROWSER_DIR,
      stdio: 'inherit',
      shell: isWin,
      env: {
        ...process.env,
        PORTAL_E2E_URL: info.url,
        PORTAL_E2E_STUB: info.stubUrl,
        PORTAL_E2E_ADMIN_SESSION: info.sessions.admin,
        PORTAL_E2E_OPERATOR_SESSION: info.sessions.operator,
        PORTAL_E2E_TENANT: info.tenant ?? '',
      },
    },
  );
  const code = await new Promise((resolve) => run.on('exit', (value) => resolve(value ?? 1)));
  stopHarness();
  console.log(`[portal-e2e] playwright exit ${code}`);
  console.log(`[portal-e2e] summary: ${path.join(ARTIFACTS, 'portal-all-features-summary.json')}`);
  console.log(`[portal-e2e] json report: ${path.join(ARTIFACTS, 'playwright-report.json')}`);
  process.exit(code);
})().catch((error) => {
  stopHarness();
  console.error('[portal-e2e]', error);
  process.exit(1);
});
