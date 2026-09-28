const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const i20 = L.findIndex(function (l) { return l.slice(0, 5) === '- 20 '; });
if (i20 < 0) { console.log('ROW20_MISS'); process.exit(2); }
const row21 = '- 21 — W-INGEST-WIRE-01: ingest/ocr + ingest/digitize truyen TAI LIEU qua artifact reference da freeze (InvocationInput.artifacts) — bo hasBuffer boolean, them guard INGESTION_SOURCE_UNRESOLVED, prepareSources tra artifactIds that; sua 3 test cu chung minh sai (placeholder text) + 1 test moi voi PNG that; FULL document-core 45/45 suite 537/537 test Exit 0, tsc 0, 2 mutation probe dung tung nhanh + restore byte-exact; D48 connector-side fetch chua chung minh, D49 live multi-container con mo, D50 sua 3 test traceability can Reviewer — Muc 21.';
if (L.indexOf(row21) < 0) L.splice(i20 + 1, 0, row21);
const rp = L.findIndex(function (l) { return l.indexOf('## RESUME POINT') === 0; });
if (rp >= 0) L[rp] = L[rp].replace(/cuối cycle 20, 2026-09-28/, 'cuối cycle 21, 2026-09-28');
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