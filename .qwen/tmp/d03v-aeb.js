const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d03v-full-now.log', 'utf8');
const L = t.split(/\r?\n/);
console.log('=== admin-error-boundary block (168..200) ===');
L.slice(167, 200).forEach(function (x, i) { console.log((168 + i) + ': ' + x.slice(0, 190)); });