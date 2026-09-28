const fs = require('fs');
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const NL = String.fromCharCode(10);
const ED = String.fromCharCode(8212);
const s = fs.readFileSync(p, 'utf8');
const L = s.split(NL);
const before = L.filter(l => new RegExp('^- ' + '\\d+ ' + ED).test(l)).length;
// find all row-15 lines
const idx = [];
L.forEach((l, i) => { if (l.startsWith('- 15 ')) idx.push(i); });
console.log('row15_positions=' + JSON.stringify(idx));
idx.forEach(i => console.log(i + ': ' + L[i].slice(0, 60)));
if (idx.length > 1) {
  // keep the first, remove rest (the shorter more-accurate one)
  for (let k = idx.length - 1; k >= 1; k--) L.splice(idx[k], 1);
}
fs.writeFileSync(p, L.join(NL), 'utf8');
const a = fs.readFileSync(p, 'utf8');
const AL = a.split(NL);
const nums = AL.filter(l => new RegExp('^- ' + '\\d+ ' + ED).test(l)).map(l => Number(l.match(/^- (\\d+)/)[1]));
console.log('BEFORE=' + before + ' AFTER=' + nums.length + ' ASC=' + JSON.stringify(nums));