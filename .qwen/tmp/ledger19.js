const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const i18 = L.findIndex(function (l) { return l.slice(0, 5) === '- 18 '; });
if (i18 < 0) { console.log('ROW18_MISS'); process.exit(2); }
const row19 = '- 19 — W-ENC-04-SEAM: worker crypto seam — port trung thuc crypto-storage-facade (910d, cc7db569) + crypto-seam.ts (158d) binding tenant cua CLAIM + TaskContextDeps.crypto optional + single-PUT seal truoc khi bytes roi process (finalize nhan size/digest CIPHERTEXT) + 14 test; 14/14 x3 Exit 0, tsc 0, M1 do dung 2 test port-fidelity (12 test hanh vi KHONG bat duoc doi AAD) roi restore byte-exact; full 307/310, 3 do ngoai lai da chung minh doc lap; Δ43 khong lam dep port, Δ44 manifest chua co duong di, Δ45 chua co caller truyen crypto, Δ46 document-core ngoai scope — Muc 19.';
if (L.indexOf(row19) < 0) L.splice(i18 + 1, 0, row19);
const rp = L.findIndex(function (l) { return l.indexOf('## RESUME POINT') === 0; });
if (rp >= 0) L[rp] = L[rp].replace(/cuối cycle 18, 2026-09-28/, 'cuối cycle 19, 2026-09-28');
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