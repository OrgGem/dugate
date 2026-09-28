const fs=require('fs');const crypto=require('crypto');
const b=fs.readFileSync('D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts');
console.log('REVERTED_SHA256_8=' + crypto.createHash('sha256').update(b).digest('hex').slice(0,8) + ' bytes=' + b.length + ' (pristine baseline was 012183af/18537)');