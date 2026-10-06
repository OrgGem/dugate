const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const raw = path.join('coordination', 'reports', 'raw');
const container = 'du-vfy-counter808-pg16-20261005';
const base = fs.readFileSync(path.join('coordination', 'backfill-leftover-counter-803.sql'), 'utf8');
const marker = '-- 0b. Coverage invariant: every METADATA_SLOTS entry appears exactly once.';
if (base.split(marker).length !== 2) throw new Error('expected exactly one insertion marker');
const writeProbe = `DO $vfy808$\nDECLARE was_blocked boolean := false;\nBEGIN\n  BEGIN\n    UPDATE outbox SET attempts = attempts + 1 WHERE delivery_id = 'vfy-counter-808-shape-envelope';\n  EXCEPTION WHEN SQLSTATE '25006' THEN\n    was_blocked := true;\n  END;\n  IF NOT was_blocked THEN RAISE EXCEPTION 'READ_ONLY_WRITE_NOT_BLOCKED'; END IF;\n  RAISE NOTICE 'VFY808_SAME_TRANSACTION_WRITE_BLOCKED';\nEND\n$vfy808$;\n\n`;
const instrumented = base.replace(marker, `${writeProbe}${marker}`);
fs.writeFileSync(path.join(raw, 'vfy-counter-fixes-808-readonly-instrumented.sql'), instrumented, 'utf8');
const seed = `INSERT INTO outbox (aggregate_id, type, delivery_id, payload) VALUES\n` +
  `('aaaaaaaa-0000-4000-8000-000000000001','task.dispatch','vfy-counter-808-shape-envelope','{"version":1,"algorithm":"aes-256-gcm","dek":{},"nonce":"n","tag":"t","ciphertext":"c"}'::jsonb),\n` +
  `('aaaaaaaa-0000-4000-8000-000000000001','task.dispatch','vfy-counter-808-job-envelope',jsonb_build_object('contractVersion','1','deliveryId','synthetic','taskId','synthetic','operationId','synthetic'));\n`;
function run(label, sql) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'du_vfy808', '-f', '-'], { encoding: 'utf8', input: sql });
  const code = typeof result.status === 'number' ? result.status : 1;
  const file = path.join(raw, `${label}.txt`);
  const body = [`COMMAND=docker exec -i ${container} psql -v ON_ERROR_STOP=1 -U postgres -d du_vfy808 -f -`, `STDOUT:\n${result.stdout ?? ''}`, `STDERR:\n${result.stderr ?? ''}`, `LITERAL_EXIT_CODE=${code}`, result.error ? `SPAWN_ERROR=${result.error.message}` : ''].filter(Boolean).join('\n\n');
  fs.writeFileSync(file, body, 'utf8');
  console.log(`${label} exit=${code}`);
  if (code !== 0) throw new Error(`${label} failed exit=${code}`);
}
run('vfy-counter-fixes-808-pg16-seed-fixtures', seed);
run('vfy-counter-fixes-808-pg16-exact-sql', base);
run('vfy-counter-fixes-808-pg16-same-tx-write-block', instrumented);