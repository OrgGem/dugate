const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/services/orchestrator/src/modules/runtime/metadata-crypto.ts';
const pristine = fs.readFileSync('D:/Git/dugate/.qwen/tmp/metadata-crypto-pristine.ts');
fs.writeFileSync(p, pristine);
const after = fs.readFileSync(p);
console.log('RESTORED_SHA=' + crypto.createHash('sha256').update(after).digest('hex').slice(0,8) + ' (baseline aa200211) bytes=' + after.length);
console.log('byte_identical=' + after.equals(pristine));
console.log('MUTATION_LEFT=' + (after.toString('utf8').indexOf('MUTATION-CONSTANT-AAD') >= 0));