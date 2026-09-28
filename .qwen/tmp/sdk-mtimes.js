const fs = require('fs');
const t = 'D:/Git/dugate/du-rework/packages/worker-sdk/';
['tests/network-boundaries.boundary.test.ts','src/task-context.ts','src/crypto-storage.ts','src/crypto-seam.ts','src/artifact-streams.ts','src/index.ts'].forEach(function (f) {
  try {
    const s = fs.statSync(t + f);
    console.log(f + '  mtime=' + s.mtime.toISOString() + '  bytes=' + s.size);
  } catch (e) { console.log(f + '  MISSING'); }
});