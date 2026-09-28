const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/businesses/document-core/src/pipelines/step-checkpoint.ts';
const pristine = fs.readFileSync('D:/Git/dugate/.qwen/tmp/dc-ckpt-pristine.ts');
fs.writeFileSync(p, pristine);
const after = fs.readFileSync(p);
console.log('RESTORED_SHA=' + crypto.createHash('sha256').update(after).digest('hex').slice(0,8) + ' (pristine a7c52ff1) bytes=' + after.length);
console.log('byte_identical=' + after.equals(pristine) + ' leak_left=' + (after.toString('utf8').indexOf('leak:') >= 0));