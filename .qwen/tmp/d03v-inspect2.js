
const fs = require('fs');
const f = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(f, 'utf8').split(/\r?\n/);
L.slice(117, 131).forEach((x, i) => console.log((118 + i) + ': ' + x));
console.log('=== Muc headings ===');
L.forEach((x, i) => { if (/^##+\s/.test(x) && !/RESUME POINT/i.test(x)) console.log((i + 1) + ': ' + x.slice(0, 110)); });
console.log('=== EOL ===');
const raw = fs.readFileSync(f);
let crlf = 0, lf = 0;
for (let i = 0; i < raw.length; i++) if (raw[i] === 10) { if (i > 0 && raw[i-1] === 13) crlf++; else lf++; }
console.log('crlf=' + crlf + ' lf_only=' + lf + ' endsWithNewline=' + (raw[raw.length-1] === 10));
