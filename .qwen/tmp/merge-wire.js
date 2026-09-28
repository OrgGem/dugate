const fs = require('fs');
const NL = String.fromCharCode(10);
const T = 'D:/Git/dugate/.qwen/tmp/';
const out = fs.readFileSync(T + 'wire-p1.txt', 'utf8') + fs.readFileSync(T + 'wire-p2.txt', 'utf8');
fs.writeFileSync('D:/Git/dugate/du-rework/businesses/document-core/tests/ingest-wire.test.ts', out, 'utf8');
console.log('WROTE lines=' + out.split(NL).length);