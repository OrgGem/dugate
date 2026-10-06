const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.cwd();
const raw = path.join(root, 'coordination', 'reports', 'raw');
const paths = fs.readdirSync(raw).filter(n => n.startsWith('vfy-counter-fixes-808-') && n !== 'vfy-counter-fixes-808-sha256.txt').map(n => path.join(raw, n));
const extra = [
  'coordination/backfill-leftover-counter-803.sql',
  'services/orchestrator/src/db/db.ts',
  'services/orchestrator/src/db/migrations.ts',
  'services/orchestrator/src/http/routes/public.ts',
  'services/orchestrator/src/modules/encryption/legacy-payload-migration.ts',
  'services/orchestrator/src/modules/encryption/metadata-auth-counter.ts',
  'services/orchestrator/src/modules/operations/ingestion-consumer.ts',
  'services/orchestrator/src/modules/operations/mappers.ts',
  'services/orchestrator/src/modules/operations/submission.ts',
  'services/orchestrator/src/modules/runtime/metadata-crypto.ts',
  'services/orchestrator/src/modules/runtime/runtime.ts',
  'services/orchestrator/tests/enc-meta-sentinel-outbox-source-url.test.ts',
  'services/orchestrator/tests/gate-authenticate-808-pg16.test.ts',
  'services/orchestrator/tests/gate-authenticate-808.test.ts',
  'services/orchestrator/tests/legacy-payload-migration.test.ts',
];
for (const p of extra) paths.push(path.join(root, p));
const unique = [...new Set(paths)].filter(p => fs.existsSync(p)).sort((a,b) => a.localeCompare(b));
const lines = unique.map(p => `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}  ${path.relative(root,p).replaceAll('\\','/')}`);
fs.writeFileSync(path.join(raw, 'vfy-counter-fixes-808-sha256.txt'), lines.join('\n')+'\n', 'utf8');
console.log(lines.join('\n'));