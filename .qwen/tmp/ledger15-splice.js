const fs = require('fs');
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const NL = String.fromCharCode(10);
let s = fs.readFileSync(p, 'utf8');
let L = s.split(NL);

// 1. Insert ledger row 15 after row 14
const row14idx = L.findIndex(l => l.startsWith('- 14 '));
if (row14idx === -1) { console.log('ERROR: row 14 not found'); process.exit(1); }
const row15 = '- 15 — W-VAULT-06-DELTA32: f3 test 377-383 vacuous (400 tu binding guard, chua cham path rule) -> rewrite voi positive control + M2 mutation do dung cau (Expected 400 / Received 201); 8/8 x3 Exit 0; full offline 74/74; f3 SHA 8e7e8aa9/427; W-ENC-01-SCHEMA BLOCKED (ADR-18 chua freeze, packet khong ton tai) — Muc 15.';
L.splice(row14idx + 1, 0, row15);

// 2. Update RESUME POINT header from cycle 14 to cycle 15
const rpIdx = L.findIndex(l => l.includes('## RESUME POINT (cu'));
if (rpIdx >= 0) {
  L[rpIdx] = L[rpIdx].replace(/cuối cycle 14/, 'cuối cycle 15');
}

// 3. Write back
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('DONE lines=' + L.length);

// 4. Verify
const v = fs.readFileSync(p, 'utf8');
const VL = v.split(NL);
const ledger = VL.filter(l => /^- \d+ /.test(l));
console.log('LEDGER_COUNT=' + ledger.length);
console.log('LAST_ROW=' + ledger[ledger.length - 1].slice(0, 80));
console.log('has_Muc15=' + (v.indexOf('## 15') >= 0));
console.log('has_ENC_blocked=' + (v.indexOf('W-ENC-01-SCHEMA') >= 0));
console.log('has_Delta32_closed=' + (v.indexOf('DELTA32') >= 0));