#!/usr/bin/env node
// Stop only Node entrypoints belonging to this exact workspace; never select by port.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const entries = ['scripts/dev.cjs', 'services/orchestrator/dist/main.js', 'services/connector/dist/entrypoint.js', ...['document-core', 'lc-checker', 'example-review'].map(worker => `businesses/${worker}/dist/main.js`)];
function target(command) {
  const normalized = command.replaceAll('\\', '/');
  return entries.some(entry => {
    const full = path.join(ROOT, entry).replaceAll('\\', '/');
    const start = normalized.indexOf(full);
    return start >= 0 && [' ', '"', "'", undefined].includes(normalized[start + full.length]);
  });
}
let processes;
if (process.platform === 'win32') {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) { console.error('Cannot inspect local Node processes'); process.exit(1); }
  const parsed = JSON.parse(result.stdout.trim() || '[]');
  processes = (Array.isArray(parsed) ? parsed : [parsed]).map(proc => ({ pid: proc.ProcessId, command: proc.CommandLine || '' }));
} else {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) process.exit(1);
  processes = result.stdout.split('\n').map(line => { const match = line.trim().match(/^(\d+)\s+(.*)$/); return match ? { pid: Number(match[1]), command: match[2] } : { pid: 0, command: '' }; });
}
for (const proc of processes) {
  if (!proc.pid || proc.pid === process.pid || !target(proc.command)) continue;
  console.log(`Stopping local DU process ${proc.pid}`);
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
  else { try { process.kill(proc.pid, 'SIGTERM'); } catch {} }
}
