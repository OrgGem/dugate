const fs = require('fs');
for (let k = 0; k < 40; k++) {
  if (fs.existsSync('D:/Git/dugate/.qwen/tmp/d25-full.log')) {
    const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-full.log', 'utf8');
    if (/Test Suites:/.test(t)) {
      const L = t.split(/\r?\n/);
      L.forEach(function (x) { if (/Test Suites:|^\s*Tests:/.test(x)) console.log(x.trim()); });
      console.log('--- FAIL files ---');
      const seen = {};
      L.forEach(function (x) { if (/^FAIL /.test(x)) { const f = x.replace(/^FAIL /, '').split(' ')[0]; if (!seen[f]) { seen[f] = 1; console.log('  ' + f); } } });
      process.exit(0);
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}
console.log('TIMEOUT');