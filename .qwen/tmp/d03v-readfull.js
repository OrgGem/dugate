const fs = require('fs');
const p = 'D:/Git/dugate/.qwen/tmp/d03v-full-now.log';
if (!fs.existsSync(p)) { console.log('LOG_MISSING'); process.exit(0); }
const t = fs.readFileSync(p, 'utf8');
console.log('bytes=' + t.length);
const L = t.split(/\r?\n/);
console.log('LINES=' + L.length);
L.forEach(function (x, i) { if (/^\s*(Test Suites:|Tests:|Snapshots:|Time:)/.test(x)) console.log('SUMMARY: ' + x.trim()); });
console.log('=== FAIL markers ===');
L.forEach(function (x, i) { if (/^\s*(FAIL|✕|×)/.test(x) || /\bFAIL\b/.test(x)) console.log((i + 1) + ': ' + x.slice(0, 160)); });