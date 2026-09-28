const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/services/orchestrator/src/modules/runtime/runtime.ts';
const pristine = fs.readFileSync('D:/Git/dugate/.qwen/tmp/runtime-d03v-pristine.ts');
fs.writeFileSync(p, pristine);
const after = fs.readFileSync(p);
console.log('RESTORED_SHA=' + crypto.createHash('sha256').update(after).digest('hex').slice(0,8) + ' (pristine 902185d2) bytes=' + after.length);
console.log('byte_identical=' + after.equals(pristine));