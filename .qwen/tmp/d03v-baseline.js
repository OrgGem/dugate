const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/services/orchestrator/src/modules/runtime/runtime.ts';
const b = fs.readFileSync(p);
console.log('PRISTINE_SHA=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + ' bytes=' + b.length);
fs.writeFileSync('D:/Git/dugate/.qwen/tmp/runtime-d03v-pristine.ts', b);