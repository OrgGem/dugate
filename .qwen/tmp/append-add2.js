const fs = require('fs');
const NL = String.fromCharCode(10);
const rep = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const before = fs.readFileSync(rep, 'utf8');
if (before.indexOf('Bổ sung Verify (cuối cycle 14') >= 0) { console.log('ALREADY'); process.exit(0); }
fs.appendFileSync(rep, fs.readFileSync('D:/Git/dugate/.qwen/tmp/muc14-addendum.md', 'utf8'), 'utf8');
const after = fs.readFileSync(rep, 'utf8');
console.log('lines=' + after.split(NL).length + ' bytes=' + Buffer.byteLength(after) + ' CRLF=' + (after.split(String.fromCharCode(13) + NL).length - 1) + ' FFFD=' + (after.indexOf('\ufffd') >= 0));