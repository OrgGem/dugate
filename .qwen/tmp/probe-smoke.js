'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const base = 'D:/Git/dugate/du-rework/services/orchestrator';
const proc = spawn(process.execPath, [path.join(base, 'tests', 'fixtures', 'oidc02-replica-probe.js')], {
  env: Object.assign({}, process.env, {
    PROBE_ISSUER: 'http://127.0.0.1:9',
    REDIS_URL: 'redis://127.0.0.1:9',
    PROBE_TOKEN: 'smoke-token',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const kill = () => { try { proc.kill('SIGTERM'); } catch (e) {} };
const hard = setTimeout(() => { console.log('TIMEOUT', out); kill(); setTimeout(() => process.exit(2), 300); }, 15000);
proc.stdout.on('data', async (chunk) => {
  out += chunk.toString('utf8');
  const m = /LISTENING (\d+)/.exec(out);
  if (!m || out.includes('__done__')) return;
  out += '__done__';
  const port = m[1];
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/admin/login', { redirect: 'manual' });
    const body = await r.text();
    console.log('SMOKE route status=' + r.status + ' body=' + body.slice(0, 140));
    const p = await fetch('http://127.0.0.1:' + port + '/__probe/session?sid=zz', { headers: { 'x-probe-token': 'smoke-token' } });
    console.log('SMOKE probe status=' + p.status + ' body=' + (await p.text()).slice(0, 120));
  } catch (e) { console.log('SMOKE fetch error', e.message); }
  clearTimeout(hard);
  kill();
  setTimeout(() => process.exit(0), 400);
});
proc.stderr.on('data', (c) => { const s = c.toString('utf8'); if (s.includes('PROBE_ERROR')) console.log('PROBE_ERROR_SEEN', s.trim().slice(0, 200)); });
