const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const L = fs.readFileSync(p, 'utf8').split(NL);
const stale = L.filter(function (l) { return l.indexOf('385/385 x3') >= 0; });
console.log('stale_matches=' + stale.length);
stale.forEach(function (l) { console.log('  ' + l.slice(0, 70)); });
if (stale.length === 1) {
  const i = L.indexOf(stale[0]);
  L.splice(i, 1);
  fs.writeFileSync(p, L.join(NL), 'utf8');
  console.log('removed stale row at ' + (i + 1));
}