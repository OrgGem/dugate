const fs = require('fs');
const crypto = require('crypto');
const m = 'D:/Git/dugate/du-rework/services/orchestrator/migrations/0019_operations_deadline_coalesce_index.sql';
const b = fs.readFileSync(m);
console.log('MIG0019 bytes=' + b.length + ' sha256_8=' + crypto.createHash('sha256').update(b).digest('hex').slice(0, 8) + ' crlf=' + (b.toString('utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).length - 1));
const s = fs.readFileSync('D:/Git/dugate/du-rework/services/orchestrator/src/server.ts');
console.log('SERVER_TS bytes=' + s.length + ' sha256_8=' + crypto.createHash('sha256').digest ? '' : '');