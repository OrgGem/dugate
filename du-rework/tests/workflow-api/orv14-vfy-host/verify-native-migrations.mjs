import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import {
  cleanupHostInfrastructureFixture,
  createHostInfrastructureFixture,
  fixtureConnectionUrl,
} from './infrastructure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const ORCHESTRATOR = path.join(ROOT, 'orchestrator/services/orchestrator');
const CONNECTOR = path.join(ROOT, 'orchestrator/services/connector');
const EXPECTED_CONTINUITY_HASHES = {
  'scripts/ldba-continuity-runner.cjs': '2d0124265ea2771e295d6d124ad000af6b86962c048661a900434c7cd975bf38',
  'scripts/ldba-inventory.cjs': 'ce7ea6cbc6b2ec491c18395891d8d2490a12aa58157ba2a1db3ac8edc569cd7c',
  'scripts/ldba-continuity-mappings.cjs': 'e7bcec2d3ff9d565672e4b04ff5e2a77a8610ffe92a7c8e4ea43413a0fa3b306',
  'scripts/ldba-continuity-source.cjs': '2f7830ee3bf7258604b1c6f6a3b4f49375daa77e2301bb0d0da31ca1f9b348f8',
  'scripts/ldba-continuity-runtime.cjs': '81055e6e2ad1b5cce3b5c1cb4c39ec084082e35a4202a3d844819a16263831de',
  'scripts/ldba-continuity-evidence.cjs': '4c71f0c532891f13a774a7da78ea411429481721354277a47d6dc4400421acc0',
  'scripts/ldba-continuity-plan.cjs': '469f96228377e2db95ed772f25044de31e04559bb3c549cf604a1631cd92b47e',
  'tests/ldba-continuity.test.cjs': '7586788f3136b50e4063f61f64c155baa168f738f244e0751693c13e29fd5e11',
  'migrations/0057_legacy_continuity_evidence.sql': '7a57b386925e5421a8c9324907a6d76d48d31f942491aa3ec6695a487baddf36',
};
const ACTIVE = { fixture: null, rawPath: null, checks: [], scratch: null, pools: [], cleanup: null, stage: 'startup' };
const startedAt = new Date().toISOString();

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function record(name, detail = {}) { ACTIVE.checks.push({ name, status: 'passed', ...detail }); }

async function hashFile(file) { return sha256(await readFile(file)); }

async function sourceFreezeCheck() {
  const current = {};
  for (const [relative, expected] of Object.entries(EXPECTED_CONTINUITY_HASHES)) {
    const digest = await hashFile(path.join(ORCHESTRATOR, relative));
    current[relative] = digest;
    assert.equal(digest, expected, `frozen continuity source changed: ${relative}`);
  }
  record('nine frozen continuity source hashes match the independent checkpoint', {
    sourceFiles: Object.keys(current).length,
    sourceHashes: current,
  });
}

async function snapshotSqlDirectory(directory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const result = [];
  for (const filename of files) result.push({ filename, sha256: await hashFile(path.join(directory, filename)) });
  return result;
}

async function copySqlSnapshot(sourceDirectory, targetDirectory) {
  const { mkdir: makeDir, copyFile } = await import('node:fs/promises');
  await makeDir(targetDirectory, { recursive: true, mode: 0o700 });
  const files = await snapshotSqlDirectory(sourceDirectory);
  for (const entry of files) await copyFile(path.join(sourceDirectory, entry.filename), path.join(targetDirectory, entry.filename));
  return files;
}

function scratchTranspile(ts, sourceBytes, sourceName, targetName) {
  const result = ts.transpileModule(sourceBytes.toString('utf8'), {
    fileName: sourceName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
    },
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${sourceName} transpile reported TypeScript syntax errors`);
  return { code: result.outputText, sha256: sha256(Buffer.from(result.outputText)), targetName };
}

async function createMigrationScratch(fixture) {
  const work = path.join(fixture.workDir, 'orv14-native-migration-scratch');
  await mkdir(path.join(work, 'orchestrator/src/db'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(work, 'connector/db'), { recursive: true, mode: 0o700 });
  ACTIVE.scratch = work;

  const requireFromOrchestrator = createRequire(path.join(ORCHESTRATOR, 'package.json'));
  const requireFromConnector = createRequire(path.join(CONNECTOR, 'package.json'));
  const ts = requireFromOrchestrator('typescript');
  const orchestratorMigrationsSource = path.join(ORCHESTRATOR, 'src/db/migrations.ts');
  const orchestratorOutput = scratchTranspile(
    ts,
    await readFile(orchestratorMigrationsSource),
    orchestratorMigrationsSource,
    path.join(work, 'orchestrator/src/db/migrations.js'),
  );
  await writeFile(orchestratorOutput.targetName, orchestratorOutput.code, { mode: 0o600, flag: 'wx' });
  const orchestratorSqlSource = path.join(ORCHESTRATOR, 'migrations');
  const orchestratorSqlTarget = path.join(work, 'orchestrator/migrations');
  const orchestratorSql = await copySqlSnapshot(orchestratorSqlSource, orchestratorSqlTarget);

  const connectorTs = requireFromConnector('typescript');
  const connectorMigrationSource = path.join(CONNECTOR, 'src/db/pg-client.ts');
  const connectorOutput = scratchTranspile(
    connectorTs,
    await readFile(connectorMigrationSource),
    connectorMigrationSource,
    path.join(work, 'connector/db/pg-client.js'),
  );
  await writeFile(connectorOutput.targetName, connectorOutput.code, { mode: 0o600, flag: 'wx' });
  const connectorSqlSource = path.join(CONNECTOR, 'src/db/migrations');
  const connectorSqlTarget = path.join(work, 'connector/db/migrations');
  const connectorSql = await copySqlSnapshot(connectorSqlSource, connectorSqlTarget);

  process.env.NODE_PATH = [
    path.join(ROOT, 'orchestrator/node_modules/.pnpm/node_modules'),
    path.join(ROOT, 'orchestrator/node_modules'),
    path.join(CONNECTOR, 'node_modules'),
  ].join(path.delimiter);
  Module._initPaths();
  return {
    work,
    orchestratorOutput,
    connectorOutput,
    orchestratorSql,
    connectorSql,
    sourceFiles: {
      'orchestrator/src/db/migrations.ts': await hashFile(orchestratorMigrationsSource),
      'connector/src/db/pg-client.ts': await hashFile(connectorMigrationSource),
    },
  };
}

function orchestratorDb(pool) {
  return {
    query: (text, parameters = []) => pool.query(text, parameters),
    async tx(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}

async function verifyOrchestratorMigrations(fixture, scratch) {
  const requireFromOrchestrator = createRequire(path.join(ORCHESTRATOR, 'package.json'));
  const requireFromScratch = createRequire(path.join(scratch.work, 'package.json'));
  const { Pool } = requireFromOrchestrator('pg');
  const settings = fixture.postgres.orchestratorRestore;
  const pool = new Pool({ connectionString: fixtureConnectionUrl(settings), application_name: 'orv14-vfy-native-orchestrator-migrations', max: 4 });
  ACTIVE.pools.push(pool);
  const db = orchestratorDb(pool);
  const before = await pool.query("SELECT current_setting('cluster_name',true) AS cluster, to_regclass('public.schema_migrations') AS ledger");
  assert.equal(before.rows[0]?.cluster, settings.clusterName);
  assert.equal(before.rows[0]?.ledger, null);
  const migrationModule = requireFromScratch(scratch.orchestratorOutput.targetName);
  const migrated = await migrationModule.migrate(db);
  await migrationModule.verifyMigrations(db);
  const ledger = await pool.query('SELECT sequence,filename FROM schema_migrations ORDER BY sequence');
  const actual = ledger.rows.map((row) => `${String(row.sequence).padStart(4, '0')}:${row.filename}`);
  const expected = scratch.orchestratorSql.map((row) => `${row.filename.slice(0, 4)}:${row.filename}`);
  assert.deepEqual(actual, expected);
  assert.equal(migrated.applied.length, expected.length);
  const status = await migrationModule.migrationStatus(db);
  assert.deepEqual(status, { total: expected.length, applied: expected.length, pending: [] });
  const needed = await pool.query(`SELECT
      to_regclass('public.legacy_continuity_evidence') IS NOT NULL AS continuity_evidence,
      to_regclass('public.legacy_migration_runs') IS NOT NULL AS import_journal,
      to_regclass('public.secret_catalog_revisions') IS NOT NULL AS catalog_revisions,
      to_regclass('public.connector_secret_imports') IS NOT NULL AS connector_import_journal,
      to_regclass('public.profile_bindings') IS NOT NULL AS native_profiles,
      to_regclass('public.artifact_blobs') IS NOT NULL AS artifact_blobs`);
  assert.ok(Object.values(needed.rows[0]).every((value) => value === true));
  const replay = await migrationModule.migrate(db);
  await migrationModule.verifyMigrations(db);
  assert.deepEqual(replay.applied, []);
  const after = await pool.query("SELECT current_setting('cluster_name',true) AS cluster,count(*)::int AS migrations FROM schema_migrations");
  assert.equal(after.rows[0]?.cluster, settings.clusterName);
  assert.equal(Number(after.rows[0]?.migrations), expected.length);
  record('Orchestrator production migration source applied and verified against its isolated PostgreSQL target', {
    clusterName: settings.clusterName,
    migrationCount: expected.length,
    replayAppliedCount: replay.applied.length,
    continuityEvidenceTable: true,
    importJournalTable: true,
    secretCatalogAndConnectorImportTables: true,
    profilesAndArtifactTables: true,
  });
  return { migrationCount: expected.length, ledger: actual, needed: needed.rows[0] };
}

async function verifyConnectorMigrations(fixture, scratch) {
  const settings = fixture.postgres.connectorRestore;
  const requireFromScratch = createRequire(path.join(scratch.work, 'package.json'));
  const { PgSqlClient } = requireFromScratch(scratch.connectorOutput.targetName);
  const database = new PgSqlClient({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    application_name: 'orv14-vfy-native-connector-migrations',
    max: 4,
    migrationDirectory: path.join(scratch.work, 'connector/db/migrations'),
  });
  ACTIVE.pools.push(database.pool);
  const before = await database.query("SELECT current_setting('cluster_name',true) AS cluster,to_regclass('public.connector_schema_migrations') AS ledger");
  assert.equal(before.rows[0]?.cluster, settings.clusterName);
  assert.equal(before.rows[0]?.ledger, null);
  await database.migrate();
  const ledger = await database.query('SELECT version FROM connector_schema_migrations ORDER BY version');
  const actual = ledger.rows.map((row) => row.version);
  const expected = scratch.connectorSql.map((row) => row.filename.replace(/\.sql$/, ''));
  assert.deepEqual(actual, expected);
  const needed = await database.query(`SELECT
      to_regclass('public.connector_invocations') IS NOT NULL AS invocations,
      to_regclass('public.connector_usage_outbox') IS NOT NULL AS usage_outbox,
      to_regclass('public.connector_parity_revisions') IS NOT NULL AS typed_revisions,
      to_regclass('public.connector_parity_draft_intents') IS NOT NULL AS import_claims,
      to_regclass('public.connector_parity_retire_intents') IS NOT NULL AS typed_retire_intents,
      to_regclass('public.connector_replica_runtime_controls') IS NOT NULL AS runtime_controls,
      to_regclass('public.connector_backup_effect_gate') IS NOT NULL AS effect_gate,
      to_regclass('public.connector_backup_effect_acknowledgements') IS NOT NULL AS effect_acknowledgements,
      to_regclass('public.connector_backup_effect_permits') IS NOT NULL AS effect_permits`);
  assert.ok(Object.values(needed.rows[0]).every((value) => value === true));
  await database.migrate();
  const replay = await database.query('SELECT count(*)::int AS count FROM connector_schema_migrations');
  assert.equal(Number(replay.rows[0]?.count), expected.length);
  record('Connector production migration source applied and verified against its isolated PostgreSQL target', {
    clusterName: settings.clusterName,
    migrationCount: expected.length,
    replayAppliedCount: 0,
    typedRevisionsAndImportClaims: true,
    typedRetirementIntents: true,
    runtimeControlsAndBackupEffectGate: true,
  });
  return { migrationCount: expected.length, ledger: actual, needed: needed.rows[0] };
}

async function main() {
  if (process.execPath !== NODE) throw new Error('run the migration slice with the pinned Node 24.21 binary');
  if (process.getuid?.() !== 1000) throw new Error('the fixture executor must run as UID 1000');
  const rawDir = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
  await mkdir(rawDir, { recursive: true });
  ACTIVE.stage = 'sourceFreezeCheck';
  await sourceFreezeCheck();
  ACTIVE.stage = 'createFixture';
  const fixture = await createHostInfrastructureFixture();
  ACTIVE.fixture = fixture;
  ACTIVE.rawPath = path.join(rawDir, `native-migrations-${fixture.projectId}.json`);
  process.stdout.write(`Owned migration fixture: ${fixture.projectId}\n`);
  ACTIVE.stage = 'scratchTranspileAndSqlSnapshot';
  const scratch = await createMigrationScratch(fixture);
  ACTIVE.stage = 'orchestratorMigrations';
  const orchestrator = await verifyOrchestratorMigrations(fixture, scratch);
  ACTIVE.stage = 'connectorMigrations';
  const connector = await verifyConnectorMigrations(fixture, scratch);
  ACTIVE.stage = 'sourceSqlSnapshotRecheck';
  const sourceSqlAfter = {
    orchestrator: await snapshotSqlDirectory(path.join(ORCHESTRATOR, 'migrations')),
    connector: await snapshotSqlDirectory(path.join(CONNECTOR, 'src/db/migrations')),
  };
  assert.equal(sha256(Buffer.from(JSON.stringify(sourceSqlAfter.orchestrator))), sha256(Buffer.from(JSON.stringify(scratch.orchestratorSql))));
  assert.equal(sha256(Buffer.from(JSON.stringify(sourceSqlAfter.connector))), sha256(Buffer.from(JSON.stringify(scratch.connectorSql))));
  record('source migration SQL directory snapshots remained unchanged through the two isolated migrations', {
    orchestratorSqlFiles: sourceSqlAfter.orchestrator.length,
    connectorSqlFiles: sourceSqlAfter.connector.length,
  });

  let error = null;
  ACTIVE.stage = 'cleanup';
  try {
    for (const pool of ACTIVE.pools) await pool.end();
    ACTIVE.pools.length = 0;
    ACTIVE.cleanup = await cleanupHostInfrastructureFixture(fixture);
  } catch (cleanupError) {
    error = cleanupError;
  }
  const completedAt = new Date().toISOString();
  const receipt = {
    schema: 'orv14-host-native-migration-slice/v1',
    status: error ? 'FAILED' : 'PASSED',
    command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-native-migrations.mjs`,
    cwd: ROOT,
    node: 'v24.21.0',
    verifierUid: process.getuid(),
    startedAt,
    completedAt,
    fixtureNamespace: fixture.projectId,
    composeFileSha256: fixture.composeSha256,
    imageIds: fixture.imageIds,
    continuitySourceHashes: EXPECTED_CONTINUITY_HASHES,
    migrationSources: {
      ...scratch.sourceFiles,
      'orchestrator/src/db/migrations.ts.scratchTranspiledSha256': scratch.orchestratorOutput.sha256,
      'connector/src/db/pg-client.ts.scratchTranspiledSha256': scratch.connectorOutput.sha256,
      orchestratorSql: sourceSqlAfter.orchestrator,
      connectorSql: sourceSqlAfter.connector,
      compiledToUniqueScratchPath: path.relative(fixture.root, scratch.work),
      sharedDistWritten: false,
    },
    results: { orchestrator, connector },
    checks: { passed: ACTIVE.checks.length, failed: error ? 1 : 0, skipped: 0, cases: ACTIVE.checks },
    databaseScope: 'only this Compose project’s orchestrator-restore/connector-restore databases; no source/product database or customer data',
    externalEffects: { providerRequests: 0, VaultRequests: 0, S3Requests: 0, RedisUsed: false },
    cleanup: ACTIVE.cleanup,
    errorCode: error?.code ?? (error ? 'OWNED_FIXTURE_CLEANUP_FAILED' : null),
    acceptance: 'native migration slice only; no importer, source-off restore, Host backup, HA/Worker rollout, or production cutover claim',
  };
  await writeFile(ACTIVE.rawPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: receipt.status, checks: receipt.checks, fixtureNamespace: receipt.fixtureNamespace, cleanup: receipt.cleanup, rawReceipt: path.relative(ROOT, ACTIVE.rawPath) }, null, 2) + '\n');
  if (error) throw new Error('owned fixture cleanup failed');
}

main().catch(async (error) => {
  const fixture = ACTIVE.fixture;
  let cleanup = ACTIVE.cleanup;
  if (fixture && !fixture.cleaned) {
    for (const pool of ACTIVE.pools) await pool.end().catch(() => undefined);
    ACTIVE.pools.length = 0;
    try { cleanup = await cleanupHostInfrastructureFixture(fixture); } catch { cleanup = null; }
  }
  if (ACTIVE.rawPath && fixture) {
    const message = String(error?.message ?? error ?? 'unknown failure').slice(0, 1600);
    const safeMessage = Object.values(fixture.credentials ?? {}).reduce((value, secret) =>
      secret ? value.split(secret).join('[REDACTED]') : value, message);
    const receipt = {
      schema: 'orv14-host-native-migration-slice/v1', status: 'FAILED',
      command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-native-migrations.mjs`,
      cwd: ROOT, node: 'v24.21.0', verifierUid: process.getuid(), startedAt,
      completedAt: new Date().toISOString(), fixtureNamespace: fixture.projectId,
      composeFileSha256: fixture.composeSha256, imageIds: fixture.imageIds,
      continuitySourceHashes: EXPECTED_CONTINUITY_HASHES,
      stage: ACTIVE.stage,
      checks: { passed: ACTIVE.checks.length, failed: 1, skipped: 0, cases: ACTIVE.checks },
      databaseScope: 'unique owned synthetic databases only', cleanup,
      errorMessage: safeMessage,
      errorCode: /^[A-Z0-9_]{1,96}$/.test(error?.code ?? '') ? error.code : 'NATIVE_PG_MIGRATION_FAILED',
      acceptance: 'native migration slice only; no importer or overall Host continuity acceptance',
    };
    await writeFile(ACTIVE.rawPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' }).catch(() => undefined);
  }
  process.stderr.write(`Native migration slice failed: ${/^[A-Z0-9_]{1,96}$/.test(error?.code ?? '') ? error.code : 'NATIVE_PG_MIGRATION_FAILED'}\n`);
  process.exitCode = 1;
});
