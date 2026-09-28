const fs = require('fs');
const p = 'D:/Git/dugate/.qwen/tmp/enc-full2.log';
const s = fs.readFileSync(p, 'utf8');
const L = s.split(String.fromCharCode(10));
console.log('log_lines=' + L.length);
L.forEach(function (l) {
  if (/^Tests:/.test(l) || /^Test Suites:/.test(l) || /^Snapshots:/.test(l)) console.log('SUMMARY ' + l);
});
const fails = L.filter(function (l) { return /^FAIL /.test(l); });
console.log('FAIL_COUNT=' + fails.length);
fails.forEach(function (l) { console.log('  ' + l); });
const skipped = L.filter(function (l) { return /SKIP|SKIP-QUALIFIED/.test(l); }).length;
console.log('skip_markers=' + skipped);