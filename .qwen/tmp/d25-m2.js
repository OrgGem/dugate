const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/';
const T = 'D:/Git/dugate/.qwen/tmp/';
const L = fs.readFileSync(SRC + 'encryption.ts', 'utf8').split('\n');
// remove the two .refine blocks (the 6 lines after the .strict() close)
const out = [];
let i = 0, removed = 0;
while (i < L.length) {
  if (L[i].indexOf('.refine((e) => Buffer.from(e.nonce') !== -1) {
    i += 6; removed += 6; continue;
  }
  out.push(L[i]); i += 1;
}
console.log('lines removed=' + removed);
const mutated = out.join('\n').replace(/;\n$/, ';');
fs.writeFileSync(SRC + 'encryption.ts', mutated, 'utf8');
console.log('M2 applied: has_nonce_refine=' + (mutated.indexOf('GCM_NONCE_BYTES, {') !== -1));
console.log('MUTATED');