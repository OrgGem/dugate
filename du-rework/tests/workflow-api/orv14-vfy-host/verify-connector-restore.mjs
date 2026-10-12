import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupHostInfrastructureFixture,
  createHostInfrastructureFixture,
  fixtureConnectionUrl,
  stopOwnedService,
} from './infrastructure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONNECTOR = path.join(ROOT, 'orchestrator/services/connector');
const SOURCE = path.join(CONNECTOR, 'src');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const NODE_PATH = [path.join(ROOT, 'orchestrator/node_modules/.pnpm/node_modules'), path.join(ROOT, 'orchestrator/node_modules')].join(path.delimiter);
const NOW = () => new Date().toISOString();
const SOURCE_FILES = [
  'src/entrypoint.ts', 'src/isolated-mode.ts', 'src/composition.ts', 'src/lifecycle.ts',
  'src/http/server.ts', 'src/db/replica-runtime-controls.ts', 'src/db/pg-client.ts',
  'src/db/repository.ts', 'src/db/invocation-crypto.ts', 'src/vault/runtime.ts',
];
const ACTIVE = {
  fixture: null, child: null, database: null, servers: [], reportPath: null,
  startedAt: null, checks: [], sourceHashesAtBuild: null, scratchBuild: null,
  scratchBundle: null, importedContract: null, harnessHashes: null, sentinelProbe: null,
  sourceOff: null,
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashScratchJavaScriptBundle(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
    }
  }
  await walk(directory);
  files.sort((left, right) => left.localeCompare(right));
  const bundleHash = createHash('sha256');
  const manifest = [];
  for (const fullPath of files) {
    const relativePath = path.relative(directory, fullPath).split(path.sep).join('/');
    const bytes = await readFile(fullPath);
    const fileHash = digest(bytes);
    bundleHash.update(relativePath).update('\0').update(bytes).update('\0');
    manifest.push({ relativePath, sha256: fileHash, bytes: bytes.length });
  }
  return { sha256: bundleHash.digest('hex'), files: manifest };
}

function signToken(secret, claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function requestIdentity(env, scope) {
  return {
    authorization: `Bearer ${signToken(env.serviceSecret, {
      sub: 'orv14-host-verifier', aud: 'connector', scopes: [scope], exp: Math.floor(Date.now() / 1000) + 300,
    })}`,
    'x-service-scope': scope,
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function postVaultJson(address, token, route, body) {
  const response = await fetch(`${address}/v1/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vault-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`synthetic Vault setup endpoint ${route} returned HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}

async function getVaultJson(address, token, route) {
  const response = await fetch(`${address}/v1/${route}`, {
    method: 'GET',
    headers: { accept: 'application/json', 'x-vault-token': token },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`synthetic Vault setup endpoint ${route} returned HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}

async function configureSyntheticAppRole(fixture) {
  const roleName = `orv14-vfy-${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const token = fixture.credentials.vaultToken;
  await postVaultJson(fixture.urls.vaultRestore, token, 'sys/auth/approle', { type: 'approle' });
  await postVaultJson(fixture.urls.vaultRestore, token, `auth/approle/role/${roleName}`, {
    token_policies: ['default'],
    token_ttl: '15s',
    token_period: '15s',
    token_explicit_max_ttl: '60s',
    secret_id_ttl: '60s',
    secret_id_num_uses: 5,
  });
  const roleId = await getVaultJson(fixture.urls.vaultRestore, token, `auth/approle/role/${roleName}/role-id`);
  const secretId = await postVaultJson(fixture.urls.vaultRestore, token, `auth/approle/role/${roleName}/secret-id`, {});
  if (typeof roleId.data?.role_id !== 'string' || typeof secretId.data?.secret_id !== 'string') {
    throw new Error('synthetic Vault AppRole returned no IDs');
  }
  return { roleId: roleId.data.role_id, secretId: secretId.data.secret_id };
}

async function openVaultProxy(upstream, counters) {
  const proxy = createServer(async (request, response) => {
    const route = request.url ?? '/';
    if (route === '/v1/auth/approle/login') counters.login += 1;
    if (route === '/v1/auth/token/renew-self') counters.renew += 1;
    if (route.startsWith('/v1/secret/')) counters.kvReads += 1;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const name of ['content-type', 'accept', 'x-vault-token', 'x-vault-namespace']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const result = await fetch(new URL(route, upstream), {
        method: request.method,
        headers,
        ...(body.length ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      response.statusCode = result.status;
      const contentType = result.headers.get('content-type');
      if (contentType) response.setHeader('content-type', contentType);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.statusCode = 502;
      response.end();
    }
  });
  const port = await listen(proxy);
  return { proxy, address: `http://127.0.0.1:${port}` };
}

function check(name, condition, detail = {}) {
  if (!condition) ACTIVE.checks.push({ name, ...detail, status: 'failed' });
  assert.ok(condition, `failed: ${name}`);
  return { name, ...detail, status: 'passed' };
}

async function waitForConnector(url, child, childOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const reason = childOutput().replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`isolated Connector exited before ready (code ${child.exitCode}): ${reason}`);
    }
    try {
      const response = await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(700) });
      if (response.status === 200) return;
    } catch { /* keep probing the owned local listener until the bounded deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('isolated Connector did not become live within the startup deadline');
}

async function jsonRequest(baseUrl, route, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, body: parsed };
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (process.execPath !== NODE) throw new Error(`required Node 24.21 binary is ${NODE}`);
  if (process.getuid?.() !== 1000) throw new Error('the independent Connector process fixture must run as UID 1000');
  const fixture = await createHostInfrastructureFixture();
  ACTIVE.fixture = fixture;
  const projectId = fixture.projectId;
  const startedAt = NOW();
  ACTIVE.startedAt = startedAt;
  const rawDir = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
  await mkdir(rawDir, { recursive: true });
  const reportPath = path.join(rawDir, `connector-restore-${projectId}.json`);
  ACTIVE.reportPath = reportPath;
  const connectorBuild = path.join(fixture.workDir, 'connector-build');
  await mkdir(connectorBuild, { mode: 0o700 });
  ACTIVE.sourceHashesAtBuild = {};
  for (const relative of SOURCE_FILES) ACTIVE.sourceHashesAtBuild[relative] = digest(await readFile(path.join(CONNECTOR, relative)));
  ACTIVE.sourceHashesAtBuild['packages/contracts/src/connector-runtime-control.ts'] = digest(
    await readFile(path.join(ROOT, 'orchestrator/packages/contracts/src/connector-runtime-control.ts')),
  );
  ACTIVE.harnessHashes = {
    verifier: digest(await readFile(fileURLToPath(import.meta.url))),
    infrastructure: digest(await readFile(path.join(ROOT, 'tests/workflow-api/orv14-vfy-host/infrastructure.mjs'))),
    compose: fixture.composeSha256,
  };
  const contractRuntimePath = createRequire(path.join(CONNECTOR, 'package.json')).resolve('@du/contracts');
  ACTIVE.importedContract = {
    runtimePath: path.relative(ROOT, contractRuntimePath),
    runtimeSha256: digest(await readFile(contractRuntimePath)),
    declarationPath: path.relative(ROOT, path.join(path.dirname(contractRuntimePath), 'index.d.ts')),
    declarationSha256: digest(await readFile(path.join(path.dirname(contractRuntimePath), 'index.d.ts'))),
  };
  const tsc = createRequire(path.join(CONNECTOR, 'package.json')).resolve('typescript/bin/tsc');
  const tscResult = spawnSync(NODE, [tsc, '-p', path.join(CONNECTOR, 'tsconfig.json'), '--outDir', connectorBuild,
    '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'], {
    cwd: CONNECTOR,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH ?? ''}` },
  });
  ACTIVE.scratchBuild = {
    command: `${NODE} ${tsc} -p ${path.join(CONNECTOR, 'tsconfig.json')} --outDir ${connectorBuild} --declaration false --declarationMap false --sourceMap false`,
    exitCode: tscResult.status,
    output: (tscResult.stderr || tscResult.stdout || '').slice(0, 2500),
    outputUnderUniqueFixtureTemp: true,
  };
  if (tscResult.status !== 0) {
    throw new Error(`isolated scratch Connector build failed (${tscResult.status}): ${(tscResult.stderr || tscResult.stdout || '').slice(0, 2500)}`);
  }
  ACTIVE.scratchBundle = await hashScratchJavaScriptBundle(connectorBuild);

  const connectorRequire = createRequire(path.join(CONNECTOR, 'package.json'));
  process.env.NODE_PATH = NODE_PATH;
  Module._initPaths();
  const compiledRequire = createRequire(path.join(connectorBuild, 'entrypoint.js'));
  const { PgSqlClient } = compiledRequire('./db/pg-client.js');
  const { createInvocationFieldCrypto, createLocalInvocationKekProvider } = compiledRequire('./db/invocation-crypto.js');
  const { hashInvocationInput } = compiledRequire('./hash.js');
  const { AesCredentialCipher } = compiledRequire('./services.js');

  const connectorDbUrl = fixtureConnectionUrl(fixture.postgres.connectorRestore);
  const migrationDirectory = path.join(SOURCE, 'db/migrations');
  const setupDb = new PgSqlClient({ connectionString: connectorDbUrl, migrationDirectory });
  ACTIVE.database = setupDb;
  const migrationRowsBefore = await setupDb.migrate().then(async () =>
    (await setupDb.query('SELECT version FROM connector_schema_migrations ORDER BY version')).rows.map((row) => row.version));
  const connectorIdentity = {
    slot: 'green',
    runtimeIdentity: 'orv14-restore-connector-synthetic',
    replicaId: 'orv14-restore-connector-synthetic-1',
    revision: 'synthetic-restore-build-1',
    imageDigest: `registry.local/connector@sha256:${'d'.repeat(64)}`,
  };
  const operationId = randomUUID();
  const taskId = randomUUID();
  const tenantId = randomUUID();
  const connectorId = 'orv14-vfy-connector';
  const bindingSlot = 'primary';
  const keyRef = 'orv14-vfy-connector-kek';
  const kek = randomBytes(32);
  const credentialKey = randomBytes(32);
  const serviceSecret = randomBytes(32);
  const grantSecret = randomBytes(32);
  const usageSinkToken = randomBytes(32).toString('base64url');
  const invocationKeyConfig = {
    keyRef,
    activeVersion: 1,
    keys: { '1': kek.toString('base64') },
  };
  const fieldCrypto = createInvocationFieldCrypto(createLocalInvocationKekProvider({
    keyRef,
    activeVersion: 1,
    keysByVersion: invocationKeyConfig.keys,
  }), keyRef);
  const providerCounters = { provider: 0, usage: 0 };
  const detector = createServer((request, response) => {
    if (request.url === '/provider') providerCounters.provider += 1;
    if (request.url === '/usage') providerCounters.usage += 1;
    response.statusCode = 204;
    response.end();
  });
  ACTIVE.servers.push(detector);
  const detectorPort = await listen(detector);
  const appRole = await configureSyntheticAppRole(fixture);
  const vaultCounters = { login: 0, renew: 0, kvReads: 0 };
  const { proxy: vaultProxy, address: vaultProxyAddress } = await openVaultProxy(fixture.urls.vaultRestore, vaultCounters);
  ACTIVE.servers.push(vaultProxy);

  const runChecks = ACTIVE.checks;
  const preseedAt = new Date(Date.now() - 120_000).toISOString();
  await setupDb.query(
    `INSERT INTO connector_replica_runtime_controls
      (replica_id,slot,runtime_identity,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at)
     VALUES ($1,$2,$3,$4,$5,7,'DRAINING',$6,'-infinity'::timestamptz)`,
    [connectorIdentity.replicaId, connectorIdentity.slot, connectorIdentity.runtimeIdentity,
      connectorIdentity.revision, connectorIdentity.imageDigest, preseedAt],
  );
  const sentinelDriverValue = (await setupDb.query(
    'SELECT acknowledged_at FROM connector_replica_runtime_controls WHERE replica_id=$1',
    [connectorIdentity.replicaId],
  )).rows[0]?.acknowledged_at;
  ACTIVE.sentinelProbe = {
    seedSql: `INSERT INTO connector_replica_runtime_controls
  (replica_id,slot,runtime_identity,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at)
VALUES ($1,$2,$3,$4,$5,7,'DRAINING',$6,'-infinity'::timestamptz)`,
    startupSelectSql: `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at
  FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`,
    diagnosticSelectSql: 'SELECT acknowledged_at FROM connector_replica_runtime_controls WHERE replica_id=$1',
    driverType: typeof sentinelDriverValue,
    driverValueLabel: sentinelDriverValue === Number.NEGATIVE_INFINITY ? '-Infinity' : String(sentinelDriverValue),
    isNumericNegativeInfinity: sentinelDriverValue === Number.NEGATIVE_INFINITY,
  };

  const credential = `synthetic-secret-${randomUUID()}`;
  const cipher = new AesCredentialCipher(credentialKey);
  const encryptedCredential = cipher.encrypt(credential);
  await setupDb.query(
    `INSERT INTO connector_revisions
       (connector_id,revision,adapter,config,credential_ref,state,credential_source,tenant_id,created_at)
     VALUES ($1,1,'json-http',$2::jsonb,$3,'ACTIVE',$4::jsonb,'',$5)`,
    [connectorId, JSON.stringify({ baseUrl: `http://127.0.0.1:${detectorPort}`, path: '/provider', timeoutMs: 1000 }),
      'orv14-vfy-credential-ref', JSON.stringify({ kind: 'legacy-db', credentialRef: 'orv14-vfy-credential-ref' }), preseedAt],
  );
  await setupDb.query(
    `INSERT INTO secret_versions (id,credential_ref,encrypted_value,rotated_at)
     VALUES ($1,$2,$3,$4)`,
    [`orv14-vfy-secret-${randomUUID()}`, 'orv14-vfy-credential-ref', Buffer.from(encryptedCredential), preseedAt],
  );

  const invocationFacts = [];
  for (const [suffix, state, ownerReplicaId] of [
    ['unknown', 'UNKNOWN', 'connector-source-blue-1'],
    ['pending', 'PENDING', null],
  ]) {
    const invocationId = `orv14-vfy-history-${suffix}`;
    const deadlineAt = new Date(Date.now() + 300_000).toISOString();
    const localRequest = {
      contractVersion: '1', invocationId, tenantId, operationId, taskId,
      stepKey: `synthetic-${suffix}`, bindingSlot,
      input: { text: `synthetic ${suffix} invocation history` },
      deadlineAt, connectorId, connectorRevision: 1,
    };
    const inputHash = hashInvocationInput(localRequest);
    const grantClaims = {
      audience: 'connector', tenantId, operationId, taskId,
      stepKey: localRequest.stepKey, invocationId, inputHash,
      connectorId, connectorRevision: 1, bindingSlot,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    };
    const grant = signToken(grantSecret, grantClaims);
    const envelope = await fieldCrypto.seal(localRequest, {
      tenantId,
      slot: 'connector_invocations.request',
      refId: invocationId,
    });
    const pastPollAt = new Date(Date.now() - 60_000).toISOString();
    const pastLeaseAt = new Date(Date.now() - 30_000).toISOString();
    await setupDb.query(
      `INSERT INTO connector_invocations
        (invocation_id,tenant_id,operation_id,task_id,step_key,input_hash,request,state,
         provider_request_id,next_poll_at,poll_lease_token,poll_lease_expires_at,
         quota_lease_key,quota_lease_id,quota_lease_expires_at,owner_replica_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [invocationId, tenantId, operationId, taskId, localRequest.stepKey, inputHash, JSON.stringify(envelope), state,
        suffix === 'pending' ? 'synthetic-source-provider-request' : null,
        suffix === 'pending' ? pastPollAt : null,
        suffix === 'pending' ? 'synthetic-expired-poll-lease' : null,
        suffix === 'pending' ? pastLeaseAt : null,
        suffix === 'pending' ? 'synthetic-quota-key' : null,
        suffix === 'pending' ? 'synthetic-expired-quota-lease' : null,
        suffix === 'pending' ? pastLeaseAt : null,
        ownerReplicaId, preseedAt],
    );
    if (suffix === 'pending') {
      const usagePayload = {
        eventId: `${invocationId}:1`, invocationId, operationId, taskId,
        units: { inputTokens: 0, outputTokens: 0 }, costMicrousd: 0,
        currency: 'USD', measurement: 'estimated', occurredAt: preseedAt,
      };
      await setupDb.query(
        `INSERT INTO connector_usage_outbox (event_id,invocation_id,payload,delivered_at,attempts,next_attempt_at)
         VALUES ($1,$2,$3::jsonb,NULL,0,$4)`,
        [usagePayload.eventId, invocationId, JSON.stringify(usagePayload), pastPollAt],
      );
    }
    invocationFacts.push({ invocationId, state, localRequest, grant });
  }

  const schemaBefore = await setupDb.query('SELECT version,applied_at::text FROM connector_schema_migrations ORDER BY version');
  const beforeMigrations = schemaBefore.rows.map((row) => ({ version: row.version, appliedAt: row.applied_at }));
  const beforeRows = await setupDb.query(
    `SELECT invocation_id,state,owner_replica_id,next_poll_at::text,poll_lease_token,
            poll_lease_expires_at::text,quota_lease_key,quota_lease_id,quota_lease_expires_at::text
       FROM connector_invocations ORDER BY invocation_id`,
  );
  const beforeOutbox = await setupDb.query(
    `SELECT event_id,delivered_at::text,attempts,next_attempt_at::text,failed_attempts,last_failure_code
       FROM connector_usage_outbox ORDER BY event_id`,
  );
  const controlBeforeStart = (await setupDb.query(
    `SELECT control_revision,control_state,acknowledged_at::text FROM connector_replica_runtime_controls WHERE replica_id=$1`,
    [connectorIdentity.replicaId],
  )).rows[0];
  runChecks.push(check('pre-migrated target prepared with exact DRAINING identity',
    migrationRowsBefore.length === 14 && controlBeforeStart.control_state === 'DRAINING' && controlBeforeStart.acknowledged_at.includes('-infinity'),
    { migrationVersions: migrationRowsBefore.length, controlRevision: Number(controlBeforeStart.control_revision) }));
  runChecks.push(check('node-postgres returns the preseeded -infinity timestamptz as numeric negative infinity',
    sentinelDriverValue === Number.NEGATIVE_INFINITY,
    { driverType: typeof sentinelDriverValue, driverValueLabel: String(sentinelDriverValue), nativeNegativeInfinity: sentinelDriverValue === Number.NEGATIVE_INFINITY }));

  const processPortServer = createServer();
  const port = await listen(processPortServer);
  await closeServer(processPortServer);
  const childEnv = {
    ...process.env,
    NODE_PATH,
    PATH: `${path.dirname(NODE)}:${process.env.PATH ?? ''}`,
    DATABASE_URL: connectorDbUrl,
    REDIS_URL: fixture.urls.redis,
    CONNECTOR_PORT: String(port),
    HOST: '127.0.0.1',
    CONNECTOR_MIGRATION_DIRECTORY: migrationDirectory,
    CONNECTOR_ISOLATED_RUNTIME_MODE: 'restore-rehearsal',
    CONNECTOR_RUNTIME_SLOT: connectorIdentity.slot,
    CONNECTOR_RUNTIME_IDENTITY: connectorIdentity.runtimeIdentity,
    CONNECTOR_REPLICA_ID: connectorIdentity.replicaId,
    CONNECTOR_RUNTIME_REVISION: connectorIdentity.revision,
    CONNECTOR_RUNTIME_IMAGE_DIGEST: connectorIdentity.imageDigest,
    SERVICE_IDENTITY_SECRET: serviceSecret.toString('base64'),
    INVOCATION_GRANT_SECRET: grantSecret.toString('base64'),
    CONNECTOR_ENCRYPTION_KEY: credentialKey.toString('base64'),
    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: JSON.stringify(invocationKeyConfig),
    CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS: 'false',
    PROVIDER_ALLOW_HOSTS: '127.0.0.1',
    ALLOW_PRIVATE_PROVIDER_NETWORKS: 'true',
    USAGE_SINK_URL: `http://127.0.0.1:${detectorPort}/usage`,
    USAGE_SINK_TOKEN: usageSinkToken,
    VAULT_ADDR: vaultProxyAddress,
    VAULT_APPROLE_ROLE_ID: appRole.roleId,
    VAULT_APPROLE_SECRET_ID: appRole.secretId,
    VAULT_KV_ALLOWED_PREFIX: 'synthetic/no-read',
    VAULT_KV_MOUNT: 'secret',
    DRAIN_TIMEOUT_MS: '1000',
  };
  const stoppedSourceServices = [];
  for (const service of ['orchestrator-source', 'connector-source', 'vault', 'minio']) {
    stoppedSourceServices.push(stopOwnedService(fixture, service));
  }
  ACTIVE.sourceOff = {
    stoppedSourceServices,
    restoreServicesRemainAvailable: ['orchestrator-restore', 'connector-restore', 'vault-restore', 'minio-restore', 'redis'],
  };
  runChecks.push(check('source PostgreSQL planes, source Vault, and source MinIO are stopped before the restore child starts',
    stoppedSourceServices.length === 4 && stoppedSourceServices.every((service) => service.running === false),
    { sourceServicesStopped: stoppedSourceServices.map((service) => service.service) }));
  const child = spawn(NODE, [path.join(connectorBuild, 'entrypoint.js')], {
    cwd: CONNECTOR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childText = '';
  child.stdout.on('data', (chunk) => { childText += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { childText += chunk.toString('utf8'); });
  const childOutput = () => childText
    .replaceAll(serviceSecret.toString('base64'), '[redacted-service-key]')
    .replaceAll(grantSecret.toString('base64'), '[redacted-grant-key]')
    .replaceAll(credentialKey.toString('base64'), '[redacted-credential-key]')
    .replaceAll(usageSinkToken, '[redacted-usage-token]')
    .replaceAll(fixture.credentials.vaultToken, '[redacted-vault-token]')
    .replaceAll(appRole.secretId, '[redacted-approle-secret-id]')
    .replaceAll(appRole.roleId, '[redacted-approle-role-id]')
    .replaceAll(credential, '[redacted-credential]')
    .replace(/\s+/g, ' ').slice(-1000);
  const connectorUrl = `http://127.0.0.1:${port}`;

  let childStopped = false;
  const connectorPid = child.pid;
  ACTIVE.child = child;
  try {
    await waitForConnector(connectorUrl, child, childOutput);
    const processUid = Number(execFileSync('ps', ['-o', 'uid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
    runChecks.push(check('production Connector entrypoint runs as designated nonroot UID 1000', processUid === 1000,
      { uid: processUid, pid: child.pid }));

    await wait(400);
    runChecks.push(check('restore startup acquires one Vault AppRole lease and performs no renewal',
      vaultCounters.login === 1 && vaultCounters.renew === 0,
      { appRoleLogins: vaultCounters.login, renewals: vaultCounters.renew, kvReads: vaultCounters.kvReads }));

    const controlAfterStart = (await setupDb.query(
      `SELECT control_revision,control_state,acknowledged_at::text FROM connector_replica_runtime_controls WHERE replica_id=$1`,
      [connectorIdentity.replicaId],
    )).rows[0];
    runChecks.push(check('restore process did not auto-register OPEN or pre-acknowledge its control row',
      Number(controlAfterStart.control_revision) === 7
        && controlAfterStart.control_state === 'DRAINING'
        && controlAfterStart.acknowledged_at.includes('-infinity')));

    const liveness = await jsonRequest(connectorUrl, '/health/live');
    const readiness = await jsonRequest(connectorUrl, '/health/ready');
    runChecks.push(check('real Postgres and Redis health probes are available',
      liveness.status === 200 && readiness.status === 200 && readiness.body?.ok === true,
      { liveStatus: liveness.status, readyStatus: readiness.status }));

    const unknown = invocationFacts.find((fact) => fact.state === 'UNKNOWN');
    const historicalRead = await jsonRequest(connectorUrl, `/invocations/${unknown.invocationId}`, {
      headers: { ...requestIdentity({ serviceSecret }, 'connector:invoke'), 'x-invocation-grant': unknown.grant },
    });
    const historicalReadPassed = historicalRead.status === 200 && historicalRead.body?.state === 'UNKNOWN'
      && historicalRead.body?.invocationId === unknown.invocationId;
    if (!historicalReadPassed) {
      runChecks.push({
        name: 'isolated process decrypts and returns synthetic historical UNKNOWN invocation',
        status: 'failed',
        statusCode: historicalRead.status,
        errorCode: historicalRead.body?.error?.code ?? null,
        returnedState: historicalRead.body?.state ?? null,
        errorMessage: typeof historicalRead.body?.error?.message === 'string' ? historicalRead.body.error.message.slice(0, 180) : null,
      });
      throw new Error(`failed: encrypted UNKNOWN history read returned HTTP ${historicalRead.status}, code ${historicalRead.body?.error?.code ?? 'none'}`);
    }
    runChecks.push(check('isolated process decrypts and returns synthetic historical UNKNOWN invocation', true,
      { status: historicalRead.status, state: historicalRead.body?.state }));

    const serviceControlHeaders = requestIdentity({ serviceSecret }, 'connector:runtime-control');
    const observation = await jsonRequest(connectorUrl, '/internal/admin/runtime-control/observe', {
      method: 'POST', headers: serviceControlHeaders, body: connectorIdentity,
    });
    const ack = observation.body?.controlAcknowledgedAt;
    const parsedAck = typeof ack === 'string' ? Date.parse(ack) : NaN;
    const controlAfterObserve = (await setupDb.query(
      `SELECT control_revision,control_state,acknowledged_at::text FROM connector_replica_runtime_controls WHERE replica_id=$1`,
      [connectorIdentity.replicaId],
    )).rows[0];
    const ackFreshAfterStart = Number.isFinite(parsedAck) && parsedAck >= Date.parse(startedAt);
    const ackPersistedExactly = Date.parse(controlAfterObserve.acknowledged_at) === parsedAck;
    const observationHoldsCount = observation.body?.work?.connectorInvocations?.count;
    const observationHoldsApplicable = observation.body?.work?.connectorInvocations?.applicable === true;
    runChecks.push(check('fresh runtime-control ACK follows actual process observation and includes history holds',
      observation.status === 200
        && observation.body?.readiness === 'DRAINING'
        && observation.body?.controlState === 'DRAINING'
        && observation.body?.controlRevision === 7
        && ackFreshAfterStart
        && ackPersistedExactly
        && observationHoldsApplicable
        && observationHoldsCount === 2,
      { status: observation.status, readiness: observation.body?.readiness,
        controlRevision: observation.body?.controlRevision, ackFreshAfterProcessStart: ackFreshAfterStart,
        ackPersistedExactly, databaseAcknowledgedAt: controlAfterObserve.acknowledged_at,
        unresolvedApplicable: observationHoldsApplicable, unresolvedInvocationCount: observationHoldsCount }));

    const resumeCommand = {
      ...connectorIdentity,
      expectedRevision: connectorIdentity.revision,
      expectedImageDigest: connectorIdentity.imageDigest,
      expectedControlRevision: 7,
      reason: 'maintenance-rollback',
    };
    const resume = await jsonRequest(connectorUrl, '/internal/admin/runtime-control/resume', {
      method: 'POST', headers: serviceControlHeaders, body: resumeCommand,
    });
    runChecks.push(check('even an exact authenticated resume command is denied in restore rehearsal',
      resume.status === 409 && resume.body?.error?.code === 'CONNECTOR_DISABLED',
      { status: resume.status, errorCode: resume.body?.error?.code }));

    const pending = invocationFacts.find((fact) => fact.state === 'PENDING');
    const pendingReplay = await jsonRequest(connectorUrl, '/invocations', {
      method: 'POST',
      headers: requestIdentity({ serviceSecret }, 'connector:invoke'),
      body: {
        contractVersion: '1', invocationId: pending.localRequest.invocationId, grant: pending.grant,
        operationId: pending.localRequest.operationId, taskId: pending.localRequest.taskId,
        stepKey: pending.localRequest.stepKey, bindingSlot: pending.localRequest.bindingSlot,
        input: pending.localRequest.input, deadlineAt: pending.localRequest.deadlineAt,
      },
    });
    const cancelAttempt = await jsonRequest(connectorUrl, `/invocations/${unknown.invocationId}/cancel`, {
      method: 'POST',
      headers: { ...requestIdentity({ serviceSecret }, 'connector:invoke'), 'x-invocation-grant': unknown.grant },
      body: { reason: 'synthetic restore read-only negative case' },
    });
    const mutationAttempt = await jsonRequest(connectorUrl, `/connectors/${connectorId}/credentials/rotate`, {
      method: 'POST',
      headers: requestIdentity({ serviceSecret }, 'connector:manage'),
      body: { secret: 'synthetic-rotation-attempt' },
    });
    const drainAttempt = await jsonRequest(connectorUrl, '/internal/admin/runtime-control/drain', {
      method: 'POST', headers: serviceControlHeaders,
      body: { ...resumeCommand, reason: 'maintenance-rollout' },
    });
    runChecks.push(check('invocation replay/poll path, cancel, credential mutation, and drain commands stay blocked',
      [pendingReplay, cancelAttempt, mutationAttempt, drainAttempt].every((result) =>
        result.status === 409 && result.body?.error?.code === 'CONNECTOR_DISABLED'),
      { replay: [pendingReplay.status, pendingReplay.body?.error?.code], cancel: [cancelAttempt.status, cancelAttempt.body?.error?.code],
        credentialMutation: [mutationAttempt.status, mutationAttempt.body?.error?.code], drain: [drainAttempt.status, drainAttempt.body?.error?.code] }));

    const controlAfterAttempts = (await setupDb.query(
      `SELECT control_revision,control_state,acknowledged_at::text FROM connector_replica_runtime_controls WHERE replica_id=$1`,
      [connectorIdentity.replicaId],
    )).rows[0];
    const rowsAfterAttempts = await setupDb.query(
      `SELECT invocation_id,state,owner_replica_id,next_poll_at::text,poll_lease_token,
              poll_lease_expires_at::text,quota_lease_key,quota_lease_id,quota_lease_expires_at::text
         FROM connector_invocations ORDER BY invocation_id`,
    );
    const outboxAfterAttempts = await setupDb.query(
      `SELECT event_id,delivered_at::text,attempts,next_attempt_at::text,failed_attempts,last_failure_code
         FROM connector_usage_outbox ORDER BY event_id`,
    );
    const migrationsAfter = await setupDb.query('SELECT version,applied_at::text FROM connector_schema_migrations ORDER BY version');
    runChecks.push(check('resume attempt leaves the DRAINING row and exact control revision unchanged',
      Number(controlAfterAttempts.control_revision) === 7
        && controlAfterAttempts.control_state === 'DRAINING'
        && controlAfterAttempts.acknowledged_at === controlAfterObserve.acknowledged_at,
      { controlRevision: Number(controlAfterAttempts.control_revision), controlState: controlAfterAttempts.control_state,
        observationAckPreserved: controlAfterAttempts.acknowledged_at === controlAfterObserve.acknowledged_at }));
    runChecks.push(check('historical UNKNOWN/PENDING states, poll lease and expired quota lease are not rewritten',
      JSON.stringify(rowsAfterAttempts.rows) === JSON.stringify(beforeRows.rows),
      { rowsCompared: rowsAfterAttempts.rows.length, unresolvedStateSet: rowsAfterAttempts.rows.map((row) => row.state) }));
    runChecks.push(check('due usage outbox remains undelivered with zero attempts and migration ledger is unchanged',
      JSON.stringify(outboxAfterAttempts.rows) === JSON.stringify(beforeOutbox.rows)
        && JSON.stringify(migrationsAfter.rows.map((row) => ({ version: row.version, appliedAt: row.applied_at }))) === JSON.stringify(beforeMigrations),
      { outboxRows: outboxAfterAttempts.rows.length, migrationRows: migrationsAfter.rowCount }));
    runChecks.push(check('provider, usage sink, and Vault KV effect counters remain zero',
      providerCounters.provider === 0 && providerCounters.usage === 0 && vaultCounters.kvReads === 0,
      { providerRequests: providerCounters.provider, usageSinkRequests: providerCounters.usage, vaultKvReads: vaultCounters.kvReads }));
    runChecks.push(check('restore invocation read did not access source Vault or attempt any restore-Vault KV read',
      vaultCounters.login === 1 && vaultCounters.kvReads === 0,
      { restoreVaultLoginCount: vaultCounters.login, restoreVaultKvReadCount: vaultCounters.kvReads,
        sourceVaultConnected: false }));
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), wait(5000)]);
    }
    childStopped = child.exitCode !== null;
    if (!childStopped) child.kill('SIGKILL');
    await closeServer(vaultProxy);
    await closeServer(detector);
    await setupDb.close();
    ACTIVE.child = null;
    ACTIVE.database = null;
    ACTIVE.servers = [];
  }

  const cleanup = await cleanupHostInfrastructureFixture(fixture);
  ACTIVE.fixture = null;
  const sourceHashes = {};
  for (const relative of SOURCE_FILES) sourceHashes[relative] = digest(await readFile(path.join(CONNECTOR, relative)));
  sourceHashes['packages/contracts/src/connector-runtime-control.ts'] = digest(
    await readFile(path.join(ROOT, 'orchestrator/packages/contracts/src/connector-runtime-control.ts')),
  );
  const result = {
    schema: 'orv14-host-connector-restore-slice/v1',
    disposition: 'PARTIAL_HOST_CONNECTOR_SLICE_ONLY_FULL_SOURCE_FREEZE_AND_CROSS_FAMILY_PROBE_PENDING',
    command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-connector-restore.mjs`,
    cwd: ROOT,
    node: process.version,
    verifierUid: process.getuid(),
    startedAt,
    completedAt: NOW(),
    composeProject: projectId,
    composeFileSha256: fixture.composeSha256,
    imageIds: fixture.imageIds,
    sourceHashes,
    sourceHashScope: 'Connector source selected for this test; overall ORV14 source-freeze checkpoint remains pending',
    sentinelProbe: ACTIVE.sentinelProbe,
    sourceOff: ACTIVE.sourceOff,
    scratchBundle: ACTIVE.scratchBundle,
    importedContract: ACTIVE.importedContract,
    harnessHashes: ACTIVE.harnessHashes,
    databasePlane: 'isolated connector-restore PostgreSQL only; no source PostgreSQL connection was opened',
    vaultPlane: 'restore Vault only; real synthetic AppRole login; no source Vault connection was opened',
    tests: { passed: runChecks.length, failed: 0, skipped: 0, cases: runChecks },
    process: { executable: NODE, pid: connectorPid, uid: 1000, mode: 'actual compiled Connector entrypoint child process', stopped: childStopped },
    externalEffects: { providerRequests: providerCounters.provider, usageSinkRequests: providerCounters.usage, vaultRenewals: vaultCounters.renew, vaultKvReads: vaultCounters.kvReads },
    cleanup,
    acceptance: 'not claimed; source checkpoint, full host/backend build, exact all-family encrypted restore, off-source history/login/artifact/reconciliation, HA rollout, and cutover/rollback remain outstanding',
  };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ projectId, reportPath, passed: runChecks.length, failed: 0, cleanup: cleanup.remaining })}\n`);
  kek.fill(0);
  credentialKey.fill(0);
  serviceSecret.fill(0);
  grantSecret.fill(0);
}

main().catch((error) => {
  const safeMessage = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 1200);
  process.stderr.write(`ORV14 isolated Connector restore slice failed: ${safeMessage}\n`);
  void (async () => {
    if (ACTIVE.child?.exitCode === null && !ACTIVE.child.killed) ACTIVE.child.kill('SIGTERM');
    if (ACTIVE.child?.exitCode === null) {
      await Promise.race([once(ACTIVE.child, 'exit'), wait(5000)]);
      if (ACTIVE.child.exitCode === null) ACTIVE.child.kill('SIGKILL');
    }
    for (const server of ACTIVE.servers) await closeServer(server).catch(() => undefined);
    if (ACTIVE.database) await ACTIVE.database.close().catch(() => undefined);
    let cleanup;
    if (ACTIVE.fixture && !ACTIVE.fixture.cleaned) {
      try { cleanup = await cleanupHostInfrastructureFixture(ACTIVE.fixture); }
      catch (cleanupError) {
        const safeCleanup = String(cleanupError?.message ?? cleanupError).replace(/\s+/g, ' ').slice(0, 500);
        process.stderr.write(`ORV14 owned fixture cleanup failed: ${safeCleanup}\n`);
      }
    }
    if (ACTIVE.reportPath) {
      const failed = {
        schema: 'orv14-host-connector-restore-slice/v1',
        disposition: 'FAILED_PARTIAL_HOST_CONNECTOR_SLICE_ONLY',
        command: `${NODE} tests/workflow-api/orv14-vfy-host/verify-connector-restore.mjs`,
        cwd: ROOT,
        node: process.version,
        verifierUid: process.getuid(),
        startedAt: ACTIVE.startedAt,
        completedAt: NOW(),
        composeProject: ACTIVE.fixture?.projectId ?? null,
        composeFileSha256: ACTIVE.fixture?.composeSha256 ?? null,
        imageIds: ACTIVE.fixture?.imageIds ?? null,
        sourceHashesAtBuild: ACTIVE.sourceHashesAtBuild,
        sentinelProbe: ACTIVE.sentinelProbe,
        sourceOff: ACTIVE.sourceOff,
        scratchBundle: ACTIVE.scratchBundle,
        importedContract: ACTIVE.importedContract,
        harnessHashes: ACTIVE.harnessHashes,
        scratchBuild: ACTIVE.scratchBuild,
        tests: {
          passed: ACTIVE.checks.filter((item) => item.status === 'passed').length,
          failed: ACTIVE.checks.filter((item) => item.status === 'failed').length,
          skipped: 0,
          cases: ACTIVE.checks,
        },
        error: safeMessage,
        ...(cleanup ? { cleanup } : {}),
        acceptance: 'not claimed; source checkpoint and cross-family restore verification remain outstanding',
      };
      await writeFile(ACTIVE.reportPath, `${JSON.stringify(failed, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
    }
    process.exitCode = 1;
  })();
});
