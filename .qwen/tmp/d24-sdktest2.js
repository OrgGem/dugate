const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/du-rework/packages/worker-sdk/tests/crypto-seam.test.ts', 'utf8').split(/\r?\n/);
console.log('--- 150..248 ---');
t.slice(149, 248).forEach(function (x, i) { console.log((150 + i) + ': ' + x); });