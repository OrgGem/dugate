const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/businesses/document-core/src/actions/ingest/index.ts';
const pristine = fs.readFileSync('D:/Git/dugate/.qwen/tmp/ingest-d03-pristine.ts');
fs.writeFileSync(p, pristine);
const after = fs.readFileSync(p);
console.log('RESTORED_SHA=' + crypto.createHash('sha256').update(after).digest('hex').slice(0,8) + ' (pristine f05634ea) bytes=' + after.length);
console.log('byte_identical=' + after.equals(pristine));