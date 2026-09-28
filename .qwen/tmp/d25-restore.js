const fs = require('fs');
const crypto = require('crypto');
const RT = 'D:/Git/dugate/du-rework/packages/contracts/src/runtime.ts';
const ENC = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
fs.writeFileSync(RT, fs.readFileSync('D:/Git/dugate/.qwen/tmp/bak-runtime.ts'));
fs.writeFileSync(ENC, fs.readFileSync('D:/Git/dugate/.qwen/tmp/bak-encryption.ts'));
function h(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 8); }
console.log('runtime.ts    sha=' + h(RT) + ' bytes=' + fs.statSync(RT).size + ' (expect 71c0458e / 20832)');
console.log('encryption.ts sha=' + h(ENC) + ' bytes=' + fs.statSync(ENC).size + ' (expect 395e0880 / 13973)');
const rt = fs.readFileSync(RT, 'utf8');
console.log('optional_restored=' + (rt.indexOf('encryption: StorageEnvelopeRefSchema.optional(),') !== -1));
let c = 0, l = 0;
for (let i = 0; i < rt.length; i++) if (rt.charCodeAt(i) === 10) { if (i > 0 && rt.charCodeAt(i-1) === 13) c++; else l++; }
console.log('runtime EOL crlf=' + c + ' lf=' + l);