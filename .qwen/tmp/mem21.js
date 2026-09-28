const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let s = fs.readFileSync(p, 'utf8');
const anchor = 'Cycle tiep: append Muc 21.';
const i = s.indexOf(anchor);
if (i < 0) { console.log('ANCHOR_MISS'); process.exit(2); }
s = s.slice(0, i) + 'Cycle tiep: append Muc 22.' + s.slice(i + anchor.length);
s = s.replace(/\s+$/, '') + fs.readFileSync('D:/Git/dugate/.qwen/tmp/mem21-lessons.txt', 'utf8') + NL;
fs.writeFileSync(p, s, 'utf8');
console.log('memory lines=' + s.split(NL).length + ' has_lesson5=' + (s.indexOf('BAI HOC 5') >= 0) + ' has_muc22=' + (s.indexOf('append Muc 22.') >= 0));