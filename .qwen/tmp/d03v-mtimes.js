const fs = require('fs');
const path = 'D:/Git/dugate/du-rework/services/orchestrator/';
const files = [
  'tests/admin-crypto-config-oidc.test.ts',
  'tests/adm-base-03-safe-error-offline.functional.test.ts',
  'tests/admin-shell-session-lifecycle.test.ts',
  'tests/admin-operations-list-pagination.test.ts',
  'tests/url-ingestion-consumer-offline.functional.test.ts',
  'src/modules/runtime/runtime.ts',
  'src/app/admin/shell-router.ts',
  'src/app/admin/shell-server.ts'
];
files.forEach(function (f) {
  try {
    const s = fs.statSync(path + f);
    console.log(f + '  mtime=' + s.mtime.toISOString());
  } catch (e) { console.log(f + '  MISSING'); }
});