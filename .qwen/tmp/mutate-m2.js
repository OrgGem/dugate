const fs=require('fs');const crypto=require('crypto');
const p='D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts';
let s=fs.readFileSync(p,'utf8');
const good="const traversal = { ...REASON, kind: 'vault-kv2', path: '../etc', version: 1 };";
const mut="const traversal = { ...REASON, kind: 'vault-kv2', path: REASON.path, version: 1 };";
if (s.indexOf(good)<0) { console.log('ANCHOR_MISS'); process.exit(2); }
fs.writeFileSync(p, s.replace(good, mut), 'utf8');
console.log('M2_APPLIED sha=' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,8));