'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SOURCE_ROOT = path.resolve(__dirname, '..');

function createSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-dev-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(SOURCE_ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(SOURCE_ROOT, 'services/orchestrator/tests/mock-vault'), path.join(root, 'services/orchestrator/tests/mock-vault'), { recursive: true });
  fs.copyFileSync(path.join(SOURCE_ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(SOURCE_ROOT, '.env.example'), path.join(root, '.env.example'));
  return root;
}

function spawnPnpm(root, command) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  return spawnSync(`pnpm ${command}`, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    env,
  });
}

function listen(server) {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server.address().port);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('dev and profile commands run from a copied orchestrator with no parent workspace', async (t) => {
  const root = createSandbox(t);
  const help = spawnPnpm(root, 'run dev -- --help');
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--mock-vault/);

  fs.writeFileSync(path.join(root, '.env.example'), [
    'DATABASE_URL=postgresql://external-user:external-password@127.0.0.1:15433/orchestrator_test',
    'REDIS_URL=redis://127.0.0.1:16380',
  ].join('\n') + '\n');
  const initialize = spawnPnpm(root, 'run init:local -- --env-file=.env.example --output=.generated-profile.env');
  assert.equal(initialize.status, 0, initialize.stderr || initialize.stdout);
  const profile = fs.readFileSync(path.join(root, '.generated-profile.env'), 'utf8');
  assert.match(profile, /DATABASE_URL=postgresql:\/\/external-user:external-password@127\.0\.0\.1:15433\/orchestrator_test/);
  assert.match(profile, /REDIS_URL=redis:\/\/127\.0\.0\.1:16380/);
  assert.match(profile, /^DU_DATA_MODE=real$/m);
  assert.match(profile, /^DU_VAULT_MOCK=true$/m);
  assert.match(profile, /^DU_ENCRYPTION_METADATA_ENABLED=true$/m);
  assert.match(profile, /^DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED=true$/m);
  assert.doesNotMatch(profile, /^LOCAL_POSTGRES_PASSWORD=/m);
  const workerMap = JSON.parse(profile.match(/^WORKER_IDENTITY_TOKENS_BY_BUSINESS=(.+)$/m)[1]);
  assert.equal(workerMap['document-core'], profile.match(/^DOCUMENT_CORE_RUNTIME_TOKEN=(.+)$/m)[1]);
  assert.equal(workerMap['lc-checker'], profile.match(/^LC_RUNTIME_TOKEN=(.+)$/m)[1]);
  assert.equal(workerMap['example-review'], profile.match(/^EXAMPLE_REVIEW_RUNTIME_TOKEN=(.+)$/m)[1]);

  const scripts = fs.readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.cjs'));
  for (const script of scripts) {
    const contents = fs.readFileSync(path.join(root, 'scripts', script), 'utf8');
    assert.doesNotMatch(contents, /require\([^)]*(?:\.\.\/\.\.\/scripts|du-rework\/scripts)/i, script);
  }
});

test('Admin Web Vite proxies only the /admin/api path boundary', async (t) => {
  const internalRequests = [];
  const bff = http.createServer((req, res) => {
    internalRequests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ source: 'bff', path: req.url }));
  });
  const bffPort = await listen(bff);
  t.after(() => new Promise((resolve, reject) => {
    bff.close((error) => error ? reject(error) : resolve());
  }));

  const adminRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-admin-web-proxy-'));
  fs.writeFileSync(path.join(adminRoot, 'index.html'), '<!doctype html><title>SPA_MARKER</title><div id="root"></div>');
  t.after(() => fs.rmSync(adminRoot, { recursive: true, force: true }));

  const requireFromAdminWeb = createRequire(path.join(SOURCE_ROOT, 'apps/admin-web/package.json'));
  const { createServer } = requireFromAdminWeb('vite');
  const { createAdminWebDevServerOptions } = require(path.join(SOURCE_ROOT, 'scripts/dev-admin-web.cjs'));
  const options = createAdminWebDevServerOptions({ host: '127.0.0.1', port: 0, internalAdminShellPort: bffPort });
  const vite = await createServer({
    root: adminRoot,
    configFile: false,
    base: '/admin/',
    plugins: options.plugins,
    server: { ...options.server, port: 0 },
  });
  t.after(() => vite.close());
  await vite.listen();
  const vitePort = vite.httpServer.address().port;

  for (const requestPath of ['/admin/api', '/admin/api?x=1', '/admin/api/session']) {
    const response = await fetch(`http://127.0.0.1:${vitePort}${requestPath}`, {
      headers: { accept: 'application/json' },
    });
    assert.deepEqual(await response.json(), { source: 'bff', path: requestPath });
  }
  // HTML routes cross the session gate once and then stay in Vite; a raw
  // /admin/api prefix proxy would forward each of these paths a second time.
  for (const requestPath of ['/admin/api-keys', '/admin/api-docs', '/admin/apiculture']) {
    const response = await fetch(`http://127.0.0.1:${vitePort}${requestPath}`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /SPA_MARKER/);
  }

  assert.deepEqual(internalRequests, [
    '/admin/api',
    '/admin/api?x=1',
    '/admin/api/session',
    '/admin/api-keys',
    '/admin/api-docs',
    '/admin/apiculture',
  ]);
});

test('runtime environment projection preserves configured shared worker tokens', (t) => {
  const root = createSandbox(t);
  const { serviceEnvironment, validateRuntimeEnvironment } = require(path.join(root, 'scripts/runtime-env.cjs'));
  const sharedToken = 'existing-shared-runtime-token';
  const invocationGrant = 'a'.repeat(32);
  const env = {
    DATABASE_URL: 'postgresql://user:password@127.0.0.1:15433/test',
    REDIS_URL: 'redis://127.0.0.1:16380',
    SERVICE_IDENTITY_SECRET: Buffer.alloc(32, 1).toString('base64'),
    INVOCATION_GRANT_SECRET: invocationGrant,
    CONNECTOR_INVOCATION_GRANT_SECRET: Buffer.from(invocationGrant).toString('base64'),
    CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: JSON.stringify({
      keyRef: 'existing-key',
      activeVersion: 1,
      keys: { 1: Buffer.alloc(32, 3).toString('base64') },
    }),
    RUNTIME_TOKEN: sharedToken,
    ADMIN_TOKEN: sharedToken,
    ENCRYPTION_KEY: 'existing-encryption-key',
    ADMIN_SHELL_COOKIE_SECRET: 'existing-cookie-secret',
    WORKER_IDENTITY_TOKENS_BY_BUSINESS: JSON.stringify({
      'document-core': sharedToken,
      'lc-checker': sharedToken,
    }),
    DOCUMENT_CORE_RUNTIME_TOKEN: sharedToken,
    LC_RUNTIME_TOKEN: sharedToken,
  };

  assert.deepEqual(serviceEnvironment(env, 'orchestrator'), env);
  assert.deepEqual(serviceEnvironment(env, 'document-core'), env);
  assert.deepEqual(serviceEnvironment(env, 'lc-checker'), env);
  assert.doesNotThrow(() => validateRuntimeEnvironment(env));
  assert.doesNotThrow(() => validateRuntimeEnvironment(env, { services: 'orchestrator' }));
});

test('local development derives a stable orchestrator-only Secret Catalog keyring from ENCRYPTION_KEY', (t) => {
  const root = createSandbox(t);
  const { serviceEnvironment } = require(path.join(root, 'scripts/runtime-env.cjs'));
  const env = { NODE_ENV: 'development', ENCRYPTION_KEY: 'configured-local-master-key' };
  const projected = serviceEnvironment(env, 'orchestrator');
  const repeated = serviceEnvironment(env, 'orchestrator');
  const keyring = JSON.parse(projected.DU_SECRET_CATALOG_KEYRING_JSON);

  assert.equal(projected.DU_SECRET_CATALOG_ACTIVE_KEY_VERSION, 'local-dev-v1');
  assert.equal(Object.keys(keyring).join(','), 'local-dev-v1');
  assert.equal(Buffer.from(keyring['local-dev-v1'], 'base64').length, 32);
  assert.equal(repeated.DU_SECRET_CATALOG_KEYRING_JSON, projected.DU_SECRET_CATALOG_KEYRING_JSON);
  const connector = serviceEnvironment(env, 'connector');
  assert.equal(connector.DU_SECRET_CATALOG_ACTIVE_KEY_VERSION, undefined);
  assert.equal(connector.DU_SECRET_CATALOG_KEYRING_JSON, undefined);
  for (const nodeEnv of ['production', 'test']) {
    const nonDevelopment = serviceEnvironment({ ...env, NODE_ENV: nodeEnv }, 'orchestrator');
    assert.equal(nonDevelopment.DU_SECRET_CATALOG_ACTIVE_KEY_VERSION, undefined);
    assert.equal(nonDevelopment.DU_SECRET_CATALOG_KEYRING_JSON, undefined);
  }
});

test('native development derives loopback cost-control credentials only when the pair is absent', (t) => {
  const root = createSandbox(t);
  const { localCostControlEnvironment } = require(path.join(root, 'scripts/dev.cjs'));
  const env = {
    NODE_ENV: 'development',
    ENCRYPTION_KEY: 'existing-local-master-key-material-0123456789abcdef',
    ADMIN_TOKEN: 'existing-admin-token',
    ORCHESTRATOR_INTERNAL_PORT: '3012',
  };
  const projected = localCostControlEnvironment(env, { internalPort: 3012 });
  const repeated = localCostControlEnvironment(env, { internalPort: 3012 });

  assert.equal(projected.COST_CONTROL_CONNECTOR_URL, 'http://127.0.0.1:3012');
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(projected.COST_CONTROL_CONNECTOR_TOKEN), true);
  assert.equal(projected.COST_CONTROL_CONNECTOR_TOKEN === repeated.COST_CONTROL_CONNECTOR_TOKEN, true);
  assert.equal(projected.COST_CONTROL_CONNECTOR_TOKEN === env.ENCRYPTION_KEY, false);
  assert.equal(projected.COST_CONTROL_CONNECTOR_TOKEN === env.ADMIN_TOKEN, false);
  assert.equal(env.COST_CONTROL_CONNECTOR_URL, undefined);
  assert.equal(env.COST_CONTROL_CONNECTOR_TOKEN, undefined);

  const spacedKey = 'existing local master key material with spaces 0123456789';
  const spacedKeyEnvironment = localCostControlEnvironment({
    NODE_ENV: 'development',
    ENCRYPTION_KEY: spacedKey,
  }, { internalPort: 3012 });
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(spacedKeyEnvironment.COST_CONTROL_CONNECTOR_TOKEN), true);

  const explicit = localCostControlEnvironment({
    ...env,
    COST_CONTROL_CONNECTOR_URL: 'http://cost-control.example.test',
    COST_CONTROL_CONNECTOR_TOKEN: 'explicit-cost-control-token-material-123456',
  }, { internalPort: 3012 });
  assert.equal(explicit.COST_CONTROL_CONNECTOR_URL, 'http://cost-control.example.test');
  assert.equal(explicit.COST_CONTROL_CONNECTOR_TOKEN, 'explicit-cost-control-token-material-123456');

  const partial = localCostControlEnvironment({
    ...env,
    COST_CONTROL_CONNECTOR_URL: 'http://cost-control.example.test',
  }, { internalPort: 3012 });
  assert.equal(partial.COST_CONTROL_CONNECTOR_URL, 'http://cost-control.example.test');
  assert.equal(partial.COST_CONTROL_CONNECTOR_TOKEN, undefined);

  const production = localCostControlEnvironment({ ...env, NODE_ENV: 'production' }, { internalPort: 3012 });
  assert.equal(production.COST_CONTROL_CONNECTOR_URL, undefined);
  assert.equal(production.COST_CONTROL_CONNECTOR_TOKEN, undefined);
  assert.throws(
    () => localCostControlEnvironment({ ...env, ENCRYPTION_KEY: 'short-key' }, { internalPort: 3012 }),
    /ENCRYPTION_KEY with at least 32 bytes/,
  );
});

test('mock bootstrap wires real KV v2 and Transit HTTP seams and shuts down its listener', async (t) => {
  const root = createSandbox(t);
  const bootstrapPath = path.join(root, 'services/orchestrator/tests/mock-vault/bootstrap.cjs');
  const { applyMockVaultEnv } = require(bootstrapPath);

  const realVaultEnv = {
    DU_VAULT_MOCK: 'false',
    DU_VAULT_TRANSIT_OPTIONS: 'existing-transit-options',
    DU_VAULT_KV_OPTIONS: 'existing-kv-options',
    VAULT_ADDR: 'https://real-vault.invalid:8200',
    VAULT_APPROLE_ROLE_ID: 'real-role-id',
    VAULT_APPROLE_SECRET_ID: 'real-secret-id',
  };
  assert.equal(await applyMockVaultEnv(realVaultEnv), undefined);
  assert.equal(realVaultEnv.DU_VAULT_TRANSIT_OPTIONS, 'existing-transit-options');
  assert.equal(realVaultEnv.DU_VAULT_KV_OPTIONS, 'existing-kv-options');
  assert.equal(realVaultEnv.VAULT_ADDR, 'https://real-vault.invalid:8200');

  const env = {
    DU_VAULT_MOCK: 'true',
    DU_VAULT_TRANSIT_OPTIONS: 'real-options-explicitly-replaced-by-mock',
    VAULT_ADDR: 'https://real-vault.invalid:8200',
    VAULT_APPROLE_ROLE_ID: 'real-role-id',
    VAULT_APPROLE_SECRET_ID: 'real-secret-id',
  };
  const service = await applyMockVaultEnv(env);
  assert.ok(service);
  let stopped = false;
  t.after(async () => {
    if (!stopped) await service.stop();
  });
  assert.equal(JSON.parse(env.DU_VAULT_TRANSIT_OPTIONS).vaultAddress, service.url);
  assert.equal(JSON.parse(env.DU_VAULT_KV_OPTIONS).vaultAddress, service.url);
  assert.equal(env.VAULT_ADDR, 'https://real-vault.invalid:8200');
  assert.equal(env.VAULT_APPROLE_ROLE_ID, 'real-role-id');
  assert.equal(env.VAULT_APPROLE_SECRET_ID, 'real-secret-id');

  const seedPath = 'du/tenants/tenant-openai/connectors/openai/accounts/du-conn-openai-main';
  const readResponse = await fetch(`${service.url}/v1/${service.kvMount}/data/${seedPath}`, {
    headers: { 'x-vault-token': service.tokens.kv },
  });
  assert.equal(readResponse.status, 200);
  const seeded = await readResponse.json();
  assert.equal(seeded.data.data['api-key'], 'mock-openai-main-key-not-a-real-secret');

  const transitOptions = JSON.parse(env.DU_VAULT_TRANSIT_OPTIONS);
  const keyName = transitOptions.allowedKeyRefs[transitOptions.metadataKeyRef];
  const plaintext = Buffer.from('local mock transit round trip').toString('base64');
  const encryptResponse = await fetch(`${service.url}/v1/${service.transitMount}/encrypt/${keyName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vault-token': env.DU_VAULT_TRANSIT_ENC_TOKEN },
    body: JSON.stringify({ plaintext }),
  });
  assert.equal(encryptResponse.status, 200);
  const ciphertext = (await encryptResponse.json()).data.ciphertext;
  const decryptResponse = await fetch(`${service.url}/v1/${service.transitMount}/decrypt/${keyName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vault-token': env.DU_VAULT_TRANSIT_DEC_TOKEN },
    body: JSON.stringify({ ciphertext }),
  });
  assert.equal(decryptResponse.status, 200);
  assert.equal((await decryptResponse.json()).data.plaintext, plaintext);

  const port = service.port;
  await service.stop();
  stopped = true;
  assert.equal(await canConnect(port), false);
});

test('external dependency preflight reports only endpoint location and never credentials', async (t) => {
  const root = createSandbox(t);
  const { assertExternalDependenciesReachable } = require(path.join(root, 'scripts/runtime-dependencies.cjs'));
  const pgServer = net.createServer();
  const redisServer = net.createServer();
  t.after(() => {
    if (pgServer.listening) pgServer.close();
    if (redisServer.listening) redisServer.close();
  });
  const [pgPort, redisPort] = await Promise.all([listen(pgServer), listen(redisServer)]);
  await assertExternalDependenciesReachable({
    DATABASE_URL: `postgresql://external-user:private-pg-password@127.0.0.1:${pgPort}/test`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  });

  await new Promise((resolve) => pgServer.close(resolve));
  await new Promise((resolve) => redisServer.close(resolve));
  await assert.rejects(
    () => assertExternalDependenciesReachable({
      DATABASE_URL: `postgresql://external-user:private-pg-password@127.0.0.1:${pgPort}/test`,
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    }, { timeoutMs: 100 }),
    (error) => {
      assert.match(error.message, /DATABASE_URL endpoint 127\.0\.0\.1:/);
      assert.match(error.message, /REDIS_URL endpoint 127\.0\.0\.1:/);
      assert.doesNotMatch(error.message, /private-pg-password|external-user/);
      assert.match(error.message, /does not start databases or containers/);
      return true;
    },
  );
});

test('local path resolver rejects external files and symlink escapes', async (t) => {
  const root = createSandbox(t);
  const { resolveLocalPath } = require(path.join(root, 'scripts/local-paths.cjs'));
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-outside-'));
  const external = path.join(externalDirectory, 'outside.env');
  fs.writeFileSync(external, 'DATABASE_URL=postgresql://unused\n');
  t.after(() => fs.rmSync(externalDirectory, { recursive: true, force: true }));
  assert.throws(() => resolveLocalPath(root, external, '--env-file'), /inside the orchestrator directory/);
  assert.throws(() => resolveLocalPath(root, external, 'DU_VAULT_MOCK_FIXTURE'), /inside the orchestrator directory/);
  assert.equal(resolveLocalPath(root, '.env.example', '--env-file'), path.join(root, '.env.example'));

  const fixtureDirectory = path.join(root, 'fixtures');
  fs.mkdirSync(fixtureDirectory);
  const localFixture = path.join(fixtureDirectory, 'custom-mock-vault.json');
  fs.copyFileSync(path.join(root, 'services/orchestrator/tests/mock-vault/mock-vault.json'), localFixture);
  assert.equal(resolveLocalPath(root, 'fixtures/custom-mock-vault.json', 'DU_VAULT_MOCK_FIXTURE'), localFixture);

  const link = path.join(root, 'external-link');
  try {
    fs.symlinkSync(externalDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
    const externalViaLink = path.join('external-link', 'outside.env');
    assert.throws(() => resolveLocalPath(root, externalViaLink, '--env-file'), /resolves outside the orchestrator directory/);
    assert.throws(() => resolveLocalPath(root, externalViaLink, 'DU_VAULT_MOCK_FIXTURE'), /resolves outside the orchestrator directory/);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.diagnostic('Symlink containment assertion skipped because this Windows account cannot create file symlinks.');
  }
});
