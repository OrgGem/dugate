const fs = require('fs');
const root = 'D:/Git/dugate/du-rework/packages/contracts/';
console.log('=== tests ===');
fs.readdirSync(root + 'tests').forEach(function (f) {
  const st = fs.statSync(root + 'tests/' + f);
  console.log('  ' + f + '  ' + st.size + 'B  ' + st.mtime.toISOString());
});
console.log('=== index.ts ===');
console.log(fs.readFileSync(root + 'src/index.ts', 'utf8'));