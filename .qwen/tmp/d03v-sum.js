const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d03v-full-now.log', 'utf8');
const L = t.split(/\r?\n/);
console.log('LINES=' + L.length + '  hasSummary=' + /Test Suites:/.test(t));
L.forEach(function (x, i) { if (/Test Suites:|^\s*Tests:/.test(x)) console.log('SUM ' + (i+1) + ': ' + x.trim()); });
const pass = (t.match(/^PASS /gm) || []).length;
const fail = (t.match(/^FAIL /gm) || []).length;
console.log('PASS_lines=' + pass + '  FAIL_lines=' + fail);