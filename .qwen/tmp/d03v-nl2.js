const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let t = fs.readFileSync(F, 'utf8');
const before = t.length;
t = t.replace(/\n+$/, '\n');
fs.writeFileSync(F, t, 'utf8');
console.log('bytes ' + before + ' -> ' + t.length);
console.log('tailCodes=' + [t.charCodeAt(t.length-3), t.charCodeAt(t.length-2), t.charCodeAt(t.length-1)].join(','));
console.log('endsWithSingleLF=' + (t.charCodeAt(t.length-1) === 10 && t.charCodeAt(t.length-2) !== 10));
let c = 0, l = 0;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) { if (i > 0 && t.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);