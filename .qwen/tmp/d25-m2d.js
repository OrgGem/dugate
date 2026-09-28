const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
fs.writeFileSync(SRC, fs.readFileSync('D:/Git/dugate/.qwen/tmp/bak-encryption.ts'));
const orig = fs.readFileSync(SRC, 'utf8');
const start = orig.indexOf('  // Byte lengths are enforced');
const tail = '  });\nexport type StorageEnvelopeRef';
const end = orig.indexOf(tail);
console.log('start=' + start + ' end=' + end);
if (start === -1 || end === -1) { console.log('ANCHOR_FAIL'); process.exit(1); }
// keep `}).strict()` (ends just before start), add only the closing semicolon
const mutated = orig.slice(0, start) + ';\n' + orig.slice(end + tail.length);
fs.writeFileSync(SRC, mutated, 'utf8');
console.log('M2 clean applied ' + orig.length + ' -> ' + mutated.length);
console.log('has_strict=' + (mutated.indexOf('}).strict();') !== -1));
console.log('has_nonce_refine=' + (mutated.indexOf('GCM_NONCE_BYTES, {') !== -1));
const L = mutated.split('\n');
for (let k = 284; k < 292; k++) console.log('  ' + (k+1) + ': ' + String(L[k]).slice(0,80));