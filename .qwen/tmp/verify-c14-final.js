const fs=require('fs');const NL=String.fromCharCode(10);
const s=fs.readFileSync('D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md','utf8');
const L=s.split(NL);
const i=L.findIndex(x=>x==='## Ledger');
const rows=[];
for(let k=i+1;k<L.length;k++){ if(!/^- \d+ —/.test(L[k])) break; rows.push(L[k].match(/^- (\d+)/)[1]); }
console.log('LEDGER=' + rows.join(',') + ' COUNT=' + rows.length + ' ASC=' + (rows.join(',')==='1,2,3,4,5,6,7,8,9,10,11,12,13,14'));
console.log('row1_ok=' + L.some(x=>x.startsWith('- 1 — W-PLAT-MM05-REARM-1: re-arm CAS')) + ' dup14=' + L.filter(x=>x.startsWith('- 14 —')).length + ' dup13=' + L.filter(x=>x.startsWith('- 13 —')).length);
console.log('lines=' + L.length + ' CRLF=' + (s.split(String.fromCharCode(13)+NL).length-1) + ' FFFD=' + (s.indexOf('\ufffd')>=0));
console.log('addendum=' + (s.indexOf('Bổ sung Verify (cuối cycle 14')>=0) + ' D35=' + ((s.match(/Δ35/g)||[]).length) + ' mentions');