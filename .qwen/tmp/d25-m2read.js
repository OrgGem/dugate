const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-m2b.log', 'utf8');
t.split(/\r?\n/).forEach(function (x) { if (/Tests:|×|√/.test(x)) console.log(x.slice(0, 130)); });