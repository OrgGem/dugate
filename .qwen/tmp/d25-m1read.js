const fs = require('fs');
for (let k = 0; k < 30; k++) {
  if (fs.existsSync('D:/Git/dugate/.qwen/tmp/d25-m1.log')) {
    const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-m1.log', 'utf8');
    if (/Tests:/.test(t)) {
      t.split(/\r?\n/).forEach(function (x) { if (/Tests:|×/.test(x)) console.log(x.slice(0, 125)); });
      process.exit(0);
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}
console.log('TIMEOUT waiting for M1 log');