const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
const add = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-enc-snippet.ts', 'utf8').replace(/\r\n/g, '\n');
let t = fs.readFileSync(F, 'utf8');
if (t.indexOf('StorageEnvelopeRefSchema') !== -1) { console.log('ALREADY_PRESENT'); process.exit(0); }
t = t.replace(/\n+$/, '\n') + add;
t = t.replace(/\n+$/, '\n');
fs.writeFileSync(F, t, 'utf8');
console.log('bytes ' + t.length);
console.log('has_schema=' + (t.indexOf('StorageEnvelopeRefSchema') !== -1));
console.log('singleLF=' + (t.charCodeAt(t.length-1) === 10 && t.charCodeAt(t.length-2) !== 10));
let c = 0, l = 0;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) { if (i > 0 && t.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);
console.log('--- last 6 lines ---');
t.split('\n').slice(-6).forEach(function (x) { console.log('  ' + x.slice(0, 100)); });