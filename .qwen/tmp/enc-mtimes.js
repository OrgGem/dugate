const fs = require('fs');
const t = 'D:/Git/dugate/du-rework/services/orchestrator/';
const files = [
  'tests/admin-operations-list-pagination.test.ts',
  'src/app/admin/shell-render.ts',
  'src/app/admin/shell-server.ts',
  'src/app/admin/shell-router.ts',
  'src/app/admin/operation-section-data.ts',
  'src/modules/runtime/runtime.ts',
  'src/modules/runtime/metadata-crypto.ts',
  'tests/runtime-encryption-metadata.test.ts',
];
files.forEach(function (f) {
  try {
    const s = fs.statSync(t + f);
    console.log(f + '  mtime=' + s.mtime.toISOString());
  } catch (e) {
    console.log(f + '  MISSING');
  }
});