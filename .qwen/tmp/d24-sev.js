const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/du-rework/packages/worker-sdk/src/task-context.ts', 'utf8');
const i = t.indexOf('private async sealArtifactBytes');
const seg = t.slice(i, i + 1600);
console.log('--- what sealArtifactBytes RETURNS (the metadata a reader needs) ---');
console.log(seg.slice(seg.indexOf('const sealed = await crypto.seal'), seg.indexOf('const sealed = await crypto.seal') + 260));
console.log('');
console.log('--- does anything persist nonce/tag/aad/dek? ---');
['nonce','tag','aad','dek','EncryptedStorageObject'].forEach(function (k) {
  const n = (t.match(new RegExp(k, 'g')) || []).length;
  console.log('  task-context.ts occurrences of ' + k + ': ' + n);
});