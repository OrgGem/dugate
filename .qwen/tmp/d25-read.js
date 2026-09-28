const fs = require('fs');
const p = 'D:/Git/dugate/.qwen/tmp/d25-base.log';
if (!fs.existsSync(p)) { console.log('MISSING'); process.exit(0); }
const t = fs.readFileSync(p, 'utf8');
console.log('DONE=' + /Test Suites:/.test(t) + ' bytes=' + t.length);
t.split(/\r?\n/).forEach(function (x) { if (/Test Suites:|^\s*Tests:/.test(x)) console.log(x.trim()); });