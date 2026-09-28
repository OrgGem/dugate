const fs = require('fs');
const crypto = require('crypto');
const files = [
  ['D:/Git/dugate/du-rework/businesses/document-core/src/types/context.ts','doc-core types/context.ts'],
  ['D:/Git/dugate/du-rework/businesses/document-core/src/worker.ts','doc-core worker.ts'],
  ['D:/Git/dugate/du-rework/businesses/document-core/src/pipelines/step-checkpoint.ts','doc-core step-checkpoint.ts'],
  ['D:/Git/dugate/du-rework/businesses/document-core/tests/doc-core-crypto-seam.test.ts','doc-core test'],
  ['D:/Git/dugate/du-rework/packages/worker-sdk/src/task-context.ts','worker-sdk task-context.ts'],
];
files.forEach(function (e) {
  const b = fs.readFileSync(e[0]);
  console.log(e[1] + '  sha=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + '  lines=' + b.toString('utf8').split(String.fromCharCode(10)).length + '  bytes=' + b.length);
});