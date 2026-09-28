const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
const L = fs.readFileSync(SRC, 'utf8').split('\n');
// lines 291..298 (1-based) = indices 290..297 inclusive -> 8 lines
const out = L.slice(0, 290).concat(L.slice(298));
out[289] = '}).strict();';
const mutated = out.join('\n');
fs.writeFileSync(SRC, mutated, 'utf8');
console.log('M2 applied');
console.log('has_nonce_refine=' + (mutated.indexOf('GCM_NONCE_BYTES, {') !== -1));
console.log('has_schema=' + (mutated.indexOf('StorageEnvelopeRefSchema') !== -1));
const t2 = fs.readFileSync(SRC, 'utf8').split('\n');
for (let k = 285; k < 294; k++) console.log('  ' + (k+1) + ': ' + String(t2[k]).slice(0,90));