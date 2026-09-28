const fs = require('fs');
const crypto = require('crypto');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/';
function h(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 8); }
const rt = h(SRC + 'runtime.ts');
const en = h(SRC + 'encryption.ts');
console.log('runtime.ts    sha=' + rt + ' expect 71c0458e ' + (rt === '71c0458e' ? 'OK' : 'MISMATCH'));
console.log('encryption.ts sha=' + en + ' expect 395e0880 ' + (en === '395e0880' ? 'OK' : 'MISMATCH'));
const r = fs.readFileSync(SRC + 'runtime.ts', 'utf8');
console.log('encryption is optional = ' + (r.indexOf('encryption: StorageEnvelopeRefSchema.optional(),') !== -1));
console.log('no leftover M1 (required) = ' + (r.indexOf('encryption: StorageEnvelopeRefSchema,\n') === -1));
const e = fs.readFileSync(SRC + 'encryption.ts', 'utf8');
console.log('refines present = ' + (e.indexOf('GCM_NONCE_BYTES, {') !== -1 && e.indexOf('GCM_TAG_BYTES, {') !== -1));
console.log('.strict() present = ' + (e.indexOf('}).strict();\nexport type StorageEnvelopeRef') !== -1));
let c = 0, l = 0;
for (let i = 0; i < r.length; i++) if (r.charCodeAt(i) === 10) { if (i > 0 && r.charCodeAt(i-1) === 13) c++; else l++; }
console.log('runtime EOL crlf=' + c + ' lf=' + l);