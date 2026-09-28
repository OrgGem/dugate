const fs = require('fs');
const root = 'D:/Git/dugate/du-rework/packages/contracts/';
console.log('=== PASS suites ===');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-base.log', 'utf8');
t.split(/\r?\n/).forEach(function (x) { if (/^PASS /.test(x)) console.log('  ' + x.slice(5, 90)); });
console.log('=== mtimes of files in the TS errors ===');
['src/usage-reconciliation.ts', 'src/usage-budget.ts', 'src/usage-metrics.ts', 'src/pricing.ts', 'src/encryption.ts', 'src/runtime.ts', 'src/index.ts'].forEach(function (f) {
  try { const st = fs.statSync(root + f); console.log('  ' + f + '  ' + st.mtime.toISOString()); }
  catch (e) { console.log('  ' + f + '  MISSING'); }
});
console.log('=== all distinct TS error files ===');
const m = t.match(/src\/[a-z-]+\.ts:\d+:\d+ - error TS\d+/g) || [];
console.log([...new Set(m.map(function (x) { return x.split(':')[0]; }))].join('\n'));