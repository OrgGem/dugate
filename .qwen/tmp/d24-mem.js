const fs = require('fs');
const P = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let t = fs.readFileSync(P, 'utf8');
const add = fs.readFileSync('D:/Git/dugate/.qwen/tmp/cycle24-memory.md', 'utf8').replace(/\r\n/g, '\n');
if (t.indexOf('## Cycle 24 (2026-09-28)') !== -1) console.log('ALREADY_PRESENT');
else { t = t.replace(/\n+$/, '\n') + add; fs.writeFileSync(P, t, 'utf8'); console.log('APPENDED'); }
const chk = fs.readFileSync(P, 'utf8');
console.log('bytes=' + chk.length + ' has24=' + (chk.indexOf('## Cycle 24 (2026-09-28)') !== -1) + ' has23=' + (chk.indexOf('## Cycle 23 (2026-09-28)') !== -1));