const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let s = fs.readFileSync(p, 'utf8');
const L = s.split(NL);
// ledger row 17 right after row 16
const i16 = L.findIndex(function (l) { return l.indexOf('- 16 ') === 0; });
if (i16 < 0) { console.log('ROW16_MISSING'); process.exit(2); }
const row17 = '- 17 — ENC-META-01: control-plane metadata crypto (metadata-crypto.ts 324d: AES-256-GCM + Vault Transit DEK + AAD bind tenant/slot/row) wire 9 call site trong runtime.ts; 23/23 x3 Exit 0, tsc 0, collateral 44/44, M1 do dung 4 binding test; Δ36 submit-side input_ref ngoai scope, Δ37 optional-param chua wiring, Δ38 contracts chua can, Δ39 outbox.payload de nguyen co y — Muc 17.';
if (L.indexOf(row17) < 0) L.splice(i16 + 1, 0, row17);
// RESUME POINT header bump
const rp = L.findIndex(function (l) { return l.indexOf('## RESUME POINT') === 0; });
if (rp >= 0) L[rp] = L[rp].replace(/cuối cycle 16/, 'cuối cycle 17');
fs.writeFileSync(p, L.join(NL), 'utf8');
const a = fs.readFileSync(p, 'utf8').split(NL);
const rows = a.filter(function (l) { return /^-\d+ —/.test(l); });
console.log('ledger_rows=' + rows.length + ' asc=' + (rows.every(function (l, i) { return l.indexOf('- ' + (i + 1) + ' ') === 0; })));
console.log('rp=' + a.find(function (l) { return l.indexOf('## RESUME POINT') === 0; }));
console.log('has_muc17=' + (a.join(NL).indexOf('## 17 — CYCLE 17') >= 0));