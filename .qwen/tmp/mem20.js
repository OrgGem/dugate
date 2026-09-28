const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let s = fs.readFileSync(p, 'utf8');
const anchor = 'Cycle tiep: append Muc 20.';
const i = s.indexOf(anchor);
if (i < 0) { console.log('ANCHOR_MISS'); process.exit(2); }
s = s.slice(0, i) + 'Cycle tiep: append Muc 21.' + s.slice(i + anchor.length);
s = s.replace(/\s+$/, '') + fs.readFileSync('D:/Git/dugate/.qwen/tmp/mem20-lessons.txt', 'utf8') + NL;
fs.writeFileSync(p, s, 'utf8');
console.log('memory lines=' + s.split(NL).length + ' has_lesson4=' + (s.indexOf('BAI HOC 4') >= 0) + ' has_muc21=' + (s.indexOf('append Muc 21.') >= 0));