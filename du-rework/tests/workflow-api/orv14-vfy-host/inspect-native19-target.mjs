import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const repo = path.resolve('.');
const nodeBin = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const statePath = '/tmp/orv14-vfy-host-mv4n6b3b-fe3af002bb-vSYC3e/native19-state.json';
const rawRoot = path.join(repo, 'coordination/reports/raw/orv14-host-verification');
const rawPath = path.join(rawRoot, `native19-target-state-${Date.now().toString(36)}.json`);
const startedAt = new Date().toISOString();
const receipt = {
  schema: 'orv14-host-native19-target-state/v1',
  command: `${nodeBin} tests/workflow-api/orv14-vfy-host/inspect-native19-target.mjs`,
  cwd: repo,
  node: process.version,
  uid: process.getuid?.() ?? null,
  startedAt,
  fixtureNamespace: 'orv14-vfy-host-mv4n6b3b-fe3af002bb',
  rawPath: path.relative(repo, rawPath),
  sourceWrites: false,
  sourceDatabaseConnected: false,
  customerData: false,
  databases: {},
  assertions: [],
  status: 'RUNNING',
};

function check(name, passed, detail = {}) {
  receipt.assertions.push({ name, status: passed ? 'passed' : 'failed', ...detail });
  assert.ok(passed, name);
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'DATABASE_CHECK_FAILED';
  return { code, name: typeof error?.name === 'string' ? error.name : 'Error' };
}

async function inspect(pool, label, expectedCluster) {
  const identity = await pool.query(`SELECT current_database() AS database_name,
      current_setting('cluster_name') AS cluster_name,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`);
  const row = identity.rows[0];
  check(`${label} targets only its pinned synthetic cluster`, row?.cluster_name === expectedCluster, {
    clusterName: row?.cluster_name ?? null,
    databaseOid: row?.database_oid ?? null,
  });
  const migrations = label === 'orchestratorTarget'
    ? await pool.query('SELECT count(*)::int AS count, min(sequence)::int AS first, max(sequence)::int AS last FROM schema_migrations')
    : await pool.query('SELECT count(*)::int AS count, min(version) AS first, max(version) AS last FROM connector_schema_migrations');
  const activity = label === 'orchestratorTarget'
    ? await pool.query(`SELECT
        (SELECT state FROM maintenance_backup_effect_gate WHERE singleton_id=1) AS backup_gate_state,
        (SELECT fence_revision::text FROM maintenance_backup_effect_gate WHERE singleton_id=1) AS fence_revision,
        (SELECT count(*)::int FROM maintenance_jobs WHERE state IN ('QUEUED','RUNNING','UNKNOWN')) AS live_maintenance_jobs,
        (SELECT count(*)::int FROM maintenance_job_items WHERE status IN ('RUNNING','UNKNOWN')) AS live_maintenance_items,
        (SELECT count(*)::int FROM replica_rollout_jobs WHERE state IN ('RUNNING','UNKNOWN')) AS live_rollout_jobs,
        (SELECT count(*)::int FROM maintenance_backup_artifact_effects WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN')) AS unresolved_artifact_effects`)
    : await pool.query(`SELECT
        (SELECT count(*)::int FROM connector_backup_effect_gate WHERE state IN ('HELD','UNKNOWN')) AS held_connector_fences,
        (SELECT count(*)::int FROM connector_backup_effect_permits WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN')) AS unresolved_connector_effects,
        (SELECT count(*)::int FROM connector_replica_runtime_controls WHERE control_state IN ('PAUSED','DRAINING')) AS nonopen_runtime_controls`);
  return {
    clusterName: row.cluster_name,
    databaseOid: row.database_oid,
    migrationLedger: migrations.rows[0],
    activity: activity.rows[0],
  };
}

let orch;
let connector;
try {
  assert.equal(process.execPath, nodeBin, 'pinned Node 24.21.0 is required');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.fixture.projectId, receipt.fixtureNamespace, 'fixture project must match the owned namespace');
  const expectedOrchestratorCluster = state.fixture.postgres.orchestratorRestore.clusterName;
  const expectedConnectorCluster = state.fixture.postgres.connectorRestore.clusterName;
  const nodeRequire = createRequire(path.join(repo, 'orchestrator/services/orchestrator/package.json'));
  const { Pool } = nodeRequire('pg');
  orch = new Pool({ connectionString: state.run.targetUrl, application_name: 'orv14-vfy-host-native19-target-inspect', max: 2 });
  connector = new Pool({ connectionString: state.run.connectorTargetUrl, application_name: 'orv14-vfy-host-native19-connector-inspect', max: 2 });
  const [orchResult, connectorResult] = await Promise.all([
    inspect(orch, 'orchestratorTarget', expectedOrchestratorCluster),
    inspect(connector, 'connectorTarget', expectedConnectorCluster),
  ]);
  receipt.databases = { orchestratorTarget: orchResult, connectorTarget: connectorResult };
  check('backup snapshot gate is OPEN before the new host interleaving test', orchResult.activity.backup_gate_state === 'OPEN', {
    fenceRevision: orchResult.activity.fence_revision,
  });
  check('no preexisting live maintenance, rollout, or artifact-effect rows contaminate this synthetic target',
    orchResult.activity.live_maintenance_jobs === 0 && orchResult.activity.live_maintenance_items === 0
      && orchResult.activity.live_rollout_jobs === 0 && orchResult.activity.unresolved_artifact_effects === 0,
    { activity: orchResult.activity });
  check('no preexisting Connector fence, permit, or paused control rows contaminate this synthetic target',
    connectorResult.activity.held_connector_fences === 0 && connectorResult.activity.unresolved_connector_effects === 0
      && connectorResult.activity.nonopen_runtime_controls === 0,
    { activity: connectorResult.activity });
  receipt.status = 'PASSED_READ_ONLY_TARGET_CHECK';
} catch (error) {
  receipt.status = 'FAILED_READ_ONLY_TARGET_CHECK';
  receipt.error = safeError(error);
} finally {
  await Promise.allSettled([orch?.end(), connector?.end()]);
  receipt.completedAt = new Date().toISOString();
  receipt.checks = {
    passed: receipt.assertions.filter(item => item.status === 'passed').length,
    failed: receipt.assertions.filter(item => item.status === 'failed').length,
    skipped: 0,
  };
  await mkdir(rawRoot, { recursive: true });
  await writeFile(rawPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: receipt.status, checks: receipt.checks, rawReceipt: receipt.rawPath,
    namespace: receipt.fixtureNamespace, targetFingerprints: Object.fromEntries(Object.entries(receipt.databases).map(([key, value]) => [key,
      { clusterName: value.clusterName, databaseOid: value.databaseOid, migrationCount: value.migrationLedger.count }])) }, null, 2) + '\n');
}

if (receipt.status !== 'PASSED_READ_ONLY_TARGET_CHECK') process.exitCode = 1;
