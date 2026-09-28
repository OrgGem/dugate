const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const start = L.findIndex(function (l) { return l.trim() === '## Ledger'; });
console.log('LEDGER_AT=' + (start + 1));
const rows = [];
for (let i = start + 1; i < L.length; i += 1) {
  const l = L[i];
  if (l.slice(0, 2) === '- ' && l.charAt(2) >= '0' && l.charAt(2) <= '9') rows.push(l);
  else if (l.slice(0, 2) === '##') break;
}
console.log('LEDGER_ROWS=' + rows.length);
const nums = rows.map(function (l) { return parseInt(l.slice(2), 10); });
console.log('NUMS=' + nums.join(','));
const ok = nums.every(function (n, i) { return n === i + 1; });
console.log('SEQUENTIAL_1_TO_N=' + ok);
console.log('LAST=' + rows[rows.length - 1].slice(0, 80));