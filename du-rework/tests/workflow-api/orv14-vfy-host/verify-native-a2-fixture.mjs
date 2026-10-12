import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  cleanupHostInfrastructureFixture,
  createHostInfrastructureFixture,
  fixtureConnectionUrl,
} from './infrastructure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const BUILD_ROOT = process.argv[2];
const CONNECTOR_BUILD_ROOT = process.argv[3];
const PROVIDER_ORIGIN = process.argv[4];
if (!BUILD_ROOT || !path.isAbsolute(BUILD_ROOT) || !CONNECTOR_BUILD_ROOT || !path.isAbsolute(CONNECTOR_BUILD_ROOT)) {
  throw new Error('pass the exact private Orchestrator build root and exact prior private Connector migration-client build root');
}
let providerUrl;
try { providerUrl = new URL(PROVIDER_ORIGIN); } catch { throw new Error('pass the live loopback synthetic provider origin'); }
if (!['127.0.0.1', 'localhost', '[::1]'].includes(providerUrl.hostname) || !['http:', 'https:'].includes(providerUrl.protocol)) {
  throw new Error('provider origin must be loopback HTTP(S)');
}

const ORCH = path.join(ROOT, 'orchestrator/services/orchestrator');
const CONN = path.join(ROOT, 'orchestrator/services/connector');
const PRIVATE_ORCH = path.join(BUILD_ROOT, 'orchestrator/services/orchestrator');
const PRIVATE_CONN = path.join(CONNECTOR_BUILD_ROOT, 'orchestrator/services/connector');
const RAW_DIR = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
const orchRequire = createRequire(path.join(ORCH, 'package.json'));
const CONTEXT = path.join(ORCH, 'scripts/ldba-context-provider.cjs');
const ADAPTER = path.join(ORCH, 'scripts/ldba-03-production-adapter.cjs');
const BACKFILL = path.join(ORCH, 'scripts/ldba-03-backfill.cjs');
const ORCH_DDL = path.resolve(ROOT, '../drizzle/0000_violet_franklin_storm.sql');
const ORCH_DDL_EXTRA = path.resolve(ROOT, '../drizzle/0001_add-profile-endpoint-limits.sql');
const TS = orchRequire(path.join(ORCH, '../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript'));
const now = () => new Date().toISOString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = () => randomUUID();
const stamp = '2026-10-12 00:00:00.000';
const raw = {
  schema: 'orv14-native-a2-synthetic-fixture/v1',
  command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-native-a2-fixture.mjs ${BUILD_ROOT} ${CONNECTOR_BUILD_ROOT} ${PROVIDER_ORIGIN}`,
  cwd: ROOT,
  node: 'v24.21.0',
  verifierUid: process.getuid?.() ?? null,
  startedAt: now(),
  harnessSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  mockProviderHelperSha256: sha(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-provider.mjs'))),
  fixtureNamespace: null,
  stage: 'preflight',
  providerOrigin: PROVIDER_ORIGIN,
  sourceHashesBefore: {},
  sourceHashesAfter: {},
  migrationCounts: {},
  poolErrors: [],
  a2: { first: null, replay: null },
  externalEffects: { providerRequests: 0, paidProvider: false, customerSource: false, production: false },
  sharedDistWritten: false,
  productSourceWritten: false,
  retainedForNativeContinuityStep: false,
  cleanup: null,
  status: 'RUNNING',
};
let fixture;
let orchPool;
let connectorClient;
const { Pool } = orchRequire('pg');
const activePools = new Set();
const activeAdapterClosers = new Set();

function trackedPool(options) {
  const pool = new Pool(options);
  activePools.add(pool);
  pool.on('error', (error) => raw.poolErrors.push({ code: error?.code || null, message: error?.message || 'pool error' }));
  return pool;
}

async function closeTrackedPool(pool) {
  if (!activePools.delete(pool)) return;
  try { await pool.end(); }
  catch (error) { raw.poolErrors.push({ code: error?.code || null, message: error?.message || 'pool close error' }); }
}

async function closeAllPools() {
  await Promise.all([...activePools].map(closeTrackedPool));
}

function createTrackedAdapter(adapterModule, options) {
  const sourcePool = trackedPool({ connectionString: options.sourceConnectionString,
    application_name: 'orv14-vfy-host-native-a2-adapter-source', max: 2, idleTimeoutMillis: 1000, allowExitOnIdle: true });
  const targetPool = trackedPool({ connectionString: options.targetConnectionString,
    application_name: 'orv14-vfy-host-native-a2-adapter-target', max: 2, idleTimeoutMillis: 1000, allowExitOnIdle: true });
  const adapter = adapterModule.createAdapter({ ...options, Pool, sourcePool, targetPool });
  const originalClose = adapter.close.bind(adapter);
  const close = async () => {
    if (!activeAdapterClosers.delete(close)) return;
    activePools.delete(sourcePool);
    activePools.delete(targetPool);
    return originalClose();
  };
  adapter.close = close;
  activeAdapterClosers.add(close);
  return adapter;
}

async function closeAllAdapters() {
  await Promise.all([...activeAdapterClosers].map(async (close) => {
    try { await close(); }
    catch (error) { raw.poolErrors.push({ code: error?.code || null, message: error?.message || 'adapter close error' }); }
  }));
}

function envFromUrl(providerPort, fixtureSecrets) {
  const minimum = `synth-${randomBytes(24).toString('hex')}`;
  const connectorEncryptionKey = randomBytes(32).toString('base64');
  return {
    sourceVersion: `vfy-native19-${randomUUID()}`,
    namespace: `orv14-continuity-${randomBytes(8).toString('hex')}`,
    sourceSecret: minimum,
    connectorEncryptionKey,
    // A fresh value exists only in this synthetic source fixture and its
    // mode-0600 continuation state. The raw receipt records only its digest.
    apiKeyToken: `orv14-vfy-${randomBytes(24).toString('hex')}`,
    providerOrigin: providerPort,
    fixtureSecrets,
  };
}

function encryptSetting(value, sourceSecret) {
  const key = createHash('sha256').update(sourceSecret).digest();
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
  } finally { key.fill(0); iv.fill(0); }
}

async function applySqlFile(client, filename) {
  const sql = await readFile(filename, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) {
    await client.query(statement);
  }
  return sha(await readFile(filename));
}

async function copySqlDir(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const names = (await readdir(source)).filter(name => name.endsWith('.sql')).sort();
  const rows = [];
  for (const name of names) {
    const bytes = await readFile(path.join(source, name));
    await cp(path.join(source, name), path.join(destination, name));
    rows.push({ name, sha256: sha(bytes) });
  }
  return rows;
}

async function hashInputs() {
  const files = [
    ['orchestrator/src/db/migrations.ts', path.join(ORCH, 'src/db/migrations.ts')],
    ['connector/src/db/pg-client.ts', path.join(CONN, 'src/db/pg-client.ts')],
    ['orchestrator/scripts/ldba-03-backfill.cjs', BACKFILL],
    ['orchestrator/scripts/ldba-03-production-adapter.cjs', ADAPTER],
    ['orchestrator/scripts/ldba-context-provider.cjs', CONTEXT],
    ['orchestrator/scripts/ldba-inventory.cjs', path.join(ORCH, 'scripts/ldba-inventory.cjs')],
    ['orchestrator/scripts/ldba-continuity-plan.cjs', path.join(ORCH, 'scripts/ldba-continuity-plan.cjs')],
    ['orchestrator/scripts/ldba-continuity-source.cjs', path.join(ORCH, 'scripts/ldba-continuity-source.cjs')],
    ['orchestrator/scripts/ldba-continuity-runner.cjs', path.join(ORCH, 'scripts/ldba-continuity-runner.cjs')],
    ['orchestrator/scripts/ldba-continuity-runtime.cjs', path.join(ORCH, 'scripts/ldba-continuity-runtime.cjs')],
    ['orchestrator/src/app/bootstrap/create-app.ts', path.join(ORCH, 'src/app/bootstrap/create-app.ts')],
    ['orchestrator/src/modules/global-settings/service.ts', path.join(ORCH, 'src/modules/global-settings/service.ts')],
    ['legacy/0000_violet_franklin_storm.sql', ORCH_DDL],
    ['legacy/0001_add-profile-endpoint-limits.sql', ORCH_DDL_EXTRA],
    ['lib/settings.ts', path.resolve(ROOT, '../lib/settings.ts')],
    ['orchestrator/migrations/0064_cost_financial_adjustments.sql', path.join(ORCH, 'migrations/0064_cost_financial_adjustments.sql')],
    ['orchestrator/migrations/0065_cost_adjustment_object_pins.sql', path.join(ORCH, 'migrations/0065_cost_adjustment_object_pins.sql')],
    ['connector/migrations/015_backup_effect_fences.sql', path.join(CONN, 'src/db/migrations/015_backup_effect_fences.sql')],
  ];
  const out = {};
  for (const [name, filename] of files) out[name] = sha(await readFile(filename));
  return out;
}

async function findBuildReceipt(buildRoot) {
  const files = await readdir(RAW_DIR);
  for (const filename of await readdir(RAW_DIR)) {
    if (!filename.startsWith('native-scratch-build-') || !filename.endsWith('.json')) continue;
    const fullPath = path.join(RAW_DIR, filename);
    let receipt;
    try { receipt = JSON.parse(await readFile(fullPath, 'utf8')); }
    catch { continue; }
    if (receipt.scratchRoot === buildRoot && receipt.result === 'PASSED') {
      return { path: fullPath, sha256: sha(await readFile(fullPath)), receipt,
        qualification: 'full six-project private build with exact stable source manifest' };
    }
  }
  for (const filename of files) {
    if (!filename.startsWith('native-orchestrator-reemit-') || !filename.endsWith('.json')) continue;
    const fullPath = path.join(RAW_DIR, filename);
    let scoped;
    try { scoped = JSON.parse(await readFile(fullPath, 'utf8')); }
    catch { continue; }
    if (scoped.scratchRoot !== buildRoot || scoped.result !== 'SCOPED_ORCHESTRATOR_REEMIT_PASSED') continue;
    const priorPath = path.resolve(ROOT, scoped.priorBuildRawPath);
    let prior;
    try { prior = JSON.parse(await readFile(priorPath, 'utf8')); }
    catch { continue; }
    const changed = Object.entries(scoped.sourceHashesBefore || {})
      .filter(([file, value]) => prior.sourceHashesBefore?.[file] !== value)
      .map(([file, current]) => ({ file, previous: prior.sourceHashesBefore?.[file] ?? null, current }));
    const exactSingleMove = changed.length === 1
      && changed[0].file === 'orchestrator/services/orchestrator/src/modules/connectors/provider-test.ts'
      && changed[0].current === 'e36911e29c3d27027156c54c6ed6f8d40a145ea71a9df0ff2a1209cfe5691818';
    const allInitialProjectsCompiled = prior.projects?.length === 6 && prior.projects.every(project => project.exitCode === 0);
    const allOtherOutputsReused = ['contracts', 'egress', 'observability', 'worker-sdk', 'connector']
      .every(name => scoped.reusedProjectOutputEquality?.[name] === true);
    if (prior.result !== 'SOURCE_CHANGED_DURING_SNAPSHOT_BUILD' || !exactSingleMove
      || !allInitialProjectsCompiled || !allOtherOutputsReused || !scoped.sourceStableDuringReemit) continue;
    return {
      path: fullPath,
      sha256: sha(await readFile(fullPath)),
      receipt: scoped,
      qualification: 'prior six-project compile plus current Orchestrator-only reemit; sole changed source was frozen provider-test.ts; other five project outputs were hash-identical',
      priorPath,
      priorSha256: sha(await readFile(priorPath)),
    };
  }
  throw new Error(`no passed private build receipt pins ${buildRoot}`);
}

async function resolverQualification(currentPath, builtPath) {
  async function bodyHash(filename) {
    const text = await readFile(filename, 'utf8');
    const source = TS.createSourceFile(filename, text, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
    const declaration = source.statements.find(node => TS.isFunctionDeclaration(node)
      && node.name?.text === 'connectorBaseUrlResolver' && node.body);
    assert.ok(declaration?.body, `connectorBaseUrlResolver must exist in ${filename}`);
    return { fileSha256: sha(Buffer.from(text)), bodySha256: sha(Buffer.from(declaration.body.getText(source))) };
  }
  const current = await bodyHash(currentPath);
  const built = await bodyHash(builtPath);
  assert.equal(current.bodySha256, built.bodySha256, 'the exact resolver body imported by the CJS consumer must match current source');
  return { current, built, bodyUnchanged: true,
    qualification: 'CJS consumer calls only the pure exported connectorBaseUrlResolver; whole create-app composition is outside this slice' };
}

async function seedLegacySource(sourcePool, fixture, context) {
  const schemaClient = await sourcePool.connect();
  let ddlHashes;
  try {
    await schemaClient.query('BEGIN');
    ddlHashes = [await applySqlFile(schemaClient, ORCH_DDL), await applySqlFile(schemaClient, ORCH_DDL_EXTRA)];
    await schemaClient.query('COMMIT');
  } catch (error) { await schemaClient.query('ROLLBACK'); throw error; }
  finally { schemaClient.release(); }

  const root = path.join(fixture.root, 'legacy-objects');
  const operationId = id();
  const inputFileId = id();
  const outputFileId = id();
  const apiKeyId = id();
  const userId = id();
  const profileId = id();
  const activeConnectorId = id();
  const disabledConnectorId = id();
  const overrideId = id();
  const assignmentId = id();
  const inputKey = `${operationId}/upload-input.txt`;
  const outputKey = `${operationId}/report-output.txt`;
  const inputBytes = Buffer.from('synthetic uploaded source document for native continuity');
  const outputBytes = Buffer.from('synthetic historical report bytes for native continuity');
  for (const [key, bytes] of [[inputKey, inputBytes], [outputKey, outputBytes]]) {
    const destination = path.join(root, ...key.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  }

  const apiKeyHash = sha(Buffer.from(context.apiKeyToken, 'utf8'));
  await sourcePool.query(`INSERT INTO "ApiKey"
    ("id","name","keyHash","prefix","role","note","spendingLimit","totalUsed","status","createdAt","updatedAt")
    VALUES($1,$2,$3,$4,'ADMIN',$5,100,17,'active',$6,$6)`,
  [apiKeyId, 'Synthetic continuity key', apiKeyHash, context.apiKeyToken.slice(0, 8), 'fixture-only synthetic bearer', stamp]);

  const connectorValues = [
    { id: activeConnectorId, name: 'Synthetic active legacy connector', slug: 'legacy-active', path: '/legacy-active', state: 'ENABLED', authSecret: `legacy-secret-active-${randomBytes(8).toString('hex')}` },
    { id: disabledConnectorId, name: 'Synthetic retired legacy connector', slug: 'legacy-retired', path: '/legacy-retired', state: 'DISABLED', authSecret: `legacy-secret-retired-${randomBytes(8).toString('hex')}` },
  ];
  for (const connector of connectorValues) {
    await sourcePool.query(`INSERT INTO "ExternalApiConnection"
      ("id","name","slug","description","endpointUrl","httpMethod","authType","authKeyHeader","authSecret",
       "promptFieldName","fileFieldName","fileUrlFieldName","defaultPrompt","staticFormFields","extraHeaders",
       "responseContentPath","sessionIdResponsePath","sessionIdFieldName","timeoutSec","state","createdAt","updatedAt")
      VALUES($1,$2,$3,$4,$5,'POST','API_KEY_HEADER','x-vfy-credential',$6,'query','',NULL,$7,'[]','{}','content',NULL,NULL,30,$8,$9,$9)`,
    [connector.id, connector.name, connector.slug, 'synthetic fixture mapping', `${context.providerOrigin}${connector.path}`,
      connector.authSecret, 'Synthetic legacy prompt', connector.state, stamp]);
  }

  await sourcePool.query(`INSERT INTO "ExternalApiOverride"
    ("id","connectionId","apiKeyId","endpointSlug","stepId","promptOverride","createdAt","updatedAt")
    VALUES($1,$2,$3,'extract','primary',$4,$5,$5)`,
  [overrideId, activeConnectorId, apiKeyId, 'synthetic override prompt', stamp]);

  await sourcePool.query(`INSERT INTO "ProfileEndpoint"
    ("id","apiKeyId","endpointSlug","enabled","parameters","connectionsOverride","jobPriority",
     "fileUrlAuthConfig","allowedFileExtensions","createdAt","updatedAt")
    VALUES($1,$2,'extract',true,$3,$4,'HIGH',NULL,'txt',$5,$5)`,
  [profileId, apiKeyId, JSON.stringify({ query: 'synthetic historical query' }),
    JSON.stringify([{ slug: 'legacy-active', stepId: 'primary' }]), stamp]);

  await sourcePool.query(`INSERT INTO "FileCache"
    ("id","md5Hash","s3Key","fileName","mimeType","size","refCount","createdAt","lastAccessedAt")
    VALUES($1,$2,$3,'upload-input.txt','text/plain',$4,1,$5,$5),($6,$7,$8,'report-output.txt','text/plain',$9,1,$5,$5)`,
  [inputFileId, createHash('md5').update(inputBytes).digest('hex'), inputKey, inputBytes.length, stamp,
    outputFileId, createHash('md5').update(outputBytes).digest('hex'), outputKey, outputBytes.length]);

  await sourcePool.query(`INSERT INTO "Operation"
    ("id","apiKeyId","createdByUserId","idempotencyKey","done","state","progressPercent","progressMessage",
     "endpointSlug","pipelineJson","currentStep","failedAtStep","filesJson","outputFormat","outputContent",
     "outputFilePath","extractedData","stepsResultJson","totalInputTokens","totalOutputTokens","pagesProcessed",
     "modelUsed","totalCostUsd","usageBreakdown","webhookUrl","webhookSentAt","errorCode","errorMessage",
     "filesDeleted","createdAt","updatedAt","deletedAt")
    VALUES($1,$2,$3,'synthetic-historical-submit',true,'SUCCEEDED',100,'fixture complete','extract',$4,1,NULL,$5,
      'text',$6,$7,$8,$9,12,7,1,'orv14-vfy-model',0.004,$10,$11,NULL,NULL,NULL,false,$12,$12,NULL)`,
  [operationId, apiKeyId, userId,
    JSON.stringify({ steps: [{ id: 'extract', connector: 'legacy-active' }] }),
    JSON.stringify([{ fileCacheId: inputFileId, s3Key: inputKey }]), 'synthetic historical operation result', outputKey,
    JSON.stringify({ result: 'synthetic extracted fact' }),
    JSON.stringify([{ step: 'extract', state: 'SUCCEEDED', result: 'synthetic' }]),
    JSON.stringify({ prompt_tokens: 12, completion_tokens: 7 }), `${context.providerOrigin}/callback`, stamp]);

  await sourcePool.query(`INSERT INTO "User"
    ("id","username","password","role","provider","providerSub","email","displayName","createdAt","updatedAt")
    VALUES($1,'vfy.local','synthetic-source-bcrypt-is-never-copied','ADMIN',NULL,NULL,'vfy@example.invalid',
      'Synthetic Local Admin',$2,$2)`, [userId, stamp]);
  await sourcePool.query(`INSERT INTO "UserProfileAssignment" ("id","userId","apiKeyId","createdAt") VALUES($1,$2,$3,$4)`,
    [assignmentId, userId, apiKeyId, stamp]);

  const settingsSource = await readFile(path.resolve(ROOT, '../lib/settings.ts'), 'utf8');
  const { extractLegacyDefaults } = orchRequire(path.join(ORCH, 'scripts/ldba-continuity-plan.cjs'));
  const defaults = extractLegacyDefaults(settingsSource);
  const sourceSecret = context.sourceSecret;
  const values = {
    ...defaults,
    ai_provider: 'openai-compatible',
    ai_model: 'orv14-vfy-model',
    ai_api_key: `unused-gemini-synthetic-${randomBytes(12).toString('hex')}`,
    openai_api_key: `synthetic-openai-${randomBytes(12).toString('hex')}`,
    openai_base_url: `${context.providerOrigin}/v1`,
    api_secret_key: `retired-api-secret-${randomBytes(12).toString('hex')}`,
    // The source fixture maps to the isolated restore MinIO endpoint so that
    // the authenticated application read can be repeated after source MinIO
    // is stopped. This URL is synthetic and never points at an external host.
    s3_endpoint: fixture.urls.s3Restore,
    s3_bucket: `orv14-vfy-${randomBytes(8).toString('hex')}`,
    s3_access_key: fixture.credentials.s3AccessKey,
    s3_secret_key: fixture.credentials.s3SecretKey,
    s3_region: 'us-east-1',
    s3_cache_ttl_hours: '24',
    docx_conversion_mode: 'legacy-docx-mode',
    docx_intermediate_format: 'legacy-text-format',
  };
  const encryptedKeys = new Set(['ai_api_key', 'openai_api_key', 'api_secret_key', 's3_access_key', 's3_secret_key']);
  const settings = Object.entries(values);
  assert.equal(settings.length, 19, 'synthetic fixture must contain all 16 functional and 3 retired setting rows');
  for (const [key, rawValue] of settings) {
    const value = encryptedKeys.has(key) ? encryptSetting(rawValue, sourceSecret) : rawValue;
    await sourcePool.query(`INSERT INTO "AppSetting" ("id","key","value","updatedAt") VALUES($1,$2,$3,$4)`,
      [`vfy-${context.sourceVersion}-${key}`, key, value, stamp]);
  }
  return {
    ddlHashes,
    sourceObjectRoot: root,
    sourceRows: {
      operationId, inputFileId, outputFileId, apiKeyId, userId, profileId,
      activeConnectorId, disabledConnectorId, overrideId, assignmentId,
      sourceSecret, settingsKeys: settings.map(([key]) => key).sort(),
      apiKeyToken: context.apiKeyToken,
      activeConnectorSecretSha256: sha(Buffer.from(connectorValues[0].authSecret)),
      disabledConnectorSecretSha256: sha(Buffer.from(connectorValues[1].authSecret)),
      inputBytesSha256: sha(inputBytes), outputBytesSha256: sha(outputBytes),
      s3Bucket: values.s3_bucket,
    },
  };
}

function migrationDb(pool) {
  return {
    query: (sql, values = []) => pool.query(sql, values),
    async tx(work) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
}

function runA2(env, mode) {
  const result = spawnSync(NODE, [BACKFILL, mode], {
    cwd: ORCH,
    env: {
      PATH: process.env.PATH || '',
      LDBA03_ADAPTER_MODULE: ADAPTER,
      LDBA03_CONTEXT_MODULE: CONTEXT,
      LDBA03_SOURCE_DATABASE_URL: env.sourceUrl,
      LDBA03_TARGET_DATABASE_URL: env.targetUrl,
      LDBA03_CONNECTOR_TARGET_DATABASE_URL: env.connectorTargetUrl,
      LDBA03_SOURCE_SCHEMA: 'public',
      LDBA03_SOURCE_VERSION: env.sourceVersion,
      LDBA_A1_PASSED: '1',
      LDBA_A1_SOURCE_VERSION: env.sourceVersion,
      LDBA03_TIMEZONE_EVIDENCE_FILE: env.timezoneEvidenceFile,
      LDBA03_TIMEZONE_EVIDENCE_SHA256: env.timezoneEvidenceSha256,
      LDBA03_FILECACHE_OBJECT_DIR: env.sourceObjectRoot,
      LDBA_SKIP_POLICY: 'fail',
      CONNECTOR_ENCRYPTION_KEY: env.connectorEncryptionKey,
    },
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`A2 child could not start: ${result.error.message}`);
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error(`A2 returned non-JSON output (exit ${result.status}): ${(result.stderr || result.stdout).slice(0, 1200)}`); }
  return { exitCode: result.status, report, stderr: (result.stderr || '').slice(0, 1200) };
}

async function main() {
  if (process.execPath !== NODE || process.getuid?.() !== 1000) throw new Error('run with pinned Node 24.21.0 as UID 1000');
  await mkdir(RAW_DIR, { recursive: true });
  raw.sourceHashesBefore = await hashInputs();
  fixture = await createHostInfrastructureFixture();
  raw.fixtureNamespace = fixture.projectId;
  raw.composeFileSha256 = fixture.composeSha256;
  raw.imageIds = fixture.imageIds;
  raw.stage = 'fresh restore database validation';
  assert.equal(providerUrl.hostname === '127.0.0.1' || providerUrl.hostname === 'localhost' || providerUrl.hostname === '[::1]', true);

  const context = envFromUrl(PROVIDER_ORIGIN, fixture.credentials);
  const sourceUrl = fixtureConnectionUrl(fixture.postgres.orchestratorSource);
  const targetUrl = fixtureConnectionUrl(fixture.postgres.orchestratorRestore);
  const connectorTargetUrl = fixtureConnectionUrl(fixture.postgres.connectorRestore);
  orchPool = trackedPool({ connectionString: targetUrl, application_name: 'orv14-vfy-host-native-a2-orch', max: 4 });
  const initial = await orchPool.query("SELECT current_setting('cluster_name') AS cluster,to_regclass('public.schema_migrations') AS ledger");
  assert.equal(initial.rows[0]?.cluster, fixture.postgres.orchestratorRestore.clusterName);
  assert.equal(initial.rows[0]?.ledger, null);

  const orchestratorMigrations = path.join(ORCH, 'migrations');
  const connectorMigrations = path.join(CONN, 'src/db/migrations');
  const privateMigrationModule = path.join(PRIVATE_ORCH, 'dist/db/migrations.js');
  const connectorMigrationClientModule = path.join(PRIVATE_CONN, 'dist/db/pg-client.js');
  const isolatedMigrationModule = path.join(fixture.root, 'compiled-orchestrator/dist/db/migrations.js');
  await mkdir(path.dirname(isolatedMigrationModule), { recursive: true, mode: 0o700 });
  await cp(privateMigrationModule, isolatedMigrationModule);
  const isolatedMigrationRoot = path.join(fixture.root, 'compiled-orchestrator');
  const orchSql = await copySqlDir(orchestratorMigrations, path.join(isolatedMigrationRoot, 'migrations'));
  const connMigrationScratch = path.join(fixture.root, 'connector-migrations');
  const connSql = await copySqlDir(connectorMigrations, connMigrationScratch);
  const orchestratorBuildReceipt = await findBuildReceipt(BUILD_ROOT);
  const connectorBuildReceipt = await findBuildReceipt(CONNECTOR_BUILD_ROOT);
  raw.privateBuildInputs = {
    orchestratorRoot: BUILD_ROOT,
    orchestratorBuildReceipt: path.relative(ROOT, orchestratorBuildReceipt.path),
    orchestratorBuildReceiptSha256: orchestratorBuildReceipt.sha256,
    orchestratorBuildQualification: orchestratorBuildReceipt.qualification,
    orchestratorPriorBuildReceipt: orchestratorBuildReceipt.priorPath ? path.relative(ROOT, orchestratorBuildReceipt.priorPath) : null,
    orchestratorPriorBuildReceiptSha256: orchestratorBuildReceipt.priorSha256 || null,
    compiledMigrationModuleSha256: sha(await readFile(privateMigrationModule)),
    connectorRoot: CONNECTOR_BUILD_ROOT,
    connectorBuildReceipt: path.relative(ROOT, connectorBuildReceipt.path),
    connectorBuildReceiptSha256: connectorBuildReceipt.sha256,
    connectorBuildQualification: connectorBuildReceipt.qualification,
    connectorPriorBuildReceipt: connectorBuildReceipt.priorPath ? path.relative(ROOT, connectorBuildReceipt.priorPath) : null,
    connectorPriorBuildReceiptSha256: connectorBuildReceipt.priorSha256 || null,
    connectorPgSqlClientModuleSha256: sha(await readFile(connectorMigrationClientModule)),
    connectorPgSqlClientSourceSha256: raw.sourceHashesBefore['connector/src/db/pg-client.ts'],
    use: 'current compiled Orchestrator migration runner; exact unchanged Connector PgSqlClient migration runner only; no Connector runtime or fence module loaded',
  };
  raw.migrationSource = { orchestrator: orchSql, connector: connSql,
    compiledOrchestratorMigrationModuleSha256: raw.privateBuildInputs.compiledMigrationModuleSha256,
    migrationModuleIsolatedUnderFixtureRoot: true };
  const migrationModule = orchRequire(isolatedMigrationModule);
  raw.stage = 'apply and verify current native migrations';
  const orchFirst = await migrationModule.migrate(migrationDb(orchPool));
  await migrationModule.verifyMigrations(migrationDb(orchPool));
  const connectorPool = trackedPool({ connectionString: connectorTargetUrl, application_name: 'orv14-vfy-host-native-a2-conn', max: 3 });
  try {
    const PgSqlClient = orchRequire(path.join(PRIVATE_CONN, 'dist/db/pg-client.js')).PgSqlClient;
    connectorClient = new PgSqlClient({ connectionString: connectorTargetUrl, application_name: 'orv14-vfy-host-native-a2-conn', max: 3,
      migrationDirectory: connMigrationScratch });
    await connectorClient.migrate();
    await connectorClient.migrate();
    const ledger = await connectorPool.query('SELECT version FROM connector_schema_migrations ORDER BY version');
    assert.equal(ledger.rows.length, connSql.length);
    assert.ok(ledger.rows.some(row => row.version === '015_backup_effect_fences'));
    raw.migrationCounts = { orchestratorFirstApplied: orchFirst.applied.length, orchestratorLedger: orchSql.length,
      connectorLedger: ledger.rows.length, connectorReplayCount: ledger.rows.length };
  } finally { await connectorClient?.close(); connectorClient = null; await closeTrackedPool(connectorPool); }
  await migrationModule.verifyMigrations(migrationDb(orchPool));
  const version = '1.0.0';
  raw.stage = 'seed isolated native business catalog';
  const businessId = `vfy-native19-${randomBytes(5).toString('hex')}`;
  const businessManifest = {
    contractVersion: '1',
    businessId,
    version,
    displayName: 'Synthetic Native19 Fixture',
    description: 'Synthetic fixture action for isolated migration verification',
    imageDigest: `sha256:${randomBytes(32).toString('hex')}`,
    runtime: { wireVersion: '1', handlerKinds: ['extract'] },
    capabilities: { cancel: false, resume: false, parallel: false },
    actions: [{
      name: 'extract', displayName: 'Synthetic extract', description: 'Synthetic continuity probe',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: true },
      profileSchema: { type: 'object', properties: {}, additionalProperties: true },
      connectorSlots: [{ name: 'primary', required: true, acceptedCapabilities: ['document-extraction'] }],
      artifactPolicy: { minFiles: 0, maxFiles: 0, acceptedMimeTypes: ['text/plain'] },
      capabilities: { cancel: false, resume: false }, defaultLimits: { timeoutSeconds: 60 },
    }],
  };
  const businessDigest = sha(Buffer.from(JSON.stringify(businessManifest)));
  await orchPool.query(`INSERT INTO business_versions (business_id,version,contract_version,manifest,digest,status,queue,is_active)
    VALUES($1,$2,'1',$3,$4,'ENABLED','synthetic',true)`, [businessId, version, JSON.stringify(businessManifest), businessDigest]);
  await orchPool.query('INSERT INTO business_catalog(business_id) VALUES($1)', [businessId]);

  const sourcePool = trackedPool({ connectionString: sourceUrl, application_name: 'orv14-vfy-host-native-a2-source', max: 3 });
  raw.stage = 'create synthetic legacy schema and seed all source fixture rows';
  const staged = await seedLegacySource(sourcePool, fixture, { ...context, providerOrigin: PROVIDER_ORIGIN });
  await closeTrackedPool(sourcePool);
  raw.stage = 'capture actual frozen legacy table snapshot and UTC evidence';
  const { TABLES } = orchRequire(path.join(ORCH, 'scripts/ldba-continuity-source.cjs'));
  const priorAdapterLibraryMode = process.env.LDBA03_ADAPTER_LIBRARY;
  process.env.LDBA03_ADAPTER_LIBRARY = '1';
  let adapterModule;
  try { adapterModule = orchRequire(ADAPTER); }
  finally {
    if (priorAdapterLibraryMode === undefined) delete process.env.LDBA03_ADAPTER_LIBRARY;
    else process.env.LDBA03_ADAPTER_LIBRARY = priorAdapterLibraryMode;
  }
  const scanAdapter = createTrackedAdapter(adapterModule, { env: {
    LDBA03_SOURCE_VERSION: context.sourceVersion,
    LDBA_A1_SOURCE_VERSION: context.sourceVersion,
    LDBA03_CONNECTOR_TARGET_DATABASE_URL: connectorTargetUrl,
    LDBA_A1_PASSED: '1',
  },
    sourceConnectionString: sourceUrl, targetConnectionString: targetUrl });
  const tables = Object.create(null);
  for (const table of TABLES) tables[table] = await scanAdapter.source.scan(table);
  const sourceSnapshot = scanAdapter.sourceSnapshot;
  const sourceDataSha256 = sha(Buffer.from(JSON.stringify(tables)));
  assert.equal(sourceSnapshot.sha256, sourceDataSha256);
  const observed = tables.AppSetting.find(row => row.key === 'ai_provider');
  const observedNaiveTimestamp = observed?.updatedAt;
  raw.sourceTimestampCheck = { expectedSqlLiteral: stamp, observedType: typeof observedNaiveTimestamp,
    observedValue: typeof observedNaiveTimestamp === 'string' ? observedNaiveTimestamp : null };
  assert.ok(observed && typeof observedNaiveTimestamp === 'string'
    && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(observedNaiveTimestamp));
  const observedUtcMilliseconds = Date.parse(observedNaiveTimestamp.replace(' ', 'T') + 'Z');
  const expectedUtcMilliseconds = Date.parse(stamp.replace(' ', 'T') + 'Z');
  assert.ok(Number.isFinite(observedUtcMilliseconds) && observedUtcMilliseconds === expectedUtcMilliseconds,
    'frozen source timestamp must equal the fixture’s known UTC SQL instant');
  const timezoneEvidence = {
    sourceVersion: context.sourceVersion,
    timezone: 'UTC',
    sourceDataSha256,
    reviewedBy: 'independent synthetic fixture timestamp verification',
    observations: [{ table: 'AppSetting', sourceKey: 'ai_provider', field: 'updatedAt', naive: observed.updatedAt,
      utc: new Date(expectedUtcMilliseconds).toISOString(), reference: 'fixture-created SQL timestamp pinned as UTC' }],
  };
  await scanAdapter.close();
  const timezoneEvidenceFile = path.join(fixture.root, 'synthetic-timezone-evidence.json');
  const timezoneBytes = Buffer.from(JSON.stringify(timezoneEvidence, null, 2) + '\n');
  await writeFile(timezoneEvidenceFile, timezoneBytes, { mode: 0o600, flag: 'wx' });
  const timezoneEvidenceSha256 = sha(timezoneBytes);
  const verifyAdapter = createTrackedAdapter(adapterModule, { env: {
    LDBA03_SOURCE_VERSION: context.sourceVersion,
    LDBA_A1_SOURCE_VERSION: context.sourceVersion,
    LDBA03_TIMEZONE_EVIDENCE_FILE: timezoneEvidenceFile,
    LDBA03_TIMEZONE_EVIDENCE_SHA256: timezoneEvidenceSha256,
    LDBA03_CONNECTOR_TARGET_DATABASE_URL: connectorTargetUrl,
    LDBA03_FILECACHE_OBJECT_DIR: staged.sourceObjectRoot,
    CONNECTOR_ENCRYPTION_KEY: context.connectorEncryptionKey,
    LDBA_A1_PASSED: '1',
  }, sourceConnectionString: sourceUrl, targetConnectionString: targetUrl });
  for (const table of TABLES) await verifyAdapter.source.scan(table);
  assert.equal(verifyAdapter.timezoneEvidence?.verified, true);
  await verifyAdapter.close();

  raw.stage = 'seed only legacy-default tenant name through the normal fenced adapter';
  const tenantSeedAdapter = createTrackedAdapter(adapterModule, { env: {
    LDBA03_SOURCE_VERSION: context.sourceVersion,
    LDBA_A1_SOURCE_VERSION: context.sourceVersion,
    LDBA03_CONNECTOR_TARGET_DATABASE_URL: connectorTargetUrl,
    LDBA_A1_PASSED: '1',
  }, sourceConnectionString: sourceUrl, targetConnectionString: targetUrl });
  const tenantBeforeSeed = await tenantSeedAdapter.sink.resolveTenantIdsByName('legacy-default');
  assert.deepEqual(tenantBeforeSeed, [], 'read-only A2 preflight requires no preexisting tenant rows');
  const seededTenantId = await tenantSeedAdapter.sink.seedTenantByName('legacy-default');
  const tenantAfterSeed = await tenantSeedAdapter.sink.resolveTenantIdsByName('legacy-default');
  assert.deepEqual(tenantAfterSeed, [seededTenantId]);
  raw.tenantSeed = { nameOnly: true, before: tenantBeforeSeed.length, after: tenantAfterSeed.length,
    generatedUuid: seededTenantId, transactionWasFencedByMigrationGate: true };
  await tenantSeedAdapter.close();

  const a2Env = { sourceUrl, targetUrl, connectorTargetUrl, sourceVersion: context.sourceVersion,
    timezoneEvidenceFile, timezoneEvidenceSha256, sourceObjectRoot: staged.sourceObjectRoot,
    connectorEncryptionKey: context.connectorEncryptionKey };
  raw.stage = 'run normal current A2 read-only preflight';
  const preflight = runA2(a2Env, '--preflight');
  raw.a2.preflight = { exitCode: preflight.exitCode, status: preflight.report.status,
    sourceRows: preflight.report.sourceRows, destinationRows: preflight.report.destinationRows,
    failures: preflight.report.failures || [] };
  assert.equal(preflight.exitCode, 0, preflight.stderr);
  assert.equal(preflight.report.status, 'PREFLIGHT_READY');

  raw.stage = 'run normal current A2 backfill first apply';
  const first = runA2(a2Env, '--execute');
  raw.a2.first = { exitCode: first.exitCode, status: first.report.status,
    sourceRows: first.report.sourceRows, destinationRows: first.report.destinationRows,
    perTable: first.report.perTable, sourceSnapshotSha256: first.report.sourceSnapshot?.sha256 || sourceSnapshot.sha256,
    omitted: first.report.omissions?.length, skipped: first.report.skips?.length, failures: first.report.failures || [] };
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(first.report.status, 'APPLIED');
  assert.equal(first.report.perTable.AppSetting.written, 19);
  assert.equal(first.report.perTable.Operation.written, 1);
  assert.equal(first.report.perTable.FileCache.written, 2);
  assert.equal(first.report.perTable.User.written, 1);
  assert.equal(first.report.perTable.UserProfileAssignment.written, 1);

  raw.stage = 'run exact A2 replay';
  const replay = runA2(a2Env, '--execute');
  raw.a2.replay = { exitCode: replay.exitCode, status: replay.report.status,
    sourceRows: replay.report.sourceRows, destinationRows: replay.report.destinationRows,
    perTable: replay.report.perTable, failures: replay.report.failures || [] };
  assert.equal(replay.exitCode, 0, replay.stderr);
  assert.equal(replay.report.status, 'APPLIED');

  raw.stage = 'verify import provenance and prepare Native19 continuation state';
  const tenant = await orchPool.query("SELECT id::text FROM tenants WHERE name='legacy-default' ORDER BY id");
  assert.equal(tenant.rows.length, 1);
  const secretState = {
    fixture,
    run: {
      buildRoot: BUILD_ROOT,
      connectorBuildRoot: CONNECTOR_BUILD_ROOT,
      sourceUrl, targetUrl, connectorTargetUrl,
      sourceVersion: context.sourceVersion,
      namespace: context.namespace,
      tenantId: tenant.rows[0].id,
      businessId, businessVersion: version, action: 'extract',
      sourceSecret: context.sourceSecret,
      connectorEncryptionKey: context.connectorEncryptionKey,
      timezoneEvidenceFile, timezoneEvidenceSha256,
      sourceObjectRoot: staged.sourceObjectRoot,
      providerOrigin: PROVIDER_ORIGIN,
      settingsKeys: staged.sourceRows.settingsKeys,
      syntheticIds: { ...staged.sourceRows, sourceSecret: undefined },
      sourceRowsSha256: sourceSnapshot.sha256,
      sourceRowCounts: sourceSnapshot.rowCounts,
      sourceDataSha256,
    },
  };
  const stateFile = path.join(fixture.root, 'native19-state.json');
  await writeFile(stateFile, JSON.stringify(secretState, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  raw.stateFile = stateFile;
  raw.a2.first.tenantId = tenant.rows[0].id;
  raw.a2.first.sourceVersion = context.sourceVersion;
  raw.a2.first.sourceSha256 = sourceSnapshot.sha256;
  raw.a2.first.sourceRowCounts = sourceSnapshot.rowCounts;
  raw.a2.first.timezoneEvidenceSha256 = timezoneEvidenceSha256;
  raw.a2.first.functionalSettings = 16;
  raw.a2.first.retiredSettings = 3;
  raw.a2.first.artifactBytes = { inputSha256: staged.sourceRows.inputBytesSha256, outputSha256: staged.sourceRows.outputBytesSha256 };
  raw.a2.first.connectorSourceRows = { active: 1, disabled: 1 };
  raw.a2.first.identity = { users: 1, assignments: 1, disabledUntilReset: true };
  raw.a2.first.apiKeyTokenSha256 = sha(Buffer.from(staged.sourceRows.apiKeyToken, 'utf8'));
  raw.externalEffects.providerRequests = (await fetch(`${PROVIDER_ORIGIN}/__stats`).then(response => response.json())).count;
  raw.sourceHashesAfter = await hashInputs();
  assert.deepEqual(raw.sourceHashesAfter, raw.sourceHashesBefore);
  raw.resolverQualification = await resolverQualification(
    path.join(ORCH, 'src/app/bootstrap/create-app.ts'),
    path.join(BUILD_ROOT, 'orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts'),
  );
  assert.equal(raw.externalEffects.providerRequests, 0, 'A2 preparation must not call the provider fixture');
  raw.status = 'PASSED_A2_PREPARATION';
  raw.retainedForNativeContinuityStep = true;
  raw.completedAt = now();
  raw.checks = { passed: 8, failed: 0, skipped: 0 };
}

try {
  await main();
} catch (error) {
  raw.status = 'FAILED';
  raw.error = String(error?.stack || error).slice(0, 5000);
} finally {
  try { await connectorClient?.close(); } catch { /* keep cleanup moving */ }
  await closeAllAdapters();
  await closeAllPools();
  try {
    const response = await fetch(`${PROVIDER_ORIGIN}/__stats`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`provider fixture stats returned ${response.status}`);
    raw.externalEffects.providerRequests = Number((await response.json()).count);
  } catch (error) {
    raw.externalEffects.providerStatsError = String(error?.message || error).slice(0, 300);
  }
  if (fixture && raw.status !== 'PASSED_A2_PREPARATION') {
    try { raw.cleanup = await cleanupHostInfrastructureFixture(fixture); }
    catch (error) { raw.cleanupError = String(error?.message || error).slice(0, 1200); raw.status = 'CLEANUP_FAILED'; }
  }
  raw.completedAt ??= now();
  await mkdir(RAW_DIR, { recursive: true });
  const out = path.join(RAW_DIR, `native-a2-fixture-${raw.fixtureNamespace || 'start-failed'}.json`);
  await writeFile(out, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: raw.status, fixtureNamespace: raw.fixtureNamespace,
    a2: { first: raw.a2.first?.status ?? null, replay: raw.a2.replay?.status ?? null },
    stateFile: raw.stateFile || null, cleanup: raw.cleanup,
    error: raw.error?.split('\n')[0] || null,
    rawReceipt: path.relative(ROOT, out) }, null, 2) + '\n');
}
if (raw.status !== 'PASSED_A2_PREPARATION') process.exitCode = 1;
