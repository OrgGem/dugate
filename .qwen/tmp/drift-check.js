const fs=require('fs');
const NL=String.fromCharCode(10);
const dir='D:/Git/dugate/du-rework/services/orchestrator/tests/';
const files=['operations-list-contract-conformance.test.ts','admin-operations-list-pagination.test.ts','admin-operations-sort-http-offline.test.ts','connector-revision-http-offline.functional.test.ts','../src/server.ts'];
for (const f of files) { const st=fs.statSync(dir+f); console.log(f + ' mtime=' + st.mtime.toISOString()); }
const conf=fs.readFileSync(dir+'operations-list-contract-conformance.test.ts','utf8');
const i=conf.indexOf('const ORDER_BY_BY_SORT');
console.log('---ORDER_BY_BY_SORT now---');
console.log(conf.slice(i, i+620));
const t=conf.indexOf('the NULL sentinel');
console.log('---sentinel test now---');
console.log(conf.slice(t-120, t+620));