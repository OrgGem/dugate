const fs = require('fs');
const L = fs.readFileSync('D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md', 'utf8').split(/\r?\n/);
const i = L.findIndex(function (x) { return /^## 23 /.test(x); });
console.log('MUC23 at line ' + (i + 1) + ' of ' + L.length);
console.log('--- verify section ---');
const v = L.findIndex(function (x, j) { return j > i && /#### Verify/.test(x); });
L.slice(v, v + 40).forEach(function (x, k) { console.log((v + k + 1) + ': ' + x); });