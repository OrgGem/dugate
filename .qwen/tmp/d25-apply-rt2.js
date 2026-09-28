const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/packages/contracts/src/runtime.ts';
let t = fs.readFileSync(F, 'utf8');
if (t.indexOf('encryption: StorageEnvelopeRefSchema') !== -1) { console.log('FIELD_ALREADY_PRESENT'); process.exit(0); }
const snippet = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-rt-add.ts', 'utf8')
  .replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').join('\r\n');
const OLD = '  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),\r\n});\r\nexport type ArtifactAccessGrant = z.infer<typeof ArtifactAccessGrantSchema>;';
const NEW = snippet + '\r\nexport type ArtifactAccessGrant = z.infer<typeof ArtifactAccessGrantSchema>;';
if (t.indexOf(OLD) === -1) { console.log('ANCHOR_MISS'); process.exit(1); }
t = t.replace(OLD, NEW);
const IMP_OLD = "import { OperationStateSchema, TaskStateSchema } from './operations';";
const IMP_NEW = IMP_OLD + "\r\nimport { StorageEnvelopeRefSchema } from './encryption';";
if (t.indexOf(IMP_OLD) === -1) { console.log('IMPORT_ANCHOR_MISS'); process.exit(1); }
t = t.replace(IMP_OLD, IMP_NEW);
fs.writeFileSync(F, t, 'utf8');
const chk = fs.readFileSync(F, 'utf8');
console.log('PATCHED');
console.log('has_field=' + (chk.indexOf('encryption: StorageEnvelopeRefSchema') !== -1));
console.log('has_import=' + (chk.indexOf("from './encryption'") !== -1));
let c = 0, l = 0;
for (let i = 0; i < chk.length; i++) if (chk.charCodeAt(i) === 10) { if (i > 0 && chk.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l + '  (crlf must be 452+, lf must be 0)');
console.log('singleLF_end=' + (chk.charCodeAt(chk.length-1) === 13 && chk.charCodeAt(chk.length-2) === 10));