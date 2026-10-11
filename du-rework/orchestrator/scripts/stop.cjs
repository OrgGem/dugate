#!/usr/bin/env node
const { execSync } = require('node:child_process');

const PORTS = [3000, 3001, 3002, 8088];

console.log('[stop] Checking for lingering processes on ports:', PORTS.join(', '));

for (const port of PORTS) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = output.trim().split('\n');
      const pids = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1].endsWith(`:${port}`)) {
          pids.add(parts[parts.length - 1]);
        }
      }
      for (const pid of pids) {
        if (pid && pid !== '0') {
          console.log(`[stop] Killing PID ${pid} listening on port ${port}...`);
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          } catch {}
        }
      }
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    }
  } catch {}
}

console.log('[stop] Done.');
