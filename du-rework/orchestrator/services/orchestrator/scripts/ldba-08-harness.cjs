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
const DATABASE_NAME = 'du_ldba08_rehearsal';
const DATABASE_PASSWORD = 'ldba08-synthetic-only';
const SYNTHETIC_TENANT_ID = 'a0000000-0000-4000-8000-000000000001';
const API_KEY_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const OPERATION_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
];
const PROFILE_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
];
const USER_IDS = [
  '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
];
const FIXTURE_TIME = '2026-01-01T00:00:00Z';

const TIMESTAMP_FIELDS = new Set(['createdAt', 'updatedAt', 'deletedAt', 'webhookSentAt', 'lastAccessedAt', 'expiresAt']);
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

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error('fixture identifier rejected');
  }
  return QUOTE + value + QUOTE;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
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
  const scriptDirectory = path.join(payloadRoot, 'scripts');
  const migrationDirectory = path.join(payloadRoot, 'migrations');
  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.mkdirSync(path.join(migrationDirectory, 'orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(migrationDirectory, 'connector'), { recursive: true });
  const packageRootPath = path.resolve(__dirname, '..');
  const orchestratorRoot = path.resolve(packageRootPath, '../..');
  const nodeModulesPath = path.join(payloadRoot, 'node_modules');
  const copied = new Set();
  const pgEntry = require.resolve('pg');
  copyPackage('pg', createRequire(pgEntry), nodeModulesPath, copied);
  for (const filename of [
    'ldba-03-backfill.cjs',
    'ldba-03-production-adapter.cjs',
    'ldba-08-harness.cjs',
  ]) {
    fs.copyFileSync(path.join(packageRootPath, 'scripts', filename), path.join(scriptDirectory, filename));
  }
  for (const [sourceDirectory, destinationDirectory] of [
    [path.join(packageRootPath, 'migrations'), path.join(migrationDirectory, 'orchestrator')],
    [path.join(orchestratorRoot, 'services', 'connector', 'src', 'db', 'migrations'), path.join(migrationDirectory, 'connector')],
  ]) {
    for (const filename of fs.readdirSync(sourceDirectory).filter((name) => name.endsWith('.sql'))) {
      fs.copyFileSync(path.join(sourceDirectory, filename), path.join(destinationDirectory, filename));
    }
  }
  const nodeSourceContainer = 'du-ldba08-node-src-' + process.pid;
  const nodeHostPath = path.join(tempRoot, 'node-linux');
  const create = run('docker', ['create', '--network', 'none', '--name', nodeSourceContainer, NODE_IMAGE]);
  requireSuccess(create, 'create local Node image container');
  try {
    requireSuccess(run('docker', ['cp', nodeSourceContainer + ':/usr/local/bin/node', nodeHostPath]), 'copy Node runtime');
  } finally {
    run('docker', ['rm', '--force', nodeSourceContainer]);
  }
  return { nodeHostPath };
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
    pipelineJson: JSON.stringify({ kind: 'ldba08-synthetic', index }),
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
  const plainHttp = index === 2;
  return {
    id: 'legacy-connector-' + index,
    name: 'Synthetic connector ' + index,
    slug: 'synthetic-connector-' + index,
    description: null,
    endpointUrl: (plainHttp ? 'http://' : 'https://') + 'connector-' + index + '.example.test/api',
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
  return {
    Operation: [fixtureOperation(0), fixtureOperation(1)],
    ApiKey: [fixtureApiKey(0), fixtureApiKey(1)],
    ExternalApiConnection: [fixtureConnector(0), fixtureConnector(1), fixtureConnector(2)],
    ExternalApiOverride: [0, 1].map((index) => ({
      id: '40000000-0000-4000-8000-00000000000' + (index + 1),
      connectionId: 'legacy-connector-' + index,
      apiKeyId: API_KEY_IDS[index],
      endpointSlug: 'analyze',
      stepId: '_default',
      promptOverride: 'synthetic override ' + index,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    })),
    ProfileEndpoint: [fixtureProfile(0), fixtureProfile(1)],
    AppSetting: [0, 1].map((index) => ({
      key: 'wb_schema:analyze',
      value: JSON.stringify({ slug: 'analyze', nodes: [], fixtureRevision: index }),
      updatedAt: index === 0 ? '2026-01-01T00:00:00Z' : '2026-01-02T00:00:00Z',
    })),
    FileCache: objectBytes.map((bytes, index) => ({
      id: '70000000-0000-4000-8000-00000000000' + (index + 1),
      md5Hash: crypto.createHash('md5').update(bytes).digest('hex'),
      s3Key: 'synthetic/cache/object-' + index,
      size: bytes.length,
      mimeType: 'text/plain',
      fileName: 'synthetic-' + index + '.txt',
      refCount: 0,
      lastAccessedAt: null,
      createdAt: FIXTURE_TIME,
    })),
    User: [0, 1].map((index) => ({
      id: USER_IDS[index],
      username: 'synthetic-user-' + index,
      password: 'synthetic-bcrypt-verifier-' + index,
      role: index === 0 ? 'ADMIN' : 'USER',
      provider: null,
      providerSub: null,
      email: null,
      displayName: null,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    })),
    UserProfileAssignment: [0, 1].map((index) => ({
      id: '60000000-0000-4000-8000-00000000000' + (index + 1),
      userId: USER_IDS[index],
      apiKeyId: API_KEY_IDS[index],
      createdAt: FIXTURE_TIME,
    })),
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
  const files = fs.readdirSync(directory)
    .filter((name) => pattern.test(name))
    .sort();
  if (files.length !== expectedCount) {
    throw new Error('expected ' + expectedCount + ' migration files, found ' + files.length);
  }
  return files;
}

async function applyMigrations(pool, root) {
  const orchestratorDirectory = path.join(root, 'migrations', 'orchestrator');
  const connectorDirectory = path.join(root, 'migrations', 'connector');
  const orchestratorFiles = listMigrations(orchestratorDirectory, /^\d{4}_.+\.sql$/, 37);
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

async function inContainerMain() {
  const payloadRoot = path.resolve(__dirname, '..');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required inside the disposable container');
  const Pool = require('pg').Pool;
  const pool = new Pool({ connectionString, max: 2, allowExitOnIdle: true, idleTimeoutMillis: 1000 });
  try {
    const migrationResult = await applyMigrations(pool, payloadRoot);
    process.stdout.write('MIGRATIONS orchestrator=' + migrationResult.orchestrator
      + ' connector=' + migrationResult.connector
      + ' target_tables=' + migrationResult.tables
      + ' schema_migrations=' + migrationResult.orchestratorLedger
      + ' connector_schema_migrations=' + migrationResult.connectorLedger + '\n');
    const tenantId = await seedTargetReferences(pool);
    const sourceCounts = await seedLegacySources(pool);
    process.stdout.write('SYNTHETIC_TENANT legacy-default resolved_uuid=' + tenantId + '\n');
    let totalSourceRows = 0;
    for (const table of Object.keys(sourceCounts)) {
      process.stdout.write('SOURCE_ROWS ' + table + '=' + sourceCounts[table] + '\n');
      totalSourceRows += sourceCounts[table];
    }
    process.stdout.write('SOURCE_ROWS total=' + totalSourceRows + '\n');

    const adapterPath = path.join(payloadRoot, 'scripts', 'ldba-03-production-adapter.cjs');
    const adapter = require(adapterPath);
    const scanCounts = {};
    for (const table of require(path.join(payloadRoot, 'scripts', 'ldba-03-backfill.cjs')).LEGACY_TABLES) {
      scanCounts[table] = (await adapter.source.scan(table)).length;
    }
    await adapter.close();
    process.stdout.write('ADAPTER_SCAN all_nine_tables=' + Object.keys(scanCounts).length + '\n');

    const runnerPath = path.join(payloadRoot, 'scripts', 'ldba-03-backfill.cjs');
    const runner = run(process.execPath, [runnerPath, '--preflight'], {
      cwd: payloadRoot,
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        LDBA_A1_PASSED: '1',
        LDBA03_SOURCE_VERSION: 'synthetic-pg16-utc-2026-10-09',
        LDBA_A1_SOURCE_VERSION: 'synthetic-pg16-utc-2026-10-09',
        LDBA03_ADAPTER_MODULE: adapterPath,
      },
    });
    if (runner.stdout) process.stdout.write('RUNNER_PREFLIGHT_STDOUT_BEGIN\n' + runner.stdout + 'RUNNER_PREFLIGHT_STDOUT_END\n');
    if (runner.stderr) process.stderr.write('RUNNER_PREFLIGHT_STDERR_BEGIN\n' + runner.stderr + 'RUNNER_PREFLIGHT_STDERR_END\n');
    process.stdout.write('RUNNER_PREFLIGHT_EXIT=' + runner.status + '\n');
    for (const entity of DESTINATION_ENTITIES) {
      const count = await pool.query('SELECT count(*)::int AS count FROM ' + quoteIdentifier(entity));
      process.stdout.write('TARGET_ROWS ' + entity + '=' + Number(count.rows[0].count) + '\n');
    }
    if (runner.status !== 0) {
      process.stdout.write('HARNESS_STOPPED preflight did not produce PREFLIGHT_READY; no execute was attempted\n');
      process.exitCode = 3;
      return;
    }
    process.stdout.write('HARNESS_PREFLIGHT_READY\n');
  } finally {
    await pool.end();
  }
}

function hostMain() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ldba08-rehearsal-'));
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedTempBase = path.resolve(os.tmpdir()) + path.sep;
  if (!resolvedTempRoot.startsWith(resolvedTempBase)) throw new Error('temporary payload escaped the operating system temp directory');
  const payloadRoot = path.join(tempRoot, 'payload');
  const containerName = 'du-ldba08-pg16-' + Date.now() + '-' + process.pid;
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
    requireSuccess(run('docker', ['cp', payload.nodeHostPath, containerName + ':/tmp/ldba08-node']), 'copy Node runtime into PostgreSQL container');
    requireSuccess(run('docker', ['cp', payloadRoot, containerName + ':/tmp/ldba08-payload']), 'copy harness payload into PostgreSQL container');
    requireSuccess(run('docker', ['exec', containerName, 'chmod', '+x', '/tmp/ldba08-node']), 'enable in-container Node runtime');

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
      '/tmp/ldba08-node',
      '/tmp/ldba08-payload/scripts/ldba-08-harness.cjs',
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
