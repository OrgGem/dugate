const fs=require('fs');const crypto=require('crypto');
const b=fs.readFileSync('D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts');
console.log('FINAL_SHA='+crypto.createHash('sha256').update(b).digest('hex').slice(0,8)+' BYTES='+b.length+' LINES='+b.toString('utf8').split(String.fromCharCode(10)).length);