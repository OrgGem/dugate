const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
fs.writeFileSync(SRC, fs.readFileSync('D:/Git/dugate/.qwen/tmp/bak-encryption.ts'));
const orig = fs.readFileSync(SRC, 'utf8');
const start = orig.indexOf('  // Byte lengths are enforced');
const typeLine = orig.indexOf('export type StorageEnvelopeRef = ');
console.log('start=' + start + ' typeLine=' + typeLine);
if (start === -1 || typeLine === -1 || typeLine < start) { console.log('ANCHOR_FAIL'); process.exit(1); }
const mutated = orig.slice(0, start) + ';\n' + orig.slice(typeLine);
fs.writeFileSync(SRC, mutated, 'utf8');
console.log('M2 clean applied ' + orig.length + ' -> ' + mutated.length);
console.log('has_strict=' + (mutated.indexOf('}).strict();') !== -1));
console.log('has_nonce_refine=' + (mutated.indexOf('GCM_NONCE_BYTES, {') !== -1));
console.log('has_type_export=' + (mutated.indexOf('export type StorageEnvelopeRef = z.infer') !== -1));
const L = mutated.split('\n');
for (let k = 285; k < 291; k++) console.log('  ' + (k+1) + ': ' + String(L[k]).slice(0,80));