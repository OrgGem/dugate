const fs = require('fs');
const crypto = require('crypto');
const p = 'D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts';
const b = fs.readFileSync(p);
console.log('TEST_SHA256_8=' + crypto.createHash('sha256').update(b).digest('hex').slice(0, 8) + ' bytes=' + b.length + ' CRLF=' + (b.toString('utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).length - 1));
const s = fs.readFileSync('D:/Git/dugate/du-rework/services/connector/src/http/server.ts', 'utf8');
const i = s.indexOf('function redactConnectorRevision');
console.log(s.slice(i, i + 700));