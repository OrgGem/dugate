const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const i21 = L.findIndex(function (l) { return l.slice(0, 5) === '- 21 '; });
if (i21 < 0) { console.log('ROW21_MISS'); process.exit(2); }
const row22 = '- 22 — W-DATA-03-URL-ACQ: URL task chi chay duoc khi source READY — pin check chay BAT KI co pin (tru loi duong vong pin+inline text parse duoc text chua fetch), drop inlineText khi co pin; 1 test moi 5 case + 2 mutation probe dung muc tieu; FULL document-core 46/46 542/542 Exit 0, tsc 0, worker-sdk regression 84/84; D52 tighten co the lam task URL cu fail, D53 live multi-container con mo — Muc 22.';
if (L.indexOf(row22) < 0) L.splice(i21 + 1, 0, row22);
const rp = L.findIndex(function (l) { return l.indexOf('## RESUME POINT') === 0; });
if (rp >= 0) L[rp] = L[rp].replace(/cuối cycle 21, 2026-09-28/, 'cuối cycle 22, 2026-09-28');
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