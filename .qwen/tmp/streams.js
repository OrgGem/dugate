const { execSync } = require('child_process');
try {
  const j = JSON.parse(execSync('orca terminal read --terminal term_e59238b5-b31f-458e-9dd2-3f2e42033d4d --limit 60 --json', { maxBuffer: 20971520 }).toString('utf8'));
  const t = j.result.terminal || {};
  const s = String(t.tail || t.screen || t.text || '');
  console.log('=== e59238b5 stream ===');
  console.log(s.slice(-1500));
} catch (e) { console.log('ERR', String(e.message).slice(0, 120)); }
try {
  const j2 = JSON.parse(execSync('orca terminal read --terminal term_f24ec5cb-184d-4d55-880b-043bcf840755 --limit 40 --json', { maxBuffer: 20971520 }).toString('utf8'));
  const t2 = j2.result.terminal || {};
  console.log('=== f24 stream tail ===');
  console.log(String(t2.tail || '').slice(-900));
} catch (e) { console.log('f24 ERR', String(e.message).slice(0, 120)); }
