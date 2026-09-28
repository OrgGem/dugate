const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-base.log', 'utf8');
const L = t.split(/\r?\n/);
console.log('=== FAIL lines ===');
L.forEach(function (x, i) { if (/^FAIL /.test(x)) console.log((i+1) + ': ' + x.slice(0, 120)); });
console.log('=== first failure detail ===');
const i = L.findIndex(function (x) { return /●|error|Cannot find|SyntaxError/.test(x); });
if (i !== -1) L.slice(i, i + 18).forEach(function (x, k) { console.log((i+k+1) + ': ' + x.slice(0, 170)); });