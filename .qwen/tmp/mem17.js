const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let s = fs.readFileSync(p, 'utf8');
const anchor = 'Cycle tiep: append Muc 16.';
const i = s.indexOf(anchor);
console.log('anchor_found=' + (i >= 0));
if (i >= 0) {
  const tail = 'Muc 17 = ENC-META-01 (task_9997ff605662): NEW src/modules/runtime/metadata-crypto.ts 324d (AES-256-GCM + ENC-02 Transit DEK + AAD bind tenant/slot/row) + 9 call site trong runtime.ts + 23 test; 23/23 x3, tsc 0, collateral 44/44, M1 do dung 4 binding test roi restore byte-exact; full 1877/1906 voi 1 do NGOAI LAI (admin shell, lane khac). ' + String.fromCharCode(916) + '36 submit-side input_ref O runtime scope (submission.ts), ' + String.fromCharCode(916) + '37 optional-param CHUA wiring nen production van plaintext, ' + String.fromCharCode(916) + '38 contracts chua can, ' + String.fromCharCode(916) + '39 outbox.payload de nguyen. Cycle tiep: append Muc 18.';
  s = s.slice(0, i) + tail + s.slice(i + anchor.length);
  fs.writeFileSync(p, s, 'utf8');
  console.log('memory updated');
}