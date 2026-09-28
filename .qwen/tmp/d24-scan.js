const fs = require('fs');
const path = require('path');
const root = 'D:/Git/dugate/du-rework/businesses/document-core/';
function walk(d, out) {
  out = out || [];
  fs.readdirSync(d).forEach(function (e) {
    const p = path.join(d, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(path.relative(root, p).replace(/\\/g, '/'));
  });
  return out;
}
const files = walk(root + 'src').filter(function (f) { return /\.ts$/.test(f); });
console.log('=== src files (' + files.length + ') ===');
files.sort().forEach(function (f) {
  const st = fs.statSync(root + f);
  console.log('  ' + f + '  ' + st.size + 'B  ' + st.mtime.toISOString());
});
const tests = fs.readdirSync(root + 'tests').filter(function (f) { return /crypto|seam|checkpoint/i.test(f); });
console.log('=== crypto/seam/checkpoint tests ===');
tests.forEach(function (f) {
  const st = fs.statSync(root + 'tests/' + f);
  console.log('  ' + f + '  ' + st.size + 'B  ' + st.mtime.toISOString());
});