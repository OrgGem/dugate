const fs = require('fs');
const F = 'D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
let t = fs.readFileSync(F, 'utf8');
let ap = [];
const A1 = '- `tsc --noEmit` cả 2 package: Exit Code **0** (xem bảng dưới).';
const B1 = '- `pnpm --filter @du/worker-sdk exec tsc --noEmit` — Exit Code **0** (log rỗng).\n- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code **0** (log rỗng).\n  Grep `error TS` trên cả 2 log: **không có** dòng nào.';
if (t.indexOf(A1) !== -1) { t = t.replace(A1, B1); ap.push('tsc'); }
const A2 = 'hai file test da ton tai (38/38 xanh san)';
const B2 = 'hai file test da ton tai (37/37 xanh san)';
if (t.indexOf(A2) !== -1) { t = t.replace(A2, B2); ap.push('ledger23'); }
t = t.replace(/\n+$/, '\n');
fs.writeFileSync(F, t, 'utf8');
console.log('applied=' + JSON.stringify(ap));
console.log('stale_3838=' + (t.indexOf('38/38 xanh san') !== -1));
console.log('stale_bangduoi=' + (t.indexOf('xem bảng dưới') !== -1));
console.log('singleLF=' + (t.charCodeAt(t.length-1) === 10 && t.charCodeAt(t.length-2) !== 10));