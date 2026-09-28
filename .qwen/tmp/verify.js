const { execSync } = require('child_process');
const list = JSON.parse(execSync('orca terminal list --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
const wanted = ['term_f24ec5cb','term_aaaf5945','term_c9d336eb','term_7c915f95','term_9f71b9ca','term_c197dbdf','term_f190d102'];
for (const t of list.result.terminals.filter(t => wanted.some(w => t.handle.startsWith(w)))) {
  console.log('===== ' + t.handle.slice(0,14) + ' [' + (t.agentIdentity||'-') + '] "' + (t.title||'').slice(0,55) + '" last=' + new Date(t.lastOutputAt).toLocaleTimeString('en-GB'));
  try {
    const j = JSON.parse(execSync('orca terminal read --terminal ' + t.handle + ' --screen --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
    const term = j.result?.terminal || {};
    const txt = String(term.screen ?? term.text ?? term.tail ?? '');
    const lines = txt.split(/\r?\n/).map(l => l.replace(/\s+$/,'')).filter(l => l.trim().length);
    console.log(lines.slice(-4).join('\n').slice(0, 500));
  } catch (e) { console.log('read error'); }
}
