const fs = require('fs');
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const NL = String.fromCharCode(10);
let s = fs.readFileSync(p, 'utf8');
let L = s.split(NL);

// 1. Append ledger row 16 after row 15
const row15idx = L.findIndex(l => l.startsWith('- 15 '));
if (row15idx === -1) { console.log('ERROR: row 15 not found'); process.exit(1); }
const row16 = '- 16 — W-ENC-01-SCHEMA: envelope encryption schemas (7 schemas + 2 constants) + 46 tests trong packages/contracts; 20 suites / 412 tests Exit 0; tsc Exit 0; Δ36-Δ39 — Muc 16.';
L.splice(row15idx + 1, 0, row16);

// 2. Update RESUME POINT header
const rpIdx = L.findIndex(l => l.includes('## RESUME POINT'));
if (rpIdx >= 0) {
  L[rpIdx] = L[rpIdx].replace(/cuối cycle 15/, 'cuối cycle 16');
}

// 3. Write
fs.writeFileSync(p, L.join(NL), 'utf8');
console.log('DONE lines=' + L.length);

// 4. Verify
const v = fs.readFileSync(p, 'utf8');
const strict = v.split(NL).filter(l => /^- \d+ \u2014/.test(l));
console.log('STRICT_LEDGER=' + strict.length);
console.log('LAST=' + strict[strict.length - 1].slice(0, 80));
const rp = v.split(NL).find(l => l.includes('## RESUME POINT'));
console.log('RP=' + (rp || 'NOT_FOUND'));