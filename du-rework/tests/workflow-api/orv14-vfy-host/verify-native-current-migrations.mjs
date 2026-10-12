import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupHostInfrastructureFixture,
  createHostInfrastructureFixture,
  fixtureConnectionUrl,
} from './infrastructure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const BUILD_ROOT = process.argv[2];
if (!BUILD_ROOT || !path.isAbsolute(BUILD_ROOT)) throw new Error('pass the exact private scratch build root');
const ORCH = path.join(ROOT, 'orchestrator/services/orchestrator');
const CONN = path.join(ROOT, 'orchestrator/services/connector');
const PRIVATE_ORCH = path.join(BUILD_ROOT, 'orchestrator/services/orchestrator');
const PRIVATE_CONN = path.join(BUILD_ROOT, 'orchestrator/services/connector');
const RAW_DIR = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
const now = () => new Date().toISOString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = {
  schema: 'orv14-host-current-migrations/v1',
  command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-native-current-migrations.mjs ${BUILD_ROOT}`,
  cwd: ROOT,
  node: 'v24.21.0',
  verifierUid: process.getuid?.() ?? null,
  startedAt: now(),
  fixtureNamespace: null,
  sourceHashesBefore: {},
  sourceHashesAfter: {},
  assertions: [],
  sharedDistWritten: false,
  productSourceWritten: false,
  databaseScope: 'only unique synthetic orchestrator-restore and connector-restore databases',
  externalEffects: { legacySourceRead: false, providerRequests: 0, customerCredentials: false },
  cleanup: null,
  status: 'RUNNING',
};
let fixture;
let orchPool;
let connClient;

function check(name, detail = {}) { receipt.assertions.push({ name, status: 'passed', ...detail }); }
async function snapshot(dir) {
  const files = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  const values = [];
  for (const filename of files) values.push({ filename, sha256: sha(await readFile(path.join(dir, filename))) });
  return values;
}
async function copyMigrations(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await snapshot(source);
  for (const row of entries) await cp(path.join(source, row.filename), path.join(destination, row.filename));
  return entries;
}
function recordFailure(error) {
  const detail = String(error?.stack || error || 'unknown failure').slice(0, 2400);
  receipt.error = detail;
  receipt.status = 'FAILED';
  receipt.assertions.push({ name: 'current migration integration completed', status: 'failed', code: 'CURRENT_MIGRATION_ASSERTION_FAILED' });
}

async function main() {
  if (process.execPath !== NODE) throw new Error('use the pinned Node 24.21.0 binary');
  if (process.getuid?.() !== 1000) throw new Error('designated fixture executor must run as UID 1000');
  await mkdir(RAW_DIR, { recursive: true });
  fixture = await createHostInfrastructureFixture();
  receipt.fixtureNamespace = fixture.projectId;
  receipt.composeFileSha256 = fixture.composeSha256;
  receipt.imageIds = fixture.imageIds;

  const currentSqlOrch = path.join(ORCH, 'migrations');
  const currentSqlConn = path.join(CONN, 'src/db/migrations');
  receipt.sourceHashesBefore = {
    'orchestrator/src/db/migrations.ts': sha(await readFile(path.join(ORCH, 'src/db/migrations.ts'))),
    'connector/src/db/pg-client.ts': sha(await readFile(path.join(CONN, 'src/db/pg-client.ts'))),
    'orchestrator/migrations/0064_cost_financial_adjustments.sql': sha(await readFile(path.join(currentSqlOrch, '0064_cost_financial_adjustments.sql'))),
    'orchestrator/migrations/0065_cost_adjustment_object_pins.sql': sha(await readFile(path.join(currentSqlOrch, '0065_cost_adjustment_object_pins.sql'))),
    'connector/src/db/migrations/015_backup_effect_fences.sql': sha(await readFile(path.join(currentSqlConn, '015_backup_effect_fences.sql'))),
  };
  const orchSqlScratch = await copyMigrations(currentSqlOrch, path.join(PRIVATE_ORCH, 'migrations'));
  const connSqlScratch = await copyMigrations(currentSqlConn, path.join(PRIVATE_CONN, 'dist/db/migrations'));
  receipt.migrationFiles = { orchestratorFileCount: orchSqlScratch.length, connectorFileCount: connSqlScratch.length,
    currentOrchestratorMigrations: orchSqlScratch.filter(item => /^006[345]_/.test(item.filename)),
    currentConnectorBackupFence: connSqlScratch.filter(item => item.filename === '015_backup_effect_fences.sql') };

  const orchRequire = createRequire(path.join(ORCH, 'package.json'));
  const { Pool } = orchRequire('pg');
  orchPool = new Pool({ connectionString: fixtureConnectionUrl(fixture.postgres.orchestratorRestore), application_name: 'orv14-vfy-host-current-migrations', max: 3 });
  const migrationModule = orchRequire(path.join(PRIVATE_ORCH, 'dist/db/migrations.js'));
  const db = {
    query: (text, values = []) => orchPool.query(text, values),
    async tx(work) {
      const client = await orchPool.connect();
      try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
  const initial = await orchPool.query("SELECT current_setting('cluster_name') AS cluster,to_regclass('public.schema_migrations') AS ledger");
  assert.equal(initial.rows[0]?.cluster, fixture.postgres.orchestratorRestore.clusterName);
  assert.equal(initial.rows[0]?.ledger, null);
  const first = await migrationModule.migrate(db);
  await migrationModule.verifyMigrations(db);
  const ledger = await orchPool.query('SELECT sequence,filename FROM schema_migrations ORDER BY sequence');
  const current64 = ledger.rows.find(row => row.filename === '0064_cost_financial_adjustments.sql');
  const current65 = ledger.rows.find(row => row.filename === '0065_cost_adjustment_object_pins.sql');
  assert.ok(current64, 'normal Orchestrator migration 0064 must be applied');
  assert.ok(current65, 'normal Orchestrator migration 0065 must be applied');
  const objects = await orchPool.query(`SELECT
    to_regclass('public.usage_financial_adjustment_heads') IS NOT NULL AS heads,
    to_regclass('public.usage_financial_adjustments') IS NOT NULL AS adjustments,
    to_regclass('public.usage_financial_adjustment_commands') IS NOT NULL AS commands,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usage_financial_adjustments' AND column_name='evidence_object_size_bytes') AS object_size_pin,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usage_financial_adjustments' AND column_name='evidence_object_sha256') AS object_digest_pin,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='usage_financial_adjustments_immutable' AND NOT tgisinternal) AS immutable_trigger`);
  assert.ok(Object.values(objects.rows[0]).every(value => value === true));
  const applied64And65 = first.applied.filter(name => /^006[45]_/.test(name));
  assert.deepEqual(applied64And65, ['0064_cost_financial_adjustments.sql', '0065_cost_adjustment_object_pins.sql']);
  const replay = await migrationModule.migrate(db);
  await migrationModule.verifyMigrations(db);
  assert.deepEqual(replay.applied, []);
  check('current Orchestrator 0064/0065 applied by the normal migration module, ledger verified, and replay is empty', {
    clusterName: initial.rows[0].cluster,
    ledgerRows: ledger.rows.length,
    appliedCurrent: applied64And65,
    replayApplied: replay.applied.length,
    newObjects: objects.rows[0],
  });

  const connPool = new Pool({ connectionString: fixtureConnectionUrl(fixture.postgres.connectorRestore), application_name: 'orv14-vfy-host-current-connector-migration', max: 3 });
  try {
    const PgSqlClient = orchRequire(path.join(PRIVATE_CONN, 'dist/db/pg-client.js')).PgSqlClient;
    connClient = new PgSqlClient({ connectionString: fixtureConnectionUrl(fixture.postgres.connectorRestore),
      application_name: 'orv14-vfy-host-current-connector-migration', max: 3,
      migrationDirectory: path.join(PRIVATE_CONN, 'dist/db/migrations') });
    await connClient.migrate();
    const connectorLedger = await connPool.query('SELECT version FROM connector_schema_migrations ORDER BY version');
    assert.ok(connectorLedger.rows.some(row => row.version === '015_backup_effect_fences'));
    const connectorObjects = await connPool.query(`SELECT
      to_regclass('public.connector_backup_effect_gate') IS NOT NULL AS gate,
      to_regclass('public.connector_backup_effect_acknowledgements') IS NOT NULL AS acknowledgements,
      to_regclass('public.connector_backup_effect_permits') IS NOT NULL AS permits,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='connector_usage_outbox' AND column_name='delivery_state') AS outbox_claim_state`);
    assert.ok(Object.values(connectorObjects.rows[0]).every(value => value === true));
    await connClient.migrate();
    const replayConn = await connPool.query('SELECT count(*)::int AS count FROM connector_schema_migrations');
    assert.equal(Number(replayConn.rows[0].count), connectorLedger.rows.length);
    check('current Connector 015 backup-effect fence applied through the normal Connector migration client and replay preserves its ledger', {
      clusterName: fixture.postgres.connectorRestore.clusterName,
      ledgerRows: connectorLedger.rows.length,
      migration015Present: true,
      replayLedgerRows: Number(replayConn.rows[0].count),
      newObjects: connectorObjects.rows[0],
    });
  } finally {
    await connClient?.close();
    connClient = null;
    await connPool.end();
  }
  const endCluster = await orchPool.query("SELECT current_setting('cluster_name') AS cluster");
  assert.equal(endCluster.rows[0].cluster, fixture.postgres.orchestratorRestore.clusterName);
  receipt.sourceHashesAfter = {
    'orchestrator/src/db/migrations.ts': sha(await readFile(path.join(ORCH, 'src/db/migrations.ts'))),
    'connector/src/db/pg-client.ts': sha(await readFile(path.join(CONN, 'src/db/pg-client.ts'))),
    'orchestrator/migrations/0064_cost_financial_adjustments.sql': sha(await readFile(path.join(currentSqlOrch, '0064_cost_financial_adjustments.sql'))),
    'orchestrator/migrations/0065_cost_adjustment_object_pins.sql': sha(await readFile(path.join(currentSqlOrch, '0065_cost_adjustment_object_pins.sql'))),
    'connector/src/db/migrations/015_backup_effect_fences.sql': sha(await readFile(path.join(currentSqlConn, '015_backup_effect_fences.sql'))),
  };
  assert.deepEqual(receipt.sourceHashesAfter, receipt.sourceHashesBefore);
  check('all five exact migration/module inputs remained hash-stable for this isolated migration run');
  receipt.status = 'PASSED';
}

try {
  await main();
} catch (error) {
  recordFailure(error);
} finally {
  try { await connClient?.close(); } catch { /* cleanup continues */ }
  try { await orchPool?.end(); } catch { /* cleanup continues */ }
  if (fixture) {
    try { receipt.cleanup = await cleanupHostInfrastructureFixture(fixture); }
    catch (error) { receipt.cleanupError = String(error?.message || error).slice(0, 1200); receipt.status = 'CLEANUP_FAILED'; }
  }
  receipt.completedAt = now();
  receipt.checks = { passed: receipt.assertions.filter(item => item.status === 'passed').length,
    failed: receipt.assertions.filter(item => item.status === 'failed').length, skipped: 0 };
  const raw = path.join(RAW_DIR, `native-current-migrations-${receipt.fixtureNamespace || 'fixture-start-failed'}.json`);
  await writeFile(raw, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: receipt.status, checks: receipt.checks, fixtureNamespace: receipt.fixtureNamespace,
    cleanup: receipt.cleanup, rawReceipt: path.relative(ROOT, raw) }, null, 2) + '\n');
}
if (receipt.status !== 'PASSED') process.exitCode = 1;
