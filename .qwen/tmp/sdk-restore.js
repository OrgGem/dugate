const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/packages/worker-sdk/src/crypto-storage.ts';
const pristine = fs.readFileSync('D:/Git/dugate/.qwen/tmp/crypto-storage-pristine.ts');
fs.writeFileSync(p, pristine);
const after = fs.readFileSync(p);
console.log('RESTORED_SHA=' + crypto.createHash('sha256').update(after).digest('hex').slice(0,8) + ' (pristine cc7db569) bytes=' + after.length);
console.log('byte_identical=' + after.equals(pristine));
console.log('MUTATION_LEFT=' + (after.toString('utf8').indexOf('MUTATED-AAD') >= 0));