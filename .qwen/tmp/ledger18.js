const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const i17 = L.findIndex(function (l) { return l.slice(0, 5) === '- 17 '; });
if (i17 < 0) { console.log('ROW17_MISS'); process.exit(2); }
const row18 = '- 18 — W-ENC-04-WORKER-SDK: BLOCKED, KHONG code (operator chon thu hoi). 4 luong do: facade ENC-03 nam o services/orchestrator (ngoai scope); worker-sdk khong phu thuoc orchestrator + tsconfig rootDir=src nen import cheo bat kha thi (3 noi nhan services/orchestrator chi la comment); ClaimResultSchema khong mang field key nao nen worker chua co duong nhan DEK; packages/document-core khong ton tai (that la businesses/document-core). Can (a) chon cho cua facade, (b) chot co che DEK delivery, (c) sua duong dan packet truoc khi dispatch lai — Muc 18.';
if (L.indexOf(row18) < 0) L.splice(i17 + 1, 0, row18);
const rp = L.findIndex(function (l) { return l.indexOf('## RESUME POINT') === 0; });
if (rp >= 0) L[rp] = L[rp].replace(/cuối cycle 17/, 'cuối cycle 18');
fs.writeFileSync(p, L.join(NL), 'utf8');
const a = fs.readFileSync(p, 'utf8').split(NL);
const start = a.findIndex(function (l) { return l.trim() === '## Ledger'; });
const rows = [];
for (let i = start + 1; i < a.length; i += 1) {
  const l = a[i];
  if (l.slice(0, 2) === '- ' && l.charAt(2) >= '0' && l.charAt(2) <= '9') rows.push(parseInt(l.slice(2), 10));
  else if (l.slice(0, 2) === '##') break;
}
console.log('LEDGER=' + rows.length + ' seq=' + rows.every(function (n, i) { return n === i + 1; }));
console.log('rp=' + a.find(function (l) { return l.indexOf('## RESUME POINT') === 0; }));