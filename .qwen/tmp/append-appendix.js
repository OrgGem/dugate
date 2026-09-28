const fs = require('fs');
const NL = String.fromCharCode(10);
const rep = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const before = fs.readFileSync(rep, 'utf8');
if (before.indexOf('Phụ lục — lệnh tái hiện') >= 0) { console.log('ALREADY_APPENDIX'); process.exit(0); }
const frag = fs.readFileSync('D:/Git/dugate/.qwen/tmp/muc13-appendix.md', 'utf8');
fs.appendFileSync(rep, frag, 'utf8');
const after = fs.readFileSync(rep, 'utf8');
console.log('lines=' + after.split(NL).length + ' bytes=' + Buffer.byteLength(after) + ' CRLF=' + (after.split(String.fromCharCode(13) + NL).length - 1));
console.log('appendix=' + (after.indexOf('Quyết định phạm vi (operator, 2026-09-27)') >= 0));
console.log('muc13=' + (after.indexOf('## 13 — CYCLE 13') >= 0) + ' muc12=' + (after.indexOf('### 12 — W-INGEST-PG-FAILCLOSED-1') >= 0));
console.log('U+FFFD=' + (after.indexOf('\ufffd') >= 0));