const { execSync } = require('child_process');
for (const [tag, h] of [['f24', 'term_f24ec5cb-184d-4d55-880b-043bcf840755'], ['qwen4R', 'term_e59238b5-b31f-458e-9dd2-3f2e42033d4d']]) {
  try {
    const j = JSON.parse(execSync('orca terminal read --terminal ' + h + ' --screen --json', { maxBuffer: 20971520 }).toString('utf8'));
    const t = j.result.terminal || {};
    const s = String(t.screen || t.text || '');
    const L = s.split(/\r?\n/).map(x => x.replace(/\s+$/, '')).filter(x => x.trim());
    console.log('##### ' + tag + ' (' + L.length + ' lines)');
    console.log(L.slice(-12).join('\n').slice(0, 1300));
  } catch (e) { console.log('##### ' + tag + ' ERR ' + String(e.message).slice(0, 80)); }
}
