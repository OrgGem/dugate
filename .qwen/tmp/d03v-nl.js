const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const t = fs.readFileSync(F, 'utf8');
const last = t.charCodeAt(t.length - 1);
console.log('lastCharCode=' + last + ' (10=LF)');
console.log('endsWithSingleLF=' + (last === 10 && t.charCodeAt(t.length - 2) !== 10));
console.log('tailCodes=' + [t.charCodeAt(t.length-3), t.charCodeAt(t.length-2), t.charCodeAt(t.length-1)].join(','));