const fs = require('fs');
const root = 'D:/Git/dugate/du-rework/packages/worker-sdk/src/';
const files = fs.readdirSync(root).filter(function (f) { return /\.ts$/.test(f); });
console.log('=== worker-sdk src ===');
files.sort().forEach(function (f) {
  const st = fs.statSync(root + f);
  console.log('  ' + f + '  ' + st.size + 'B  ' + st.mtime.toISOString());
});