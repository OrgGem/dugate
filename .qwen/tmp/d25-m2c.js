const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
fs.writeFileSync(SRC, fs.readFileSync('D:/Git/dugate/.qwen/tmp/bak-encryption.ts'));
const orig = fs.readFileSync(SRC, 'utf8');
const start = orig.indexOf('}).strict()\n  // Byte lengths are enforced');
const endMark = '  });\nexport type StorageEnvelopeRef';
const end = orig.indexOf(endMark);
console.log('start=' + start + ' end=' + end);
if (start === -1 || end === -1 || end < start) { console.log('ANCHOR_FAIL'); process.exit(1); }
const mutated = orig.slice(0, start) + '});\nexport type StorageEnvelopeRef' + orig.slice(end + endMark.length);
fs.writeFileSync(SRC, mutated, 'utf8');
console.log('M2 applied, bytes ' + orig.length + ' -> ' + mutated.length);
console.log('has_nonce_refine=' + (mutated.indexOf('GCM_NONCE_BYTES, {') !== -1));
const L = mutated.split('\n');
console.log('--- tail ---');
L.slice(L.length-8, L.length-3).forEach(function (x, k) { console.log('  ' + (L.length-8+k+1) + ': ' + x.slice(0,90)); });