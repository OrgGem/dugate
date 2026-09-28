const fs=require('fs');const crypto=require('crypto');const NL=String.fromCharCode(10);
const p='D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts';
const b=fs.readFileSync(p);const s=b.toString('utf8');const L=s.split(NL);
console.log('sha8='+crypto.createHash('sha256').update(b).digest('hex').slice(0,8)+' bytes='+b.length+' lines='+L.length);
const hasM2=s.indexOf('reason it claims')>=0;
const hasPosCtrl=s.indexOf('Positive control')>=0;
const hasBG=s.indexOf('BINDING_GUARD')>=0;
console.log('m2title='+hasM2+' posCtrl='+hasPosCtrl+' bindingGuard='+hasBG);
console.log('L395='+JSON.stringify(L[394]).slice(0,80));
console.log('L408='+JSON.stringify(L[407]).slice(0,90));
const rep='D:/Git/dugate/du-rework/coordination/reports/qwen-platform.md';
const rb=fs.readFileSync(rep);const rs=rb.toString('utf8');const RL=rs.split(NL);
console.log('REPORT_lines='+RL.length+' has_Muc15='+(rs.indexOf('## 15')>=0)+' has_RP15='+(rs.indexOf('cuối cycle 15')>=0)+' has_BLOCKED='+(rs.indexOf('W-ENC-01-SCHEMA BLOCKED')>=0));
const li=RL.findIndex(x=>x==='## Ledger');
console.log('LEDGER_AT_LINE='+(li+1));
const lastRows=[];
for(let k=li+1;k<RL.length&&lastRows.length<3;k++){ if(/^- \d+ —/.test(RL[k])) lastRows.push((k+1)+': '+RL[k].slice(0,40)); }
console.log('LAST_LEDGER_ROWS='+JSON.stringify(lastRows));