const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const T = 'D:/Git/dugate/.qwen/tmp/';
const body = ['muc24-p1.md', 'muc24-p2.md']
  .map(function (n) { return fs.readFileSync(T + n, 'utf8').replace(/\r\n/g, '\n'); })
  .join('');
let raw = fs.readFileSync(F, 'utf8');
if (raw.indexOf('## 24 ') !== -1) { console.log('ALREADY_PRESENT'); process.exit(0); }
raw = raw.replace(/\n+$/, '\n') + body;
raw = raw.replace(/\n+$/, '\n');
fs.writeFileSync(F, raw, 'utf8');

let L = raw.split('\n');
let idx = -1;
for (let i = 0; i < L.length; i++) { if (/^- 23 /.test(L[i])) { idx = i; break; } }
const row = '- 24 — W-ENC-04-DOC-CORE: BLOCKED, KHONG sua code san pham. (a) encrypted input stream KHONG the dat o document-core: worker-sdk write path seal roi upload CHI ciphertext, bo nonce/tag/aad/DEK (0 lan xuat hien), read path khong co decrypt -> bang chung that read() tra CIPHERTEXT (proof 1/1 PASS, silent data-loss); fix can sua worker-sdk + contracts + orchestrator = ngoai scope. (b) checkpoint lease: adapter khong mang leaseEpoch/leaseExpiresAt (0 match), khong co gi de validate. (c) da co tu cycle 20. doc-core 46/46 542/542 Exit 0, worker-sdk 19/19 312/312 Exit 0, tsc 0 ca 2; D57 BLOCKER, D58 khong bat seam, D59 cau hoi thiet ke AAD epoch — Muc 24.';
if (L.some(function (x) { return /^- 24 /.test(x); })) { console.log('LEDGE24_EXISTS'); }
else { L.splice(idx + 1, 0, row); fs.writeFileSync(F, L.join('\n'), 'utf8'); console.log('LEDGER24_AFTER=' + (idx + 1)); }
const chk = fs.readFileSync(F, 'utf8');
const cl = chk.split('\n');
console.log('MUC24_IDX=' + (cl.findIndex(function (x) { return /^## 24 /.test(x); }) + 1));
console.log('TOTAL=' + cl.length);
console.log('singleLF=' + (chk.charCodeAt(chk.length - 1) === 10 && chk.charCodeAt(chk.length - 2) !== 10));
let c = 0, l = 0;
for (let i = 0; i < chk.length; i++) if (chk.charCodeAt(i) === 10) { if (i > 0 && chk.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);