const { execSync } = require('child_process');
const j = JSON.parse(execSync('orca terminal list --json', { maxBuffer: 10 * 1024 * 1024 }).toString('utf8'));
for (const t of j.result.terminals) {
  const ts = new Date(t.lastOutputAt).toLocaleString('en-GB');
  console.log([t.handle.slice(0,14), t.agentIdentity || '-', (t.title||'').slice(0,60), 'last=' + ts, 'orphan=' + t.orphaned].join(' | '));
}
