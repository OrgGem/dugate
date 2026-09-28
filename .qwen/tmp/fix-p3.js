const fs = require('fs');
const p = 'D:/Git/dugate/.qwen/tmp/enc-test-p3.txt';
let s = fs.readFileSync(p, 'utf8');
s = s.split("createMetadataCrypto(makeProvider(), '')").join("createMetadataCrypto(makeProvider().provider, '')");
fs.writeFileSync(p, s, 'utf8');
console.log('fixed=' + (s.indexOf('makeProvider().provider') >= 0));