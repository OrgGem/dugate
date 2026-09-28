const fs = require('fs');
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let s = fs.readFileSync(p, 'utf8');
const before = s;
s = s.replace('cuối cycle 18, 2026-09-27', 'cuối cycle 18, 2026-09-28');
fs.writeFileSync(p, s, 'utf8');
console.log('changed=' + (s !== before));
console.log(s.split(String.fromCharCode(10)).filter(function (l) { return l.indexOf('## RESUME POINT') === 0; }).join(''));