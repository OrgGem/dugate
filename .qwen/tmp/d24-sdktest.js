const fs = require('fs');
const path = require('path');
const root = 'D:/Git/dugate/du-rework/packages/worker-sdk/';
const t = fs.readFileSync(root + 'tests/crypto-seam.test.ts', 'utf8').split(/\r?\n/);
console.log('crypto-seam.test.ts lines=' + t.length);
console.log('--- first 60 ---');
t.slice(0, 60).forEach(function (x, i) { console.log((i + 1) + ': ' + x); });