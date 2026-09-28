const fs = require('fs');
const dir = 'D:/Git/dugate/du-rework/coordination/reports/';
for (const [f, n] of [['qwen3.md', 50], ['tester.md', 34], ['qwen2.md', 30]]) {
  const b = fs.readFileSync(dir + f, 'utf8').split('\n');
  console.log('@@@@@ ' + f + ' (tail ' + n + ')');
  console.log(b.slice(-n).join('\n'));
}
