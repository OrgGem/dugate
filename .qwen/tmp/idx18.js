const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/MEMORY.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const i = L.findIndex(function (l) { return l.indexOf('- [Qwen-Platform lane') === 0; });
if (i < 0) { console.log('NOT_FOUND'); process.exit(2); }
L[i] = '- [Qwen-Platform lane — 18 cycles; ENC-META-01 landed, ENC-04 blocked, 2 packets sai nguyen nhan](project/qwen-platform-lane-state.md) — c16 ENC-01 schemas; c17 metadata-crypto (23/23, M1 do dung 4 binding test); c18 ENC-04 BLOCKED: facade o orchestrator ngoai scope, worker chua co duong nhan DEK, packages/document-core khong ton tai; ba lần packet sai nguyen nhan/scope (W-INGEST-0019-2, W-VAULT-06-DELTA31, W-ENC-01) — kinh nghiem do bang lenh truoc khi sua';
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('index line updated');
console.log(L[i].slice(0, 100));