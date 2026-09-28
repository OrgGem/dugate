const fs = require('fs');
const NL = String.fromCharCode(10);
const src = 'D:/Git/dugate/.qwen/tmp/seam-test-p1.txt';
const dst = 'D:/Git/dugate/packages/../du-rework/packages/worker-sdk/tests/crypto-seam.test.ts';
const out = fs.readFileSync(src, 'utf8');
fs.writeFileSync(dst, out, 'utf8');
console.log('WROTE lines=' + out.split(NL).length + ' bytes=' + Buffer.byteLength(out));
console.log('bad_crypto_import=' + (out.indexOf("readFileSync } from 'node:crypto'") >= 0));