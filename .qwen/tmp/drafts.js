const { execSync } = require('child_process');
const list = JSON.parse(execSync('orca terminal list --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
const wanted = ['term_f24ec5cb','term_aaaf5945','term_7c915f95','term_9f71b9ca','term_c197dbdf','term_f190d102'];
for (const t of list.result.terminals.filter(t => wanted.some(w => t.handle.startsWith(w)))) {
  try {
    const j = JSON.parse(execSync('orca terminal read --terminal ' + t.handle + ' --screen --json', { maxBuffer: 20*1024*1024 }).toString('utf8'));
    const term = j.result?.terminal || {};
    const draft = term.draft;
    const hasDraft = draft && String(draft).trim().length;
    console.log(t.handle.slice(0,14) + ' draft=' + (hasDraft ? JSON.stringify(String(draft).slice(0,90)) : 'EMPTY') + ' last=' + new Date(t.lastOutputAt).toLocaleTimeString('en-GB') + ' title="' + (t.title||'').slice(0,40) + '"');
  } catch (e) { console.log(t.handle.slice(0,14) + ' ERR'); }
}
