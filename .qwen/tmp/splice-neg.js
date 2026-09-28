const fs=require('fs');const crypto=require('crypto');
const p='D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts';
const NL=String.fromCharCode(10);
let s=fs.readFileSync(p,'utf8');
const startMark="  it('invalid credential source at the HTTP edge";
const endMark='    expect(h.repo.rows).toHaveLength(1);';
const a=s.indexOf(startMark); const b=s.indexOf(endMark, a);
if (a<0||b<0) { console.log('MARKER_MISS a='+a+' b='+b); process.exit(2); }
const before=s.slice(0,a); const after=s.slice(b+endMark.length);
const out=before+fs.readFileSync('D:/Git/dugate/.qwen/tmp/neg-block.txt','utf8')+after;
fs.writeFileSync(p,out,'utf8');
const b2=fs.readFileSync(p);
console.log('SPLICE_OK bytes='+b2.length+' lines='+(out.split(NL).length)+' sha='+crypto.createHash('sha256').update(b2).digest('hex').slice(0,8));
console.log('tail_ok=' + JSON.stringify(out.slice(b2.length-0).slice(0,0)) + ' next_line=' + JSON.stringify(out.split(NL)[out.split(NL).findIndex(x=>x.indexOf('expect(h.repo.rows.map')>=0)+1]));