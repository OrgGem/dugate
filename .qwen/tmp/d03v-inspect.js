
const fs = require('fs');
const f = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const raw = fs.readFileSync(f, 'utf8');
const L = raw.split(/\r?\n/);
console.log('TOTAL=' + L.length);
console.log('--- lines 95..118 ---');
L.slice(94, 118).forEach((x, i) => console.log((95 + i) + ': ' + x));
console.log('--- tail 55 ---');
const n = L.length;
L.slice(n - 55).forEach((x, i) => console.log((n - 55 + i + 1) + ': ' + x));
