const fs = require('fs');
const NL = String.fromCharCode(10);
const p = 'C:/Users/Gem/.qwen/projects/d--git-dugate/memory/project/qwen-platform-lane-state.md';
let s = fs.readFileSync(p, 'utf8');
const anchor = '- **Bẫy viết receipt qua JS string (cycle 13):**';
const i = s.indexOf(anchor);
if (i < 0) { console.log('ANCHOR_MISS'); process.exit(2); }
const lineEnd = s.indexOf(NL, i);
const add = NL + '- **REPEAT + NANG HON (cycle 17):** backslash mat trong chuoi JS khong chi lam hong noi dung written - no lam HONG CA VERIFIER. Regex dem dong ledger viet trong exec source (so bang digit-range) bien thanh ky tu la nen LUON tra 0 dong; toi doc 0 row la ledger OK trong khi vua them dong moi, va mot row 16 trung sot tu cycle 16 song song sot 2 cycle. QUY TAC: verifier phai in SO dem + danh sach so (neu 0 thi nghi nguoc lai, khong bao gio coi 0 la OK); dem TRONG section Ledger chu khong dem ca file (bullet so 9 o Muc 9 cung khop regex); so sanh theo danh sach, khong chi do lon.';
s = s.slice(0, lineEnd) + add + s.slice(lineEnd);
fs.writeFileSync(p, s, 'utf8');
console.log('lesson appended, lines=' + s.split(NL).length);