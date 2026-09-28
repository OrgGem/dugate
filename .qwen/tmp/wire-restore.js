const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/businesses/document-core/src/actions/ingest/index.ts';
fs.writeFileSync(p, fs.readFileSync('D:/Git/dugate/.qwen/tmp/ingest-pristine.ts'));
const b = fs.readFileSync(p);
console.log('RESTORED=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + ' (pristine 8b43ce2c)');