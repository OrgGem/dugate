const fs=require('fs');const NL=String.fromCharCode(10);
const s=fs.readFileSync('D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md','utf8');
const L=s.split(NL);
const i=L.findIndex(x=>x==='## Ledger');
const rows=[];
for(let k=i+1;k<L.length;k++){ if(!/^- \d+ —/.test(L[k])) break; rows.push(L[k].match(/^- (\d+)/)[1]); }
console.log('LEDGER_ROWS=' + rows.join(','));
console.log('COUNT=' + rows.length + ' EXPECTED_ASC=' + (rows.join(',')==='1,2,3,4,5,6,7,8,9,10,11,12,13,14'));
console.log('dup_row13=' + (L.filter(x=>x.startsWith('- 13 —')).length));
console.log('row1_intact=' + L.some(x=>x.startsWith('- 1 — W-PLAT-MM05-REARM-1: re-arm CAS')));
console.log('lines=' + L.length + ' bytes=' + Buffer.byteLength(s) + ' CRLF=' + (s.split(String.fromCharCode(13)+NL).length-1) + ' FFFD=' + (s.indexOf('\ufffd')>=0));
const heads=L.map((x,j)=>[x,j+1]).filter(([x])=>/^## \d+ —/.test(x)||/^### 1\d —/.test(x)).map(([x,j])=>j+':'+x.slice(0,26));
console.log('SECTION_HEADS=' + heads.join(' | '));