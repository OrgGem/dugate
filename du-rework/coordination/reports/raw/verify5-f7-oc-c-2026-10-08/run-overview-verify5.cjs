#!/usr/bin/env node
/**
 * VERIFY-5 (agent C/OC) temporary runner — F-7 overview usage tile.
 *
 * Boots tests/browser/admin-web/harness.ts (real admin shell + real admin-web
 * dist + scripted upstream stub) and runs admin-web/overview.spec.ts against
 * it. Modeled on tests/browser/scripts/run-portal-all-features.cjs.
 *
 * Usage: node %TEMP%\f7-verify5\run-overview-verify5.cjs
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BROWSER_DIR = 'D:\\Git\\dugate\\du-rework\\tests\\browser';
const REPO_ROOT = 'D:\\Git\\dugate\\du-rework';
const WORK_DIR = path.join(process.env.TEMP, 'f7-verify5');
const HARNESS_JSON = path.join(WORK_DIR, 'harness.json');
const EVIDENCE = path.join(WORK_DIR, 'evidence');
const HARNESS_TS = path.join(BROWSER_DIR, 'admin-web', 'harness.ts');
const DIST_INDEX = path.join(REPO_ROOT, 'orchestrator', 'apps', 'admin-web', 'dist', 'index.html');

if (!fs.existsSync(DIST_INDEX)) {
  console.error('[verify5] dist/index.html missing; cannot boot harness');
  process.exit(2);
}
fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });
try { fs.unlinkSync(HARNESS_JSON); } catch { /* first run */ }

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

async function waitForHarness(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(HARNESS_JSON)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(HARNESS_JSON, 'utf8'));
        if (parsed.url && parsed.sessions && parsed.sessions.operator && parsed.sessions.viewer) return parsed;
      } catch { /* still being written */ }
    }
    if (harness.exitCode !== null) {
      throw new Error(`harness exited early with code ${harness.exitCode}`);
    }
    await sleep(500);
  }
  throw new Error('harness did not become ready within 180s');
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
  console.log(`[verify5] harness ready at ${info.url} (stub ${info.stubUrl}) evidence=${EVIDENCE}`);

  const run = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['playwright', 'test', '--config', 'admin-web/playwright.config.ts', 'admin-web/overview.spec.ts', '--reporter=list'],
    {
      cwd: BROWSER_DIR,
      stdio: 'inherit',
      shell: isWin,
      env: {
        ...process.env,
        AWEB01B_URL: info.url,
        AWEB01B_EVIDENCE: EVIDENCE,
        AWEB03B_STUB: info.stubUrl,
        AWEB03B_OPERATOR: info.sessions.operator,
        AWEB03B_VIEWER: info.sessions.viewer,
        AWEB03B_TENANT: info.tenant ?? '',
      },
    },
  );
  const code = await new Promise((resolve) => run.on('exit', (value) => resolve(value ?? 1)));
  try {
    const stubLog = await fetch(`${info.stubUrl}/__stub/requests`).then((r) => r.json());
    const usageCalls = (stubLog.requests ?? []).filter((r) => String(r.path).startsWith('/api/v1/usage'));
    fs.writeFileSync(path.join(WORK_DIR, 'stub-usage-requests.json'), JSON.stringify(usageCalls, null, 2));
    console.log(`[verify5] /api/v1/usage calls observed at stub: ${usageCalls.length}`);
    for (const call of usageCalls) console.log(`[verify5]   ${call.path} tenantId=${call.tenantId} auth=${call.authHeaderPresent}`);
  } catch (error) {
    console.error('[verify5] stub request dump failed:', error && error.message ? error.message : error);
  }
  stopHarness();
  console.log(`[verify5] playwright exit ${code}`);
  process.exit(code);
})().catch((error) => {
  stopHarness();
  console.error('[verify5]', error);
  process.exit(1);
});
