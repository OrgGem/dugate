'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const QUOTE = String.fromCharCode(34);
const PG_IMAGE = 'postgres:16-alpine';
const NODE_IMAGE = 'node:24.21.0-alpine3.24';
const DATABASE_NAME = 'du_ldba09_rehearsal';
const DATABASE_PASSWORD = 'ldba09-synthetic-only';
const FIXTURE_TIME = '2026-01-01T00:00:00Z';
const API_KEY_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const OPERATION_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
];
const CONNECTOR_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  'legacy-connector-text',
];
const OVERRIDE_IDS = [
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
];
const PROFILE_IDS = [
  '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
];
const FILE_IDS = [
  '60000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000002',
];
const USER_IDS = [
  '70000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000003',
];
const ASSIGNMENT_IDS = [
  '80000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000002',
];
const DESTINATION_ENTITIES = Object.freeze([
  'api_keys',
  'connector_revisions',
  'secret_versions',
  'profile_bindings',
  'profile_active_revisions',
  'profile_names',
  'operations',
  'connector_prompt_overrides',
  'artifacts',
  'artifact_blobs',
  'admin_local_users',
  'user_profile_assignments',
  'legacy_workflow_schemas',
]);
const EXPECTED_TARGET_COUNTS = Object.freeze({
  api_keys: 2,
  connector_revisions: 2,
  secret_versions: 2,
  profile_bindings: 2,
  profile_active_revisions: 2,
  profile_names: 2,
  operations: 2,
  connector_prompt_overrides: 1,
  artifacts: 2,
  artifact_blobs: 2,
  admin_local_users: 0,
  user_profile_assignments: 0,
  legacy_workflow_schemas: 1,
});

const TIMESTAMP_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'deletedAt',
  'webhookSentAt',
  'lastAccessedAt',
  'expiresAt',
]);
const DECIMAL_FIELDS = new Set(['totalCostUsd', 'spendingLimit', 'totalUsed']);
const INTEGER_FIELDS = new Set([
  'currentStep',
  'failedAtStep',
  'progressPercent',
  'totalInputTokens',
  'totalOutputTokens',
  'pagesProcessed',
  'timeoutSec',
  'size',
  'refCount',
  'rateLimitPerMin',
  'maxConcurrent',
]);

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error('synthetic fixture identifier rejected');
  }
  return QUOTE + value + QUOTE;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(label + ' failed with exit ' + result.status + (detail ? ':\n' + detail : ''));
  }
}

function sleepSync(milliseconds) {
  const storage = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(storage), 0, 0, milliseconds);
}

function packageRoot(entry, name) {
  let directory = path.dirname(entry);
  while (true) {
    const metadataPath = path.join(directory, 'package.json');
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (metadata.name === name) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('could not find package root for ' + name);
    directory = parent;
  }
}

function copyPackage(name, resolver, nodeModulesPath, copied) {
  if (copied.has(name)) return;
  let entry;
  try {
    entry = resolver.resolve(name);
  } catch {
    return;
  }
  const root = packageRoot(entry, name);
  const destination = path.join(nodeModulesPath, ...name.split('/'));
  fs.mkdirSync(destination, { recursive: true });
  for (const child of fs.readdirSync(root)) {
    if (child === 'node_modules') continue;
    fs.cpSync(path.join(root, child), path.join(destination, child), { recursive: true, dereference: true });
  }
  copied.add(name);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const childResolver = createRequire(entry);
  const dependencies = {
    ...(metadata.dependencies || {}),
    ...(metadata.optionalDependencies || {}),
  };
  for (const dependency of Object.keys(dependencies)) {
    copyPackage(dependency, childResolver, nodeModulesPath, copied);
  }
}

function copyPayload(payloadRoot, tempRoot) {
  const packageRootPath = path.resolve(__dirname, '..');
  const orchestratorRoot = path.resolve(packageRootPath, '../..');
  const scriptDirectory = path.join(payloadRoot, 'scripts');
  const testDirectory = path.join(payloadRoot, 'tests');
  const migrationDirectory = path.join(payloadRoot, 'migrations');
  const nodeModulesPath = path.join(payloadRoot, 'node_modules');
  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.mkdirSync(testDirectory, { recursive: true });
  fs.mkdirSync(path.join(migrationDirectory, 'orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(migrationDirectory, 'connector'), { recursive: true });
  const copied = new Set();
  const pgEntry = require.resolve('pg');
  copyPackage('pg', createRequire(pgEntry), nodeModulesPath, copied);
  for (const filename of [
    'ldba-03-backfill.cjs',
    'ldba-03-production-adapter.cjs',
    'ldba-09-skip-fixture-adapter.cjs',
    'ldba-09-harness.cjs',
  ]) {
    fs.copyFileSync(path.join(packageRootPath, 'scripts', filename), path.join(scriptDirectory, filename));
  }
  for (const filename of ['ldba-03-runner-skip.test.cjs']) {
    fs.copyFileSync(path.join(packageRootPath, 'tests', filename), path.join(testDirectory, filename));
  }
  for (const [sourceDirectory, destinationDirectory] of [
    [path.join(packageRootPath, 'migrations'), path.join(migrationDirectory, 'orchestrator')],
    [path.join(orchestratorRoot, 'services', 'connector', 'src', 'db', 'migrations'), path.join(migrationDirectory, 'connector')],
  ]) {
    for (const filename of fs.readdirSync(sourceDirectory).filter((name) => name.endsWith('.sql'))) {
      fs.copyFileSync(path.join(sourceDirectory, filename), path.join(destinationDirectory, filename));
    }
  }
  const nodeSourceContainer = 'du-ldba09-node-src-' + process.pid;
  const nodeHostPath = path.join(tempRoot, 'node-linux');
  const created = run('docker', ['create', '--network', 'none', '--name', nodeSourceContainer, NODE_IMAGE]);
  requireSuccess(created, 'create local Node runtime source container');
  try {
    requireSuccess(run('docker', ['cp', nodeSourceContainer + ':/usr/local/bin/node', nodeHostPath]), 'copy Node runtime');
  } finally {
    run('docker', ['rm', '--force', nodeSourceContainer]);
  }
  return { nodeHostPath, payloadRoot };
}

function fixtureOperation(index) {
  const terminal = index === 1;
  return {
    id: OPERATION_IDS[index],
    apiKeyId: API_KEY_IDS[index],
    createdByUserId: null,
    idempotencyKey: null,
    done: terminal,
    state: terminal ? 'SUCCEEDED' : 'RUNNING',
    progressPercent: terminal ? 100 : 15,
    progressMessage: terminal ? 'complete' : 'running',
    endpointSlug: 'analyze',
    pipelineJson: JSON.stringify({ kind: 'ldba09-synthetic', index }),
    currentStep: terminal ? 2 : 1,
    failedAtStep: null,
    filesJson: '[]',
    outputFormat: 'json',
    outputContent: terminal ? 'synthetic-result' : null,
    outputFilePath: null,
    extractedData: terminal ? JSON.stringify({ fixture: true }) : null,
    stepsResultJson: null,
    totalInputTokens: 10 + index,
    totalOutputTokens: 20 + index,
    pagesProcessed: 1,
    modelUsed: 'synthetic-model',
    totalCostUsd: index === 0 ? null : '0.000001',
    usageBreakdown: null,
    webhookUrl: null,
    webhookSentAt: null,
    errorCode: null,
    errorMessage: null,
    filesDeleted: false,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    deletedAt: null,
  };
}

function fixtureApiKey(index) {
  return {
    id: API_KEY_IDS[index],
    name: 'synthetic-key-' + index,
    keyHash: 'sha256:synthetic-hash-' + index,
    prefix: 'sk-synthetic-' + index,
    role: 'STANDARD',
    note: null,
    spendingLimit: '12.340000',
    totalUsed: '1.200000',
    status: 'active',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };
}

function fixtureConnector(index) {
  const unsupportedAuth = index === 1;
  return {
    id: CONNECTOR_IDS[index],
    name: 'Synthetic connector ' + index,
    slug: 'synthetic-connector-' + index,
    description: null,
    endpointUrl: 'https://connector-' + index + '.example.test/api',
    httpMethod: 'POST',
    authType: unsupportedAuth ? 'BASIC_AUTH' : 'API_KEY_HEADER',
    authSecret: 'synthetic-credential-' + index,
    authKeyHeader: 'X-API-Key',
    promptFieldName: 'prompt',
    fileFieldName: null,
    fileUrlFieldName: null,
    defaultPrompt: null,
    staticFormFields: '{}',
    extraHeaders: '{}',
    responseContentPath: 'content',
    sessionIdResponsePath: null,
    sessionIdFieldName: null,
    timeoutSec: 30,
    state: 'ENABLED',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };
}

function fixtureOverride(index) {
  return {
    id: OVERRIDE_IDS[index],
    connectionId: CONNECTOR_IDS[index],
    apiKeyId: API_KEY_IDS[index % API_KEY_IDS.length],
    endpointSlug: 'analyze',
    stepId: '_default',
    promptOverride: 'synthetic override ' + index,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };
}

function fixtureProfile(index) {
  return {
    id: PROFILE_IDS[index],
    apiKeyId: API_KEY_IDS[index],
    endpointSlug: 'analyze',
    enabled: true,
    parameters: '{}',
    connectionsOverride: '[]',
    jobPriority: 'MEDIUM',
    fileUrlAuthConfig: '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef',
    allowedFileExtensions: '.pdf,.docx',
    rateLimitPerMin: null,
    maxConcurrent: null,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };
}

function fixtureRows() {
  const objectBytes = [Buffer.from('synthetic-file-one'), Buffer.from('synthetic-file-two')];
  const duplicateWorkflow = JSON.stringify({ slug: 'analyze', nodes: [], fixtureRevision: 1 });
  return {
    Operation: [fixtureOperation(0), fixtureOperation(1)],
    ApiKey: [fixtureApiKey(0), fixtureApiKey(1)],
    ExternalApiConnection: [0, 1, 2].map(fixtureConnector),
    ExternalApiOverride: [0, 1, 2].map(fixtureOverride),
    ProfileEndpoint: [fixtureProfile(0), fixtureProfile(1)],
    AppSetting: [
      { key: 'wb_schema:analyze', value: duplicateWorkflow, updatedAt: FIXTURE_TIME },
      { key: 'wb_schema:analyze', value: duplicateWorkflow, updatedAt: FIXTURE_TIME },
      { key: 'deployment:region', value: 'synthetic', updatedAt: FIXTURE_TIME },
    ],
    FileCache: objectBytes.map((bytes, index) => ({
      id: FILE_IDS[index],
      md5Hash: crypto.createHash('md5').update(bytes).digest('hex'),
      s3Key: 'synthetic/cache/object-' + index,
      size: bytes.length,
      mimeType: 'text/plain',
      fileName: 'synthetic-' + index + '.txt',
      refCount: 0,
      lastAccessedAt: null,
      createdAt: FIXTURE_TIME,
    })),
    User: [
      {
        id: USER_IDS[0],
        username: 'synthetic-bcrypt-user',
        password: '$2b$12$' + 'A'.repeat(53),
        role: 'ADMIN',
        provider: null,
        providerSub: null,
        email: null,
        displayName: null,
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
      },
      {
        id: USER_IDS[1],
        username: 'synthetic-empty-password-user',
        password: '',
        role: 'USER',
        provider: null,
        providerSub: null,
        email: null,
        displayName: null,
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
      },
      {
        id: USER_IDS[2],
        username: 'synthetic-oidc-user',
        password: '',
        role: 'USER',
        provider: 'oidc',
        providerSub: 'synthetic-subject',
        email: 'synthetic@example.test',
        displayName: 'Synthetic OIDC',
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
      },
    ],
    UserProfileAssignment: [
      {
        id: ASSIGNMENT_IDS[0],
        userId: USER_IDS[1],
        apiKeyId: API_KEY_IDS[0],
        createdAt: FIXTURE_TIME,
      },
      {
        id: ASSIGNMENT_IDS[1],
        userId: 'legacy-user-text',
        apiKeyId: API_KEY_IDS[1],
        createdAt: FIXTURE_TIME,
      },
    ],
  };
}

function sourceColumnType(name, values) {
  if (TIMESTAMP_FIELDS.has(name)) return 'TIMESTAMPTZ';
  if (DECIMAL_FIELDS.has(name)) return 'NUMERIC(20,6)';
  if (INTEGER_FIELDS.has(name)) return 'INTEGER';
  if (values.some((value) => typeof value === 'boolean')) return 'BOOLEAN';
  if (values.some((value) => typeof value === 'number')) return 'INTEGER';
  return 'TEXT';
}

async function seedLegacySources(pool) {
  const client = await pool.connect();
  const rowsByTable = fixtureRows();
  const counts = {};
  try {
    for (const [table, rows] of Object.entries(rowsByTable)) {
      const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const definitions = fields.map((field) => {
        const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined);
        return quoteIdentifier(field) + ' ' + sourceColumnType(field, values);
      });
      await client.query('CREATE TABLE ' + quoteIdentifier(table) + ' (' + definitions.join(', ') + ')');
      const columns = fields.map(quoteIdentifier).join(', ');
      const placeholders = fields.map((_, index) => '$' + (index + 1)).join(', ');
      for (const row of rows) {
        await client.query(
          'INSERT INTO ' + quoteIdentifier(table) + ' (' + columns + ') VALUES (' + placeholders + ')',
          fields.map((field) => row[field] ?? null),
        );
      }
      counts[table] = rows.length;
    }
  } finally {
    client.release();
  }
  return counts;
}

function listMigrations(directory, pattern, expectedCount) {
  const files = fs.readdirSync(directory).filter((name) => pattern.test(name)).sort();
  if (files.length !== expectedCount) {
    throw new Error('expected ' + expectedCount + ' migrations, found ' + files.length);
  }
  return files;
}

async function applyMigrations(pool, root) {
  const orchestratorDirectory = path.join(root, 'migrations', 'orchestrator');
  const connectorDirectory = path.join(root, 'migrations', 'connector');
  const orchestratorFiles = listMigrations(orchestratorDirectory, /^\d{4}_.+\.sql$/, 38);
  const connectorFiles = listMigrations(connectorDirectory, /^\d{3}_.+\.sql$/, 9);
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE schema_migrations (sequence INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await client.query('CREATE TABLE connector_schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const filename of orchestratorFiles) {
      const sequence = Number(filename.slice(0, 4));
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(orchestratorDirectory, filename), 'utf8'));
        await client.query('INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)', [sequence, filename]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(filename + ' failed: ' + (error && error.message || error));
      }
    }
    for (const filename of connectorFiles) {
      const version = filename.slice(0, -4);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(connectorDirectory, filename), 'utf8'));
        await client.query('INSERT INTO connector_schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(filename + ' failed: ' + (error && error.message || error));
      }
    }
  } finally {
    client.release();
  }
  const counts = await pool.query(
    'SELECT (SELECT count(*)::int FROM schema_migrations) AS orchestrator_count, '
      + '(SELECT count(*)::int FROM connector_schema_migrations) AS connector_count, '
      + '(SELECT count(*)::int FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2) AS table_count',
    ['public', 'BASE TABLE'],
  );
  return {
    orchestrator: orchestratorFiles.length,
    connector: connectorFiles.length,
    tables: Number(counts.rows[0].table_count),
    orchestratorLedger: Number(counts.rows[0].orchestrator_count),
    connectorLedger: Number(counts.rows[0].connector_count),
  };
}

async function seedTargetReferences(pool) {
  const tenant = await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id::text AS id', ['legacy-default']);
  assert.equal(tenant.rows.length, 1);
  const manifest = {
    contractVersion: '1',
    businessId: 'document',
    version: '1.0.0',
    displayName: 'Synthetic Document',
    description: 'Synthetic rehearsal registry row',
    imageDigest: 'sha256:' + 'a'.repeat(64),
    runtime: { wireVersion: '1', handlerKinds: ['synthetic'] },
    capabilities: { cancel: false, resume: false, parallel: false },
    actions: [{
      name: 'analyze',
      displayName: 'Analyze',
      description: 'Synthetic action',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 3 },
      capabilities: { cancel: false, resume: false },
      defaultLimits: {},
    }],
  };
  await pool.query(
    'INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue) '
      + 'VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)',
    [
      'document',
      '1.0.0',
      '1',
      JSON.stringify(manifest),
      'sha256:' + 'b'.repeat(64),
      'ENABLED',
      'du-business-document-1.0.0',
    ],
  );
  return tenant.rows[0].id;
}

function assertReportSkips(report) {
  const actual = report.skips.map((item) => [item.table, item.sourceKey, item.code].join('|')).sort();
  const expected = [
    ['ExternalApiConnection', CONNECTOR_IDS[1], 'CONNECTOR_ROW_OUT_OF_SCOPE'],
    ['ExternalApiOverride', OVERRIDE_IDS[1], 'OVERRIDE_CONNECTOR_NOT_MIGRATED'],
    ['ExternalApiOverride', OVERRIDE_IDS[2], 'OVERRIDE_CONNECTION_ID_NOT_UUID'],
    ['User', USER_IDS[0], 'IDENTITY_PENDING_REHASH'],
    ['User', USER_IDS[1], 'IDENTITY_PENDING_REHASH'],
    ['User', USER_IDS[2], 'IDENTITY_PENDING_REHASH'],
    ['UserProfileAssignment', ASSIGNMENT_IDS[0], 'ASSIGNMENT_USER_NOT_MIGRATED'],
    ['UserProfileAssignment', ASSIGNMENT_IDS[1], 'ASSIGNMENT_USER_ID_NOT_UUID'],
  ].map((item) => item.join('|')).sort();
  assert.deepEqual(actual, expected);
  assert.equal(report.sourceRows.failed, 0);
}

function runRunner(payloadRoot, adapterName, mode, skipPolicy) {
  const adapterPath = path.join(payloadRoot, 'scripts', adapterName);
  const runnerPath = path.join(payloadRoot, 'scripts', 'ldba-03-backfill.cjs');
  const env = {
    ...process.env,
    DATABASE_URL: 'postgres://postgres:' + DATABASE_PASSWORD + '@127.0.0.1:5432/' + DATABASE_NAME,
    LDBA_A1_PASSED: '1',
    LDBA03_SOURCE_VERSION: 'synthetic-pg16-utc-2026-10-09',
    LDBA_A1_SOURCE_VERSION: 'synthetic-pg16-utc-2026-10-09',
    LDBA03_ADAPTER_MODULE: adapterPath,
  };
  if (skipPolicy === null) delete env.LDBA_SKIP_POLICY;
  else env.LDBA_SKIP_POLICY = skipPolicy;
  const result = run(process.execPath, [runnerPath, mode], { cwd: payloadRoot, env });
  let report = null;
  if (result.stdout) {
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error('runner output was not a JSON report: ' + result.stdout + result.stderr);
    }
  }
  process.stdout.write('RUNNER ' + adapterName + ' ' + mode + ' policy=' + (skipPolicy || 'default')
    + ' exit=' + result.status + ' status=' + (report && report.status || '<none>') + '\n');
  if (report) process.stdout.write('RUNNER_REPORT ' + adapterName + ' ' + mode + ' ' + JSON.stringify(report) + '\n');
  if (result.stderr) process.stderr.write('RUNNER_STDERR_BEGIN\n' + result.stderr + 'RUNNER_STDERR_END\n');
  return { result, report };
}

async function targetCounts(pool) {
  const counts = {};
  for (const entity of DESTINATION_ENTITIES) {
    const result = await pool.query('SELECT count(*)::int AS count FROM ' + quoteIdentifier(entity));
    counts[entity] = Number(result.rows[0].count);
    process.stdout.write('TARGET_ROWS ' + entity + '=' + counts[entity] + '\n');
  }
  return counts;
}

async function inContainerMain() {
  const payloadRoot = path.resolve(__dirname, '..');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required inside the disposable container');
  const Pool = require('pg').Pool;
  const pool = new Pool({ connectionString, max: 2, allowExitOnIdle: true, idleTimeoutMillis: 1000 });
  try {
    const tests = run(process.execPath, ['--test', path.join(payloadRoot, 'tests', 'ldba-03-runner-skip.test.cjs')], { cwd: payloadRoot });
    process.stdout.write('OFFLINE_TEST_EXIT=' + tests.status + '\n');
    if (tests.stdout) process.stdout.write('OFFLINE_TEST_STDOUT_BEGIN\n' + tests.stdout + 'OFFLINE_TEST_STDOUT_END\n');
    if (tests.stderr) process.stderr.write('OFFLINE_TEST_STDERR_BEGIN\n' + tests.stderr + 'OFFLINE_TEST_STDERR_END\n');
    requireSuccess(tests, 'offline runner skip test');

    const migrationResult = await applyMigrations(pool, payloadRoot);
    process.stdout.write('MIGRATIONS orchestrator=' + migrationResult.orchestrator
      + ' connector=' + migrationResult.connector
      + ' target_tables=' + migrationResult.tables
      + ' schema_migrations=' + migrationResult.orchestratorLedger
      + ' connector_schema_migrations=' + migrationResult.connectorLedger + '\n');
    assert.deepEqual(migrationResult, {
      orchestrator: 38,
      connector: 9,
      tables: 34,
      orchestratorLedger: 38,
      connectorLedger: 9,
    });
    const tenantId = await seedTargetReferences(pool);
    process.stdout.write('SYNTHETIC_TENANT legacy-default resolved_uuid=' + tenantId + '\n');
    const sourceCounts = await seedLegacySources(pool);
    let totalSourceRows = 0;
    for (const [table, count] of Object.entries(sourceCounts)) {
      process.stdout.write('SOURCE_ROWS ' + table + '=' + count + '\n');
      totalSourceRows += count;
    }
    process.stdout.write('SOURCE_ROWS total=' + totalSourceRows + '\n');

    const before = await targetCounts(pool);
    assert.deepEqual(before, Object.fromEntries(DESTINATION_ENTITIES.map((entity) => [entity, 0])));

    const fixturePreflight = runRunner(payloadRoot, 'ldba-09-skip-fixture-adapter.cjs', '--preflight', 'report');
    requireSuccess(fixturePreflight.result, 'fixture adapter preflight');
    assert.equal(fixturePreflight.report.status, 'PREFLIGHT_READY');
    assertReportSkips(fixturePreflight.report);
    assert.equal(fixturePreflight.report.workflowDuplicates.length, 1);
    assert.equal(fixturePreflight.report.workflowDuplicates[0].winner, 'wb_schema:analyze');
    assert.equal(fixturePreflight.report.workflowDuplicates[0].skipped, 'wb_schema:analyze');
    assert.equal(JSON.stringify(fixturePreflight.report.workflowDuplicates).includes('undefined'), false);
    process.stdout.write('FIXTURE_PREFLIGHT_READY\n');

    const fixtureExecute = runRunner(payloadRoot, 'ldba-09-skip-fixture-adapter.cjs', '--execute', 'report');
    requireSuccess(fixtureExecute.result, 'fixture adapter first execute');
    assert.equal(fixtureExecute.report.status, 'APPLIED');
    assertReportSkips(fixtureExecute.report);
    assert(fixtureExecute.report.preflight.every((item) => item.result === 'new'));
    process.stdout.write('FIXTURE_APPLIED_FIRST\n');

    const fixtureReplay = runRunner(payloadRoot, 'ldba-09-skip-fixture-adapter.cjs', '--execute', 'report');
    requireSuccess(fixtureReplay.result, 'fixture adapter idempotent execute');
    assert.equal(fixtureReplay.report.status, 'APPLIED');
    assertReportSkips(fixtureReplay.report);
    assert(fixtureReplay.report.preflight.every((item) => item.result === 'identical'));
    process.stdout.write('FIXTURE_APPLIED_REPLAY_ALL_IDENTICAL\n');

    const after = await targetCounts(pool);
    assert.deepEqual(after, EXPECTED_TARGET_COUNTS);
    for (const entity of DESTINATION_ENTITIES) {
      process.stdout.write('SOURCE_TARGET entity=' + entity + ' target=' + after[entity] + '\n');
    }

    const failPolicy = runRunner(payloadRoot, 'ldba-09-skip-fixture-adapter.cjs', '--preflight', 'fail');
    assert.equal(failPolicy.result.status, 1);
    assert.equal(failPolicy.report.status, 'BLOCKED_SKIPPED_ROWS');
    assertReportSkips(failPolicy.report);
    process.stdout.write('FIXTURE_FAIL_POLICY_BLOCKED\n');

    const productionPreflight = runRunner(payloadRoot, 'ldba-03-production-adapter.cjs', '--preflight', null);
    assert.equal(productionPreflight.result.status, 1);
    assert.equal(productionPreflight.report.status, 'BLOCKED_TRANSFORM');
    assert.equal(productionPreflight.report.failures.some((item) => item.table === 'ExternalApiOverride' && item.code === 'INVALID_UUID'), false);
    assert.equal(productionPreflight.report.failures.some((item) => item.table === 'User' && item.code === 'TRANSFORM_ERROR'), false);
    assert(productionPreflight.report.skips.filter((item) => item.table === 'User' && item.code === 'IDENTITY_PENDING_REHASH').length === 3);
    assert(productionPreflight.report.failures.some((item) => item.table === 'ExternalApiConnection' && item.code === 'TRANSFORM_ERROR'));
    assert(productionPreflight.report.failures.some((item) => item.table === 'ProfileEndpoint' && item.code === 'TRANSFORM_ERROR'));
    assert(productionPreflight.report.failures.some((item) => item.table === 'AppSetting' && item.code === 'TRANSFORM_ERROR'));
    assert(productionPreflight.report.failures.some((item) => item.table === 'FileCache' && item.code === 'TRANSFORM_ERROR'));
    process.stdout.write('LDBA08_REGRESSION_EXPECTED_CONTEXT_FAILURES\n');
    process.stdout.write('HARNESS_PASS disposable_pg16=1 network=none tmpfs=1 published_ports=0\n');
  } finally {
    await pool.end();
  }
}

function hostMain() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ldba09-rehearsal-'));
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedTempBase = path.resolve(os.tmpdir()) + path.sep;
  if (!resolvedTempRoot.startsWith(resolvedTempBase)) throw new Error('temporary payload escaped operating system temp');
  const payloadRoot = path.join(tempRoot, 'payload');
  const containerName = 'du-ldba09-pg16-' + Date.now() + '-' + process.pid;
  let containerCreated = false;
  let exitCode = 1;
  try {
    requireSuccess(run('docker', ['image', 'inspect', PG_IMAGE, NODE_IMAGE]), 'verify local rehearsal images');
    const payload = copyPayload(payloadRoot, tempRoot);
    const created = run('docker', [
      'run', '-d',
      '--name', containerName,
      '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=768m',
      '--env', 'POSTGRES_PASSWORD=' + DATABASE_PASSWORD,
      '--env', 'POSTGRES_DB=' + DATABASE_NAME,
      PG_IMAGE,
    ]);
    requireSuccess(created, 'start disposable PostgreSQL 16 container');
    containerCreated = true;
    requireSuccess(run('docker', ['cp', payload.nodeHostPath, containerName + ':/tmp/ldba09-node']), 'copy Node runtime into disposable container');
    requireSuccess(run('docker', ['cp', payload.payloadRoot, containerName + ':/tmp/ldba09-payload']), 'copy synthetic harness payload into disposable container');
    requireSuccess(run('docker', ['exec', containerName, 'chmod', '+x', '/tmp/ldba09-node']), 'enable in-container Node runtime');

    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const probe = run('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', DATABASE_NAME]);
      if (probe.status === 0) {
        ready = true;
        break;
      }
      sleepSync(500);
    }
    if (!ready) throw new Error('disposable PostgreSQL did not become ready within 60 seconds');
    const connectionString = 'postgres://postgres:' + DATABASE_PASSWORD + '@127.0.0.1:5432/' + DATABASE_NAME;
    const inner = run('docker', [
      'exec',
      '--env', 'DATABASE_URL=' + connectionString,
      containerName,
      '/tmp/ldba09-node',
      '/tmp/ldba09-payload/scripts/ldba-09-harness.cjs',
      '--inside',
    ]);
    if (inner.stdout) process.stdout.write(inner.stdout);
    if (inner.stderr) process.stderr.write(inner.stderr);
    process.stdout.write('IN_CONTAINER_EXIT=' + inner.status + '\n');
    exitCode = inner.status === 0 ? 0 : inner.status || 1;
  } catch (error) {
    process.stderr.write('HARNESS_ERROR ' + (error && error.message || error) + '\n');
    exitCode = 1;
  } finally {
    if (containerCreated) {
      const removed = run('docker', ['rm', '--force', containerName]);
      if (removed.status !== 0) {
        process.stderr.write('CONTAINER_CLEANUP_FAILED exit=' + removed.status + '\n');
        exitCode = 1;
      } else {
        process.stdout.write('CONTAINER_REMOVED ' + containerName + '\n');
      }
    }
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

if (process.argv[2] === '--inside') {
  inContainerMain().catch((error) => {
    process.stderr.write('IN_CONTAINER_ERROR ' + (error && error.message || error) + '\n');
    process.exitCode = 1;
  });
} else {
  hostMain();
}
