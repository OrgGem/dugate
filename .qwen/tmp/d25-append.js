const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const T = 'D:/Git/dugate/.qwen/tmp/';
const body = ['muc25-p1.md', 'muc25-p2.md']
  .map(function (n) { return fs.readFileSync(T + n, 'utf8').replace(/\r\n/g, '\n'); })
  .join('');
let raw = fs.readFileSync(F, 'utf8');
if (raw.indexOf('## 25 ') !== -1) { console.log('ALREADY_PRESENT'); process.exit(0); }
raw = raw.replace(/\n+$/, '\n') + body;
raw = raw.replace(/\n+$/, '\n');
fs.writeFileSync(F, raw, 'utf8');
let L = raw.split('\n');
let idx = -1;
for (let i = 0; i < L.length; i++) { if (/^- 24 /.test(L[i])) { idx = i; break; } }
const row = '- 25 — W-ENC-04-GRANT-SCHEMA: D57 muc 1 XONG. PACKET SAI TEN FILE: ArtifactAccessGrantSchema o runtime.ts:226, KHONG o operations.ts (grep 0 match) — operations.ts chua recipient-delivery envelope, khac storage envelope. StorageWrappedDekSchema + StorageEnvelopeRefSchema (mirror field-for-field EncryptedStorageObject, KHONG tai dung WrappedDekEnvelopeSchema vi 2 hinh DEK khac ten field: runtime vault-transit-provider.ts:42 = keyRef/keyVersion/ciphertext) + grant.encryption optional; 13 test moi; M1 opt-in 1 do, M2 byte-length 3 do (ca 2 don bien, restore byte-exact 71c0458e/395e0880); FULL contracts 23/23 462/462 Exit 0 (12 TS loi ngoai lai cua lane Cost da tu het), tsc contracts+orchestrator+worker-sdk 0; D60 hai hinh DEK cho quyet, D57 con muc 2-3, D44 chua dung; D59 DONG theo phan coordinator (KHONG rang buoc epoch vao AAD) — Muc 25.';
if (L.some(function (x) { return /^- 25 /.test(x); })) console.log('LEDGE25_EXISTS');
else { L.splice(idx + 1, 0, row); fs.writeFileSync(F, L.join('\n'), 'utf8'); console.log('LEDGER25_AFTER=' + (idx + 1)); }
const chk = fs.readFileSync(F, 'utf8');
const cl = chk.split('\n');
console.log('MUC25_IDX=' + (cl.findIndex(function (x) { return /^## 25 /.test(x); }) + 1));
console.log('TOTAL=' + cl.length);
console.log('singleLF=' + (chk.charCodeAt(chk.length-1) === 10 && chk.charCodeAt(chk.length-2) !== 10));
let c = 0, l = 0;
for (let i = 0; i < chk.length; i++) if (chk.charCodeAt(i) === 10) { if (i > 0 && chk.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);