const fs = require('fs');
const e = fs.readFileSync('D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts', 'utf8');
const L = e.split('\n');
const i = L.findIndex(function (x) { return x.indexOf('StorageWrappedDekSchema,') !== -1; });
console.log('--- envelope schema tail ---');
for (let k = i; k < i + 12; k++) console.log('  ' + (k + 1) + ': ' + String(L[k]).slice(0, 92));