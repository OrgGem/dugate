const fs=require('fs');
const b=fs.readFileSync('D:/Git/dugate/du-rework/services/orchestrator/tests/connector-revision-http-offline.functional.test.ts');
fs.writeFileSync('D:/Git/dugate/.qwen/tmp/f3-backup-c15.bin', b);
console.log('BACKUP_BYTES=' + b.length);