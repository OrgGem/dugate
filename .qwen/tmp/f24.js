const { execSync } = require('child_process');
const j = JSON.parse(execSync('orca terminal read --terminal term_f24ec5cb-184d-4d55-880b-043bcf840755 --screen --json', { maxBuffer: 20971520 }).toString('utf8'));
const t = j.result.terminal || {};
const s = String(t.screen || t.text || '');
const L = s.split(/\r?\n/).map(x => x.replace(/\s+$/, '')).filter(x => x.trim());
console.log(L.slice(-16).join('\n').slice(0, 1600));
