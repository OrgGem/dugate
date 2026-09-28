const fs = require('fs');
const SRC = 'D:/Git/dugate/du-rework/packages/contracts/src/encryption.ts';
fs.writeFileSync(SRC, fs.readFileSync('D:/Git/dugate/.qwen/tmp/bak-encryption.ts'));
const RT = 'D:/Git/dugate/du-rework/packages/contracts/src/runtime.ts';
const rt = fs.readFileSync(RT, 'utf8');
const m = rt.replace('encryption: StorageEnvelopeRefSchema.optional(),', 'encryption: StorageEnvelopeRefSchema,');
if (m === rt) { console.log('M1_ANCHOR_MISS'); process.exit(1); }
fs.writeFileSync(RT, m, 'utf8');
console.log('M1 applied (encryption now REQUIRED)');
console.log('enc_restored_sha_check bytes=' + fs.readFileSync(SRC).length);