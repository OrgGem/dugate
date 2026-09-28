const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/services/orchestrator/src/modules/runtime/metadata-crypto.ts';
const b = fs.readFileSync(p);
console.log('BASELINE_SHA=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + ' bytes=' + b.length);
fs.writeFileSync('D:/Git/dugate/.qwen/tmp/metadata-crypto-pristine.ts', b);
console.log('backup written');