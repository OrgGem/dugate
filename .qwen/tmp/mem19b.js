const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let s = fs.readFileSync(p, 'utf8');
const anchor = 'Cycle tiep: append Muc 19.';
const i = s.indexOf(anchor);
if (i < 0) { console.log('ANCHOR_MISS'); process.exit(2); }
s = s.slice(0, i) + 'Cycle tiep: append Muc 20.' + s.slice(i + anchor.length);
const lessons = fs.readFileSync('D:/Git/dugate/.qwen/tmp/mem19-lessons.txt', 'utf8');
s = s.replace(/\s+$/, '') + lessons + NL;
fs.writeFileSync(p, s, 'utf8');
console.log('memory updated lines=' + s.split(NL).length);
console.log('has_muc20=' + (s.indexOf('Cycle tiep: append Muc 20.') >= 0) + ' has_lesson1=' + (s.indexOf('BAI HOC 1') >= 0));