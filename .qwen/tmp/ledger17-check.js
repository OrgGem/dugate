const fs = require('fs');
const NL = String.fromCharCode(10);
const ED = String.fromCharCode(8212);
const s = fs.readFileSync('D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md', 'utf8');
const L = s.split(NL);
const rows = L.filter(function (l) { return l.indexOf('- ') === 0 && l.indexOf(' ' + ED) > 0 && /^-\d+ /.test(l); });
console.log('LEDGER_ROWS=' + rows.length);
rows.forEach(function (l, i) { console.log('  ' + (i + 1) + ': ' + l.slice(0, 60)); });
console.log('dupes=' + (rows.length - new Set(rows.map(function (l) { return l.match(/^-(\d+)/)[1]; })).size));