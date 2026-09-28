const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/packages/worker-sdk/src/crypto-seam.ts';
let s = fs.readFileSync(p, 'utf8');
const before = s;
// 1. import createHash
s = s.replace(
  "import type { Readable } from 'node:stream';",
  "import { createHash } from 'node:crypto';" + NL + "import type { Readable } from 'node:stream';"
);
// 2. report the CIPHERTEXT digest, not the plaintext digest
s = s.split('        // eslint-disable-next-line @typescript-eslint/no-require-imports' + NL + '        ciphertextSha256: encrypted.plaintextSha256,')
  .join('        ciphertextSha256: createHash(SHA256_ALGO).update(encrypted.ciphertext).digest(HASH_HEX),');
// 3. named constants next to the other module constants
s = s.replace(
  '/** The single-shot ceiling, re-exported so callers size their fixtures. */',
  'const SHA256_ALGO = ' + String.fromCharCode(39) + 'sha256' + String.fromCharCode(39) + ';' + NL + "const HASH_HEX = 'hex';" + NL + NL + '/** The single-shot ceiling, re-exported so callers size their fixtures. */',
);
fs.writeFileSync(p, s, 'utf8');
console.log('changed=' + (s !== before));
console.log('plaintext_sha_left=' + (s.indexOf('ciphertextSha256: encrypted.plaintextSha256') >= 0));
console.log('has_createHash=' + (s.indexOf('import { createHash }') >= 0));