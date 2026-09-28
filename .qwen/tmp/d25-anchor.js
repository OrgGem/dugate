const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/du-rework/packages/contracts/src/runtime.ts', 'utf8');
let c = 0, l = 0;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) { if (i > 0 && t.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);
const i = t.indexOf('sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),');
console.log('anchorIdx=' + i);
console.log('bytes after anchor: ' + JSON.stringify(t.slice(i, i + 130)));