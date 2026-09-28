
const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const T = 'D:/Git/dugate/.qwen/tmp/';
const parts = ['muc23-p1.md', 'muc23-p2.md', 'muc23-p3.md'].map(function (n) {
  return fs.readFileSync(T + n, 'utf8').replace(/\r\n/g, '\n');
});
const body = parts.join('');

let raw = fs.readFileSync(F, 'utf8');
if (/^## 23 . test_d3329e56f028/s.test(raw) || raw.indexOf('## 23 ') !== -1) {
  console.log('ALREADY_PRESENT — abort, not appending twice');
  process.exit(0);
}
if (raw[raw.length - 1] !== 10) raw = raw + '\n';
raw = raw + body;
fs.writeFileSync(F, raw, 'utf8');

// ledger row 23, inserted after the row-22 line
let L = raw.split('\n');
let idx = -1;
for (let i = 0; i < L.length; i++) {
  if (/^- 22 . /m.test(L[i]) || (/^- 22 /.test(L[i]))) { idx = i; break; }
}
if (idx === -1) { console.log('LEDGER_ROW22_NOT_FOUND'); process.exit(0); }
const row = '- 23 — W-DATA-03-ORCH-VERIFY: hai file test da ton tai (38/38 xanh san) nen cycle nao phai them THAT MOT LOP HANG: claim-boundary guard PENDING_INGESTION trong runtime.ts (dispatcher chi la routing, khong phai bien); 2 test claim-boundary (refuse + take NO lease / gate mo thi claim CUNG task do) + 5 cot lease + 4 nhanh router; targeted 42/42 x3 + x1 (Exit 0), consumer 35/35, M1 do dung muc tieu, restore byte-exact 902185d2; full suite 3 do ngoai lai (admin-shell, mtime shell-router 22:19Z > runtime 22:13Z, grep khong co claimTask); tsc 0; D54 write scope vuot 2 file test, D55 live-PG con mo (gop DATA-INT-01), D56 3 do admin-shell — Muc 23.';
if (L.some(function (x) { return /^- 23 /.test(x); })) {
  console.log('LEDGER_ROW23_ALREADY_PRESENT');
} else {
  L.splice(idx + 1, 0, row);
  fs.writeFileSync(F, L.join('\n'), 'utf8');
  console.log('LEDGER_ROW23_INSERTED_AFTER_LINE=' + (idx + 1));
}
const chk = fs.readFileSync(F, 'utf8');
const cl = chk.split('\n');
console.log('MUC23_IDX=' + cl.findIndex(function (x) { return /^## 23 /.test(x); }));
console.log('TOTAL_LINES=' + cl.length);
console.log('HAS_NEWLINE_AT_END=' + (chk[chk.length - 1] === 10));
let c = 0, l = 0;
for (let i = 0; i < chk.length; i++) if (chk.charCodeAt(i) === 10) { if (i > 0 && chk.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);
console.log('--- ledger 19..24 ---');
const li = cl.findIndex(function (x) { return /^## Ledger/.test(x); });
for (let i = li; i < li + 25; i++) if (/^- (19|20|21|22|23|24) /.test(cl[i] || '') || /^## Ledger/.test(cl[i] || '')) console.log((i+1) + ': ' + String(cl[i]).slice(0, 70));
