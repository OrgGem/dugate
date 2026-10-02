/**
 * scripts/dev.cjs
 * Unified Dev Runner for DUGate Rework
 * Runs Orchestrator, Connector, and Worker in a single terminal with colored logs and single Ctrl+C shutdown.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');
const isWin = os.platform() === 'win32';

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

async function waitForHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) return true;
    } catch (e) {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log(`${C.cyan}======================================================================${C.reset}`);
  console.log(`${C.cyan}               DUGate Rework — Unified Dev Runner                     ${C.reset}`);
  console.log(`${C.cyan}======================================================================${C.reset}\n`);

  // ── 1. Kiểm tra cấu hình .env.local ─────────────────────────────────────────
  let envFile = '.env.local';
  const envLocalPath = path.join(ROOT_DIR, '.env.local');
  const envSamplePath = path.join(ROOT_DIR, '.env.local.sample');

  if (!fs.existsSync(envLocalPath)) {
    if (fs.existsSync(path.join(ROOT_DIR, '.env'))) {
      envFile = '.env';
      console.log(`${C.green}[Env] Using existing .env file.${C.reset}`);
    } else if (fs.existsSync(envSamplePath)) {
      fs.copyFileSync(envSamplePath, envLocalPath);
      console.log(`${C.green}[Env] Created .env.local from .env.local.sample${C.reset}`);
    }
  } else {
    console.log(`${C.green}[Env] Using configuration: ${envFile}${C.reset}`);
  }

  // ── 2. Dọn dẹp port cũ nếu có tiến trình đang chiếm ──────────────────────────
  try {
    const stopScript = path.join(__dirname, 'stop-all.cjs');
    const netstat = isWin ? execSync('netstat -ano', { encoding: 'utf8' }) : '';
    const hasConflict = [3000, 3001, 8088].some((p) => netstat.includes(`:${p} `));
    if (hasConflict) {
      console.log(`${C.yellow}[Port] Detected existing services on DU ports. Cleaning up first...${C.reset}`);
      execSync(`node "${stopScript}"`, { stdio: 'inherit' });
    }
  } catch (e) {
    // ignore
  }

  // ── 3. Kiểm tra Build ────────────────────────────────────────────────────────
  const orchDist = path.join(ROOT_DIR, 'services/orchestrator/dist/main.js');
  const connDist = path.join(ROOT_DIR, 'services/connector/dist/entrypoint.js');
  const workDist = path.join(ROOT_DIR, 'businesses/document-core/dist/main.js');

  if (!fs.existsSync(orchDist) || !fs.existsSync(connDist) || !fs.existsSync(workDist)) {
    console.log(`${C.yellow}[Build] Pre-compiled binaries not found. Building services...${C.reset}`);
    try {
      execSync(`node "${path.join(__dirname, 'build-all.cjs')}"`, { stdio: 'inherit', cwd: ROOT_DIR });
    } catch (err) {
      console.error(`${C.red}[Build] Build failed. Aborting.${C.reset}`);
      process.exit(1);
    }
  }

  // ── 4. Chạy Migration ────────────────────────────────────────────────────────
  try {
    console.log(`${C.cyan}[Database] Checking & applying migrations...${C.reset}`);
    execSync(`node "${path.join(__dirname, 'migrate-local.cjs')}"`, { stdio: 'inherit', cwd: ROOT_DIR });
  } catch (err) {
    console.warn(`${C.yellow}[Database] Migration check finished with warnings.${C.reset}`);
  }

  // ── 5. Setup Process Management & Shutdown ──────────────────────────────────
  const isWatch = process.argv.includes('--watch');
  const children = [];
  let isShuttingDown = false;

  function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${C.yellow}[Dev Manager] Stopping all DU services...${C.reset}`);

    for (const child of children) {
      if (child && child.pid) {
        try {
          if (isWin) {
            execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch (e) {}
      }
    }

    try {
      const stopScript = path.join(__dirname, 'stop-all.cjs');
      execSync(`node "${stopScript}"`, { stdio: 'ignore' });
    } catch (e) {}

    console.log(`${C.green}✔ All services stopped cleanly. Goodbye!${C.reset}\n`);
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('exit', () => {
    if (!isShuttingDown) shutdown();
  });

  console.log(`\n${C.green}======================================================================${C.reset}`);
  console.log(`${C.green} Starting Services (Unified Logs) — Press Ctrl+C anytime to stop all   ${C.reset}`);
  console.log(`${C.green}======================================================================${C.reset}`);
  console.log(`  ${C.bright}Orchestrator API${C.reset}  : http://localhost:3000`);
  console.log(`  ${C.bright}Admin Web Shell${C.reset}   : http://localhost:3001/admin/login`);
  console.log(`  ${C.bright}Connector${C.reset}         : http://localhost:8088/health/ready`);
  console.log(`  ${C.bright}Worker${C.reset}            : BullMQ Worker (Redis 6380)`);
  console.log(`${C.green}======================================================================${C.reset}\n`);

  function spawnService(svc) {
    const args = [`--env-file=${envFile}`];
    if (isWatch) {
      args.push('--watch');
    }
    args.push(svc.entry);

    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    children.push(child);

    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on('line', (line) => {
      console.log(`${svc.prefix}${line}`);
    });

    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on('line', (line) => {
      console.error(`${svc.prefix}${C.red}${line}${C.reset}`);
    });

    child.on('close', (code) => {
      if (!isShuttingDown && code !== 0) {
        console.log(`${svc.prefix}${C.red}Process exited with code ${code}${C.reset}`);
      }
    });

    child.on('error', (err) => {
      console.error(`${svc.prefix}${C.red}Failed to start: ${err.message}${C.reset}`);
    });

    return child;
  }

  // 1. Start Orchestrator & Connector
  spawnService({
    name: 'orchestrator',
    prefix: `${C.cyan}[orchestrator]${C.reset} `,
    entry: 'services/orchestrator/dist/main.js'
  });

  spawnService({
    name: 'connector',
    prefix: `${C.magenta}[connector]   ${C.reset} `,
    entry: 'services/connector/dist/entrypoint.js'
  });

  // 2. Wait for Orchestrator to be ready before starting worker
  const orchReady = await waitForHttp('http://localhost:3000/health', 10000);
  if (!orchReady) {
    console.warn(`${C.yellow}[Dev Manager] Orchestrator took longer than expected to report healthy, launching worker now...${C.reset}`);
  }

  // 3. Start Document-Core Worker
  spawnService({
    name: 'worker',
    prefix: `${C.yellow}[worker]      ${C.reset} `,
    entry: 'businesses/document-core/dist/main.js'
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
