const fs = require('fs');
const NL = String.fromCharCode(10);
const R = 'D:/Git/dugate/du-rework/';
function show(label, path, pattern) {
  try {
    const s = fs.readFileSync(path, 'utf8');
    const hits = s.split(NL).filter(function (l) { return l.indexOf(pattern) >= 0; });
    console.log(label + ' -> ' + hits.length + ' line(s)');
    hits.slice(0, 3).forEach(function (l) { console.log('    ' + l.trim().slice(0, 90)); });
  } catch (e) {
    console.log(label + ' -> ERROR ' + e.message.slice(0, 60));
  }
}
console.log('--- claim 1: facade location + size ---');
show('facade exists', R + 'services/orchestrator/src/modules/encryption/crypto-storage-facade.ts', 'export class CryptoStorageFacade');
show('facade inside worker-sdk?', R + 'packages/worker-sdk/src/crypto', 'CryptoStorageFacade');
console.log('--- claim 2: worker-sdk cannot import orchestrator ---');
show('worker-sdk pkg deps', R + 'packages/worker-sdk/package.json', '"@du/');
show('worker-sdk tsconfig include', R + 'packages/worker-sdk/tsconfig.json', 'include');
console.log('--- claim 3: no key field on claim ---');
show('ClaimResult key fields', R + 'packages/contracts/src/runtime.ts', 'dek');
show('runtime.ts key-ish', R + 'packages/contracts/src/runtime.ts', 'KeyRef');
console.log('--- claim 4: packet path wrong ---');
console.log('packages/document-core exists = ' + fs.existsSync(R + 'packages/document-core'));
console.log('businesses/document-core exists = ' + fs.existsSync(R + 'businesses/document-core'));