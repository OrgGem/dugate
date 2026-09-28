const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/MEMORY.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const k = L.findIndex(function (l) { return l.indexOf('- [Qwen-Platform lane') === 0; });
if (k < 0) { console.log('NOT_FOUND'); process.exit(2); }
const dash = String.fromCharCode(8212);
L[k] = '- [Qwen-Platform lane ' + dash + ' 19 cycles; ENC-META-01 + worker crypto seam landed, 4 packets sai scope/nguyen nhan](project/qwen-platform-lane-state.md)' +
  ' ' + dash + ' c17 metadata-crypto; c18 ENC-04 BLOCKED; c19 port trung thuc facade + seam binding tenant CLAIM (14/14, M1 do dung 2 test fidelity); kinh nghiem: 12 test hanh vi khong bat duoc doi AAD' +
  ' (chi test so sanh file nguon moi bat), do loi theo import chu khong theo cam tinh' + dash + ' f1 live + live-PG van gom';
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('index updated');
console.log(L[k].slice(0, 110));