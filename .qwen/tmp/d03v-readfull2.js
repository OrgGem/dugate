const fs = require('fs');
const t = fs.readFileSync('D:/Git/dugate/.qwen/tmp/d03v-full-now.log', 'utf8');
const L = t.split(/\r?\n/);
console.log('=== last 18 lines ===');
L.slice(-18).forEach(function (x, i) { console.log((L.length - 18 + i + 1) + ': ' + x.slice(0, 200)); });
console.log('=== oidc block (lines 55..100) ===');
L.slice(54, 100).forEach(function (x, i) { console.log((55 + i) + ': ' + x.slice(0, 200)); });