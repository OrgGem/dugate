const fs=require('fs');const NL=String.fromCharCode(10);
const p='D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts';
const s=fs.readFileSync(p,'utf8');const L=s.split(NL);
for(let i=0;i<L.length;i++){if(L[i].includes('PROBE_')||L[i].includes('console.log'))console.log((i+1)+'|'+L[i]);}