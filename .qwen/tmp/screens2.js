const { execSync } = require('child_process');
const list = JSON.parse(execSync('orca terminal list --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
const wanted = ['term_c9d336eb','term_b8fb9fa1','term_5b428e78','term_7c915f95','term_f190d102','term_c197dbdf','term_95aad78d','term_f6e13d60','term_9f71b9ca','term_f24ec5cb'];
for (const t of list.result.terminals.filter(t => wanted.some(w => t.handle.startsWith(w)))) {
  try {
    const j = JSON.parse(execSync('orca terminal read --terminal ' + t.handle + ' --screen --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
    const term = j.result?.terminal || {};
    const txt = term.screen ?? term.text ?? term.tail ?? term.output ?? '';
    const lines = String(txt).split(/\r?\n/).map(l => l.replace(/\s+$/,'')).filter(l => l.trim().length);
    console.log('===== ' + t.handle.slice(0,14) + ' [' + (t.agentIdentity||'-') + '] "' + (t.title||'').slice(0,44) + '" =====');
    console.log(lines.slice(-8).join('\n').slice(0, 900));
  } catch (e) { console.log('===== ' + t.handle.slice(0,14) + ' ERROR'); }
}
