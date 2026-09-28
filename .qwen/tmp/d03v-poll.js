const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d03v-full-now.log', 'utf8');
console.log('LINES=' + t.split(/\r?\n/).length + '  DONE=' + /Test Suites:/.test(t));
console.log('PASS=' + (t.match(/^PASS /gm) || []).length + '  FAIL=' + (t.match(/^FAIL /gm) || []).length);