const fs=require('fs');const crypto=require('crypto');
const p='D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts';
const b=fs.readFileSync(p);const s=b.toString('utf8');
console.log('sha=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + ' (expect 8e7e8aa9) bytes=' + b.length + ' CRLF=' + (s.split(String.fromCharCode(13)+String.fromCharCode(10)).length-1) + ' FFFD=' + (s.indexOf('\ufffd')>=0));
console.log('probe_residue=' + ((s.match(/PROBE_|REASON\.path/g)||[]).join(',')||'NONE'));