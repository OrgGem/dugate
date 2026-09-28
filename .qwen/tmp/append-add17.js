const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
fs.appendFileSync(p, fs.readFileSync('D:/Git/dugate/.qwen/tmp/muc17-add.md', 'utf8'), 'utf8');
const s = fs.readFileSync(p, 'utf8');
console.log('lines=' + s.split(NL).length + ' has_addendum=' + (s.indexOf('ledger tu sua') >= 0 || s.indexOf('ledger t') >= 0));
console.log('CRLF=' + (s.split(String.fromCharCode(13)+NL).length-1) + ' FFFD=' + (s.indexOf(String.fromCharCode(65533))>=0));