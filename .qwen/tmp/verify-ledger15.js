const fs = require('fs');
const NL = String.fromCharCode(10);
const s = fs.readFileSync('D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md', 'utf8');
const L = s.split(NL);
console.log('TOTAL_LINES=' + L.length);
// Correct ledger pattern: '- N — ' (em-dash U+2014)
const ED = String.fromCharCode(8212);
const ledger = L.filter(l => new RegExp('^- ' + '\\d+ ' + ED).test(l));
console.log('LEDGER_ROWS=' + ledger.length);
ledger.forEach((l, i) => console.log((i+1) + ': ' + l.slice(0, 90)));
// Check RESUME POINT header
const rp = L.find(l => l.includes('RESUME POINT'));
console.log('RP_HEADER=' + (rp || 'NOT_FOUND'));
// Check row 15 content
const r15 = ledger.find(l => l.startsWith('- 15 '));
console.log('ROW15=' + (r15 ? r15.slice(0, 120) : 'MISSING'));
// File integrity
console.log('CRLF=' + (s.split(String.fromCharCode(13) + NL).length - 1));
console.log('FFFD=' + s.includes(String.fromCharCode(65533)));