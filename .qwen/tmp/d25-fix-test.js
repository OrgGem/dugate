const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/packages/contracts/tests/grant-encryption-envelope.test.ts';
let t = fs.readFileSync(F, 'utf8');
let c = 0, l = 0;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) { if (i > 0 && t.charCodeAt(i-1) === 13) c++; else l++; }
console.log('before EOL crlf=' + c + ' lf=' + l);
const fix = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-fixt.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
const OLD = "    const deliveryShape = {\n      keyId: 'du-artifact-v1',";
const NEW = "    const deliveryShape = {\n      version: 1 as const,\n      keyId: 'du-artifact-v1',";
if (t.indexOf(OLD) === -1) { console.log('ANCHOR_MISS'); process.exit(1); }
t = t.replace(OLD, NEW);
fs.writeFileSync(F, t, 'utf8');
const chk = fs.readFileSync(F, 'utf8');
console.log('patched=' + (chk.indexOf('version: 1 as const,') !== -1));
let c2 = 0, l2 = 0;
for (let i = 0; i < chk.length; i++) if (chk.charCodeAt(i) === 10) { if (i > 0 && chk.charCodeAt(i-1) === 13) c2++; else l2++; }
console.log('after EOL crlf=' + c2 + ' lf=' + l2);