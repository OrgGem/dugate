const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/MEMORY.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const k = L.findIndex(function (l) { return l.indexOf('- [Qwen-Platform lane') === 0; });
if (k < 0) { console.log('NOT_FOUND'); process.exit(2); }
const dash = String.fromCharCode(8212);
L[k] = '- [Qwen-Platform lane ' + dash + ' 20 cycles; ENC-04 seam + document-core wired, full 44/44 + 529/529 xanh](project/qwen-platform-lane-state.md)' +
  ' ' + dash + ' c19 facade port + seam; c20 doc-core ctx.crypto optional + checkpoint seal + 9 test; 2 lan trong 2 cycle assertion cua toi khong cat (base64 leak, cryptoFor vs cryptoSeam) ' +
  dash + ' D44/D45/D47 van mo, chua deployment bat seam' + dash + ' f1 live + live-PG van gom';
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('index updated');