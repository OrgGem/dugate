const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const i19 = L.findIndex(function (l) { return l.slice(0, 5) === '- 19 '; });
if (i19 < 0) { console.log('ROW19_MISS'); process.exit(2); }
const row20 = '- 20 — W-ENC-04-DOC-CORE: document-core ctx.crypto optional + StepCheckpointManager seal/mo trong suot + assertEncryptionAvailable fail-closed truoc step body + 9 test; FULL document-core 44/44 suite 529/529 test Exit 0 (43/520 + 1/9 khop), 9/9 x3, tsc 0; SUA LOI THAT: adapter feature-detect cryptoFor (method ton tai ca khi tat encryption) lam 3 suite do — them cryptoSeam() predicate; M2 base64-leak test van xanh -> them leaksSentinel() decode moi string; D44 D45 D47 van mo — chua deployment nao bat seam — Muc 20.';
if (L.indexOf(row20) < 0) L.splice(i19 + 1, 0, row20);
const rp = L.findIndex(function (l) { return l.indexOf('## RESUME POINT') === 0; });
if (rp >= 0) L[rp] = L[rp].replace(/cuối cycle 19, 2026-09-28/, 'cuối cycle 20, 2026-09-28');
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