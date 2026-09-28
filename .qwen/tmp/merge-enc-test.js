const fs = require('fs');
const NL = String.fromCharCode(10);
const T = 'D:/Git/dugate/.qwen/tmp/';
const out = ['enc-test-p1.txt','enc-test-p2.txt','enc-test-p3.txt'].map(f => fs.readFileSync(T+f,'utf8')).join(NL);
fs.writeFileSync('D:/Git/dugate/du-rework/services/orchestrator/tests/runtime-encryption-metadata.test.ts', out, 'utf8');
console.log('merged lines=' + out.split(NL).length);