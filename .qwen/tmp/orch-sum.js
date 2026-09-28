const fs = require('fs');
const s = fs.readFileSync('D:/Git/dugate/.qwen/tmp/orch-full-d03v.log', 'utf8');
const L = s.split(String.fromCharCode(10));
L.forEach(function (l) { if (/^Tests:|^Test Suites:|^FAIL /.test(l)) console.log(l); });