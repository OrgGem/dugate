const fs = require('fs');
const p = 'D:/Git/dugate/.qwen/tmp/enc-test-p1.txt';
let s = fs.readFileSync(p, 'utf8');
const bad = ' + # + ';
const good = ' + HASH + ';
const n = s.split(bad).length - 1;
s = s.split(bad).join(good);
if (s.indexOf('const HASH') < 0) {
  s = s.replace(
    'function keystream',
    "const HASH = String.fromCharCode(35);\n\nfunction keystream"
  );
}
fs.writeFileSync(p, s, 'utf8');
console.log('replaced=' + n + ' hash_decl=' + (s.indexOf('const HASH') >= 0));
console.log(s.split(String.fromCharCode(10)).filter(function(l){ return l.indexOf('HASH') >= 0; }).join(' | '));