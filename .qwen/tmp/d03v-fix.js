const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let t = fs.readFileSync(F, 'utf8');
const before = t.length;
let n1 = 0, n2 = 0;
const A = '⇒ 38 test có sẵn và đang xanh.';
const B = '⇒ 37 test có sẵn và đang xanh (33 + 4).';
if (t.indexOf(A) !== -1) { t = t.replace(A, B); n1++; }
const OLD42 = '(lần chạy thứ 4 sau khi restore cũng 0; con số 42 = 38 có sẵn + 2 mới + 2 collateral cùng\n  họ đã có từ trước).';
const NEW42 = '(lần chạy thứ 4 sau khi restore cũng 0). Thành phần 42 đo từ source, không suy\n  đoán: `backend-failclosed` 4 + `consumer` 35 (33 có sẵn + 2 mới) + `offline.functional` 3 —\n  file thứ ba **không** nằm trong 2 file packet nêu tên, tôi vẫn chạy vì glob `url-ingestion`\n  nuốt nó; failclosed đo trực tiếp = 4, không phải 5 như tôi ghi nhầm ở draft đầu.';
if (t.indexOf(OLD42) !== -1) { t = t.replace(OLD42, NEW42); n2++; }
if (t[t.length - 1] !== 10) t = t + '\n';
fs.writeFileSync(F, t, 'utf8');
console.log('bytes ' + before + ' -> ' + t.length);
console.log('fix38to37=' + n1 + '  fix42breakdown=' + n2);
console.log('endsWithNewline=' + (t[t.length - 1] === 10));
let c = 0, l = 0;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) { if (i > 0 && t.charCodeAt(i-1) === 13) c++; else l++; }
console.log('EOL crlf=' + c + ' lf=' + l);
console.log('stale_38_gone=' + (t.indexOf('38 có sẵn') === -1));