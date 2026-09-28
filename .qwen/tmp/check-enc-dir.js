const fs = require('fs');
const d = 'D:/Git/dugate/du-rework/services/orchestrator/src/modules/encryption/';
console.log('dir_exists=' + fs.existsSync(d));
if (fs.existsSync(d)) {
  fs.readdirSync(d).forEach(function (f) {
    const s = fs.statSync(d + f);
    console.log('  ' + f + '  ' + s.size + 'B  mtime=' + s.mtime.toISOString());
  });
}