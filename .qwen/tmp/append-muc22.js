const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const s = fs.readFileSync(p, 'utf8');
if (s.indexOf('## 22 — CYCLE 22') >= 0) { console.log('ALREADY'); process.exit(0); }
fs.appendFileSync(p, fs.readFileSync('D:/Git/dugate/.qwen/tmp/muc22.md', 'utf8') + fs.readFileSync('D:/Git/dugate/.qwen/tmp/muc22b.md', 'utf8'), 'utf8');
const a = fs.readFileSync(p, 'utf8');
console.log('lines=' + a.split(NL).length + ' bytes=' + Buffer.byteLength(a) + ' CRLF=' + (a.split(String.fromCharCode(13)+NL).length-1) + ' FFFD=' + (a.indexOf(String.fromCharCode(65533))>=0));
console.log('has_muc22=' + (a.indexOf('## 22 — CYCLE 22') >= 0));