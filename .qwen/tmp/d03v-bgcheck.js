const fs = require('fs');
const L = 'D:/Git/dugate/.qwen/tmp/d03v-full-now.log';
const t = fs.readFileSync(L, 'utf8');
const A = t.split(/\r?\n/);
console.log('log bytes=' + t.length + ' lines=' + A.length);
console.log('has_summary=' + /Test Suites:/.test(t));
A.forEach(function (x, i) { if (/Test Suites:|^\s*Tests:|^Time:/.test(x)) console.log('SUM ' + (i+1) + ': ' + x.trim()); });
console.log('--- last 4 lines ---');
A.slice(-4).forEach(function (x, i) { console.log((A.length - 4 + i + 1) + ': ' + x.slice(0, 150)); });
console.log('crash_markers=' + (/Cannot find module|out of memory|heap out of memory|ELIFECYCLE|ENOENT/.test(t) ? 'YES' : 'none'));
const B = 'C:/Users/Gem/.qwen/tmp/1d2d01b7c79aa1d9f0c41e8b809dbd2431915c60c88b4a7722fb08b6b19bdfa7/background-shells/ebd83de0-b356-447b-9f28-9ab8750e9499/shell-bg_094b0ff9.output';
if (fs.existsSync(B)) {
  const b = fs.readFileSync(B, 'utf8');
  console.log('--- bg output file bytes=' + b.length + ' ---');
  b.split(/\r?\n/).slice(-6).forEach(function (x) { console.log('BG: ' + x.slice(0, 150)); });
} else { console.log('BG_OUTPUT_MISSING'); }