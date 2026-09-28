const fs = require('fs');
const crypto = require('crypto');
const t = 'D:/Git/dugate/du-rework/packages/worker-sdk/';
['src/crypto-storage.ts','src/crypto-seam.ts','tests/crypto-seam.test.ts','src/task-context.ts','src/index.ts'].forEach(function (f) {
  const b = fs.readFileSync(t + f);
  console.log(f + '  sha=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + '  lines=' + b.toString('utf8').split(String.fromCharCode(10)).length + '  bytes=' + b.length);
});