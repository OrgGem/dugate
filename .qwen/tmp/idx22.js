const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/MEMORY.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const k = L.findIndex(function (l) { return l.indexOf('- [Qwen-Platform lane') === 0; });
if (k < 0) { console.log('NOT_FOUND'); process.exit(2); }
const dash = String.fromCharCode(8212);
L[k] = '- [Qwen-Platform lane ' + dash + ' 22 cycles; ENC-04 + ingest wire + DATA-03 READY gate; full doc-core 46/46 542/542](project/qwen-platform-lane-state.md)' +
  ' ' + dash + ' c19 facade port; c20 doc-core ctx.crypto; c21 OCR/digitize truyen artifact that; c22 URL task chua READY bi chan (pin+inline text loop hole); D30-D53 con mo ' +
  dash + ' don vao do truoc khi viet test, doc schema strict that';
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('index updated');