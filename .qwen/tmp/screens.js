const { execSync } = require('child_process');
const list = JSON.parse(execSync('orca terminal list --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
const wanted = ['term_aaaf5945','term_95461591','term_f24ec5cb','term_99e936d6'];
const targets = list.result.terminals.filter(t => wanted.some(w => t.handle.startsWith(w)));
for (const t of targets) {
  try {
    const out = execSync('orca terminal read --terminal ' + t.handle + ' --screen --json', { maxBuffer: 20*1024*1024 }).toString('utf8');
    const j = JSON.parse(out);
    const term = j.result?.terminal || {};
    let txt = term.screen ?? term.text ?? term.tail ?? term.output ?? '';
    if (!txt) { console.log('===== ' + t.handle.slice(0,14) + ' keys=' + JSON.stringify(Object.keys(term))); continue; }
    const lines = String(txt).split(/\r?\n/).map(l => l.replace(/\s+$/,'')).filter(l => l.trim().length);
    console.log('===== ' + t.handle.slice(0,14) + ' [' + (t.agentIdentity||'-') + '] "' + (t.title||'').slice(0,50) + '" (' + lines.length + ' lines) =====');
    console.log(lines.slice(-20).join('\n'));
  } catch (e) { console.log('===== ' + t.handle.slice(0,14) + ' ERROR ' + String(e.message).replace(/\r?\n/g,' ').slice(0,140)); }
}
