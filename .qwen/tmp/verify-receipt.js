const fs = require('fs');
const NL = String.fromCharCode(10);
const s = fs.readFileSync('D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md', 'utf8');
console.log('lines=' + s.split(NL).length + ' bytes=' + Buffer.byteLength(s) + ' CRLF=' + (s.split(String.fromCharCode(13) + NL).length - 1));
console.log('has_RP13=' + (s.indexOf('cuối cycle 13') >= 0) + ' hasLedger13=' + (s.indexOf('- 13 — W-INGEST-0019-2') >= 0) + ' hasMuc13=' + (s.indexOf('## 13 — CYCLE 13') >= 0) + ' staleRP12=' + (s.indexOf('cuối cycle 12') >= 0));
console.log('cycle12ref=' + (s.match(/cuối cycle 1[0-9]/g) || []).join(','));