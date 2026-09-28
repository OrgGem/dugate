const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d25-t1.log', 'utf8');
const L = t.split(/\r?\n/);
console.log('bytes=' + t.length + ' lines=' + L.length);
console.log('--- last 30 ---');
L.slice(-30).forEach(function (x, i) { console.log((L.length-30+i+1) + ': ' + x.slice(0, 180)); });