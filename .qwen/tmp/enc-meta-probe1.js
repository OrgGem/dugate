const fs = require('fs');
const p = 'D:/Git/dugate/du-rework/services/orchestrator/src/modules/runtime/runtime.ts';
const s = fs.readFileSync(p, 'utf8');
const L = s.split(String.fromCharCode(10));
console.log('TOTAL_LINES=' + L.length);
const keys = ['buildClaimResult','spawnChildren','requestWaitInput','inputRef','payloadRef','sourceUrl','outbox','claimLease','waitInput','HITL','createCipheriv','aes-256-gcm'];
keys.forEach(function(k){
  const hits = [];
  L.forEach(function(t,i){ if(t.indexOf(k)>=0) hits.push(i); });
  console.log('KEY ' + k + ' count=' + hits.length + ' lines=' + hits.slice(0,30).map(function(x){return x+1;}).join(','));
  hits.slice(0,2).forEach(function(h){
    console.log('--- ctx ' + k + ' @' + (h+1) + ' ---');
    for(let i=Math.max(0,h-3); i<Math.min(L.length,h+10); i++){ console.log((i+1) + '| ' + L[i]); }
  });
});