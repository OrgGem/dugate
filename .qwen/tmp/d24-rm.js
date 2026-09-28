const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/du-rework/packages/worker-sdk/tests/artifact-read-metadata.test.ts', 'utf8').split(/\r?\n/);
console.log('--- 1..145 ---');
t.slice(0, 145).forEach(function (x, i) { console.log((i + 1) + ': ' + x); });