const fs = require('fs');
const dir = 'D:/Git/dugate/du-rework/coordination/reports';
const now = Date.now();
for (const f of fs.readdirSync(dir)) {
  const st = fs.statSync(dir + '/' + f);
  const mins = (now - st.mtimeMs) / 60000;
  if (mins < 30) console.log(f + '  mtime=' + st.mtime.toLocaleTimeString('en-GB') + '  (' + mins.toFixed(0) + ' min ago)');
}
console.log('NOW=' + new Date(now).toLocaleTimeString('en-GB'));
