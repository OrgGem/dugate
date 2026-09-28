const fs = require('fs');
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const NL = String.fromCharCode(10);
let s = fs.readFileSync(p, 'utf8');
let L = s.split(NL);

// Find ALL lines starting with '- 15 '
const idx15 = [];
L.forEach((l, i) => { if (l.startsWith('- 15 ')) idx15.push(i); });
console.log('ROW15_COUNT=' + idx15.length);
idx15.forEach(i => console.log('  line ' + (i+1) + ': ' + L[i].slice(0, 120)));

// If duplicate, remove the SECOND one (keep first)
if (idx15.length > 1) {
  L.splice(idx15[1], 1);
  fs.writeFileSync(p, L.join(NL), 'utf8');
  console.log('REMOVED duplicate at line ' + (idx15[1]+1));
} else {
  console.log('NO duplicate found');
}

// Also check for any line containing 'W-VAULT-06-DELTA32' that is NOT a ledger row
const v2 = fs.readFileSync(p, 'utf8');
const VL2 = v2.split(NL);
const strict = VL2.filter(l => /^- \d+ \u2014/.test(l));
console.log('STRICT_LEDGER_COUNT=' + strict.length);
strict.forEach((l, i) => console.log('  ' + (i+1) + ': ' + l.slice(0, 90)));

// Verify RESUME POINT header
const rp = VL2.find(l => l.includes('## RESUME POINT'));
console.log('RP_HEADER=' + (rp || 'NOT FOUND'));