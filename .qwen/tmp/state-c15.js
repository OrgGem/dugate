const fs=require('fs');const crypto=require('crypto');const NL=String.fromCharCode(10);
function sha(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,8);}
const t='D:/Git/dugate/du-rework/services/orchestrator/';
console.log('server.ts=' + sha(t+'src/server.ts') + ' (ky vong 29c79b1a) literal_present=' + (fs.readFileSync(t+'src/server.ts','utf8').indexOf("'${sentinel}'::timestamptz")>=0));
console.log('f3=' + sha(t+'tests/connector-revision-http-offline.functional.test.ts') + ' (ky vong 671603bf)');
const g=fs.readFileSync(t+'src/server.ts','utf8');
const i=g.indexOf('function bindOperationsListSortKey');
console.log('--- sortKey fn now ---');
console.log(g.slice(i, i+330));