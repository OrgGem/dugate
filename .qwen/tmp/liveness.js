const { execSync } = require('child_process');
const list = JSON.parse(execSync('orca terminal list --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
for (const t of list.result.terminals) {
  let state = 'STALE';
  try {
    const s = JSON.parse(execSync('orca terminal show --terminal ' + t.handle + ' --json', { stdio: ['ignore','pipe','ignore'] }).toString('utf8'));
    if (s.ok) state = 'ALIVE';
  } catch (e) {
    try { const s2 = JSON.parse(String(e.stdout||'{}')); if (s2.ok) state='ALIVE'; } catch {}
  }
  console.log(t.handle.slice(0,14) + ' ' + state + ' [' + (t.agentIdentity||'-') + '] "' + (t.title||'').slice(0,45) + '"');
}
