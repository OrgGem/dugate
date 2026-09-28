const fs=require('fs');
const t='D:/Git/dugate/du-rework/services/orchestrator/';
const list=['tests/admin-error-boundary-offline.test.ts','tests/connector-revision-http-offline.functional.test.ts','src/app/admin/shell-server.ts','src/app/admin/shell-router.ts','src/http/errors.ts','src/modules/auth/oidc-client.ts'];
for (const f of list) { const s=fs.statSync(t+f); console.log(f + '  mtime=' + s.mtime.toISOString() + '  bytes=' + s.size); }
console.log('NOW=' + new Date().toISOString());