/**
 * scripts/stop-all.cjs
 * Safely stops all running DUGate local development services
 * Targets ONLY Orchestrator (ports 3000, 3001), Connector (port 8088), and Document-Core worker.
 */

const { execSync } = require('child_process');
const os = require('os');

const PORTS = [3000, 3001, 8088];
const TARGET_PATTERNS = [
  'services/orchestrator',
  'services\\orchestrator',
  'services/connector',
  'services\\connector',
  'businesses/document-core',
  'businesses\\document-core'
];

console.log('\x1b[36m======================================================================\x1b[0m');
console.log('\x1b[36m                 Stopping DUGate Local Services                       \x1b[0m');
console.log('\x1b[36m======================================================================\x1b[0m\n');

const isWin = os.platform() === 'win32';
const targetPids = new Set();

if (isWin) {
  // 1. Find PIDs listening on ports 3000, 3001, 8088
  try {
    const netstatOut = execSync('netstat -ano', { encoding: 'utf8' });
    const lines = netstatOut.split('\n');
    for (const line of lines) {
      if (!line.includes('LISTENING')) continue;
      for (const port of PORTS) {
        // match :3000, :3001, :8088 followed by space
        const regex = new RegExp(`:${port}\\s+.*LISTENING\\s+(\\d+)`, 'i');
        const match = line.match(regex);
        if (match && match[1]) {
          const pid = parseInt(match[1], 10);
          if (pid && pid !== process.pid) {
            targetPids.add(pid);
          }
        }
      }
    }
  } catch (err) {
    // ignore netstat errors
  }

  // 2. Find Node processes matching service paths (e.g. document-core worker)
  try {
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
    const psOut = execSync(psCmd, { encoding: 'utf8', timeout: 8000 }).trim();
    if (psOut) {
      let procs = [];
      try {
        const parsed = JSON.parse(psOut);
        procs = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {}

      for (const proc of procs) {
        if (!proc || !proc.CommandLine || !proc.ProcessId) continue;
        const cmd = proc.CommandLine;
        const isTarget = TARGET_PATTERNS.some(p => cmd.includes(p));
        if (isTarget && proc.ProcessId !== process.pid) {
          targetPids.add(proc.ProcessId);
        }
      }
    }
  } catch (err) {
    // ignore
  }

  // 3. Kill the target processes
  if (targetPids.size === 0) {
    console.log('\x1b[90m  No active DUGate services were found running.\x1b[0m\n');
  } else {
    for (const pid of targetPids) {
      try {
        console.log(`\x1b[33m  Stopping process (PID: ${pid})...\x1b[0m`);
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        console.log(`\x1b[32m  [Stopped] PID ${pid}\x1b[0m`);
      } catch (err) {
        // Process might have already terminated
      }
    }
    console.log('\n\x1b[32m✔ All DUGate services have been stopped successfully!\x1b[0m\n');
  }
} else {
  // POSIX (Linux/macOS)
  for (const port of PORTS) {
    try {
      const pid = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
      if (pid) {
        pid.split('\n').forEach(p => {
          const num = parseInt(p.trim(), 10);
          if (num && num !== process.pid) targetPids.add(num);
        });
      }
    } catch (e) {}
  }

  if (targetPids.size === 0) {
    console.log('\x1b[90m  No active DUGate services were found running.\x1b[0m\n');
  } else {
    for (const pid of targetPids) {
      try {
        console.log(`\x1b[33m  Stopping PID ${pid}...\x1b[0m`);
        process.kill(pid, 'SIGTERM');
        console.log(`\x1b[32m  [Stopped] PID ${pid}\x1b[0m`);
      } catch (err) {}
    }
    console.log('\n\x1b[32m✔ All DUGate services have been stopped successfully!\x1b[0m\n');
  }
}
