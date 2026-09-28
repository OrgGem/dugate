const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/MEMORY.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const k = L.findIndex(function (l) { return l.indexOf('- [Qwen-Platform lane') === 0; });
if (k < 0) { console.log('NOT_FOUND'); process.exit(2); }
const dash = String.fromCharCode(8212);
L[k] = '- [Qwen-Platform lane ' + dash + ' 21 cycles; ENC-04 seam + doc-core wired + ingest wire fixed; full doc-core 45/45 537/537](project/qwen-platform-lane-state.md)' +
  ' ' + dash + ' c19 facade port; c20 doc-core ctx.crypto + checkpoint seal; c21 OCR/digitize truyen artifact that thay hasBuffer/task-name (3 test cu chung minh sai da sua); D44-D51 con mo ' +
  dash + ' assert phai doc lai vung truoc khi sua lon';
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('index updated');