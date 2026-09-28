const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(F, 'utf8').split(/\r?\n/);
const i = L.findIndex(function (x) { return /^## 20 /.test(x); });
const j = L.findIndex(function (x, k) { return k > i && /^## 21 /.test(x); });
console.log('MUC20 lines ' + (i+1) + '..' + j);
L.slice(i, j).forEach(function (x, k) { console.log((i + k + 1) + ': ' + x); });