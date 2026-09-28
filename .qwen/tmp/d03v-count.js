
const fs = require('fs');
const dir = 'D:/Git/dugate/du-rework/services/orchestrator/tests/';
fs.readdirSync(dir).filter(function (f) { return /^url-ingestion/.test(f); })
  .forEach(function (f) {
    const t = fs.readFileSync(dir + f, 'utf8');
    const its = (t.match(/^\s*it\(/gm) || []).length;
    const ite = (t.match(/it\.each/g) || []).length;
    console.log(f + '  it_lines=' + its + '  it.each=' + ite);
  });
