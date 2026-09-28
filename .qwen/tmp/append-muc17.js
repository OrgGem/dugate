const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const s = fs.readFileSync(p, 'utf8');
if (s.indexOf('## 17 — CYCLE 17') >= 0) { console.log('ALREADY'); process.exit(0); }
fs.appendFileSync(p, fs.readFileSync('D:/Git/dugate/.qwen/tmp/muc17.md', 'utf8'), 'utf8');
const after = fs.readFileSync(p, 'utf8');
console.log('appended lines=' + after.split(NL).length + ' bytes=' + Buffer.byteLength(after) + ' CRLF=' + (after.split(String.fromCharCode(13)+NL).length-1) + ' FFFD=' + (after.indexOf(String.fromCharCode(65533))>=0));