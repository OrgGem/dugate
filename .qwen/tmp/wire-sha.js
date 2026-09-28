const fs = require('fs');
const crypto = require('crypto');
const t = 'D:/Git/dugate/du-rework/businesses/document-core/';
['src/actions/ingest/index.ts','tests/ingest-wire.test.ts','tests/ingest.test.ts','tests/corpus-regression.test.ts','tests/all-variants-e2e.test.ts'].forEach(function (f) {
  const b = fs.readFileSync(t + f);
  console.log(f + '  sha=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + '  lines=' + b.toString('utf8').split(String.fromCharCode(10)).length);
});