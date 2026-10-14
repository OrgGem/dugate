'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { localEnvironment } = require('../../scripts/docker/init-env.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE_FILES = [
  'compose/infra.yml',
  'compose/orchestrator.yml',
  'compose/connector.yml',
];
const DEPLOY_INPUTS = [
  'docker-compose.deploy.yml',
  'compose/deploy-infra.yml',
  'compose/orchestrator.yml',
  'compose/connector.yml',
  'compose/document-core.yml',
  'compose/lc-checker.yml',
  'compose/example-review.yml',
];

function composeEnvironment(contents) {
  const names = new Set();
  const requiredNames = new Set();
  for (const source of contents) {
    for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
    for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) requiredNames.add(match[1]);
  }

  const environment = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  for (const name of names) environment[name] = requiredNames.has(name) ? 'synthetic-required-value' : '';
  Object.assign(environment, {
    POSTGRES_PASSWORD: 'synthetic-password',
    DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid:5432/orchestrator',
    CONNECTOR_DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid:5432/connector',
    REDIS_URL: 'redis://redis.invalid:6379',
    DOCUMENT_CORE_DOCKER_REDIS_URL: 'redis://redis.invalid:6379',
    RUNTIME_TOKEN: 'synthetic-runtime-token',
    ADMIN_TOKEN: 'synthetic-admin-token',
    ENCRYPTION_KEY: 'synthetic-retained-encryption-key-32bytes',
    INVOCATION_GRANT_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    DU_CONNECTOR_BASE_URLS: '{"*":"http://connector:8080"}',
    SERVICE_IDENTITY_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    COST_CONTROL_CONNECTOR_TOKEN: 'synthetic-cost-control-token-distinct-0001',
    DU_ORCHESTRATOR_RUNTIME_IDENTITY: 'orchestrator-release',
    DU_ORCHESTRATOR_RUNTIME_SLOT: 'blue',
    DU_ORCHESTRATOR_RUNTIME_REVISION: 'release-20261014',
    DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST: `du-orchestrator@sha256:${'a'.repeat(64)}`,
    DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN: 'synthetic-orchestrator-control-token',
    WORKER_IDENTITY_TOKENS_BY_BUSINESS: '{"business":"synthetic-worker-token"}',
    ADMIN_SHELL_COOKIE_SECRET: 'synthetic-admin-shell-cookie-secret-32bytes',
    CONNECTOR_INVOCATION_GRANT_SECRET: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
    CONNECTOR_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: '{"keyRef":"synthetic-connector","activeVersion":1,"keys":{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}',
    CONNECTOR_RUNTIME_SLOT: 'blue',
    CONNECTOR_RUNTIME_IDENTITY: 'connector-release',
    CONNECTOR_REPLICA_ID: 'connector-replica',
    CONNECTOR_RUNTIME_REVISION: 'release-20261014',
    CONNECTOR_RUNTIME_IMAGE_DIGEST: `du-connector@sha256:${'b'.repeat(64)}`,
    DOCUMENT_CORE_RUNTIME_TOKEN: 'synthetic-document-core-token',
    DOCUMENT_CORE_IMAGE_DIGEST: `du-document-core@sha256:${'c'.repeat(64)}`,
    LC_RUNTIME_TOKEN: 'synthetic-lc-token',
    LC_IMAGE_DIGEST: `du-lc-checker@sha256:${'d'.repeat(64)}`,
    EXAMPLE_REVIEW_RUNTIME_TOKEN: 'synthetic-example-review-token',
    EXAMPLE_REVIEW_IMAGE_DIGEST: `du-example-review@sha256:${'e'.repeat(64)}`,
    CONNECTOR_SERVICE_TOKEN: 'synthetic-signed-connector-service-token',
  });
  return environment;
}

test('Docker Compose renders the platform fragments from synthetic environment only', () => {
  const paths = COMPOSE_FILES.map((file) => path.join(REPO_ROOT, file));
  const contents = paths.map((file) => fs.readFileSync(file, 'utf8'));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'du-compose-preflight-'));
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory).toLowerCase();
  const resolvedTemporaryRoot = path.resolve(os.tmpdir()).toLowerCase();

  try {
    assert.ok(resolvedTemporaryDirectory.startsWith(`${resolvedTemporaryRoot}${path.sep.toLowerCase()}`));
    const envFile = path.join(temporaryDirectory, 'synthetic.env');
    fs.writeFileSync(envFile, '# Synthetic Compose preflight; no deployment credentials.\n', { mode: 0o600 });
    const args = ['compose', '--profile', 'migration', '--env-file', envFile];
    for (const file of COMPOSE_FILES) args.push('-f', file);
    args.push('config', '--format', 'json');

    const result = spawnSync('docker', args, {
      cwd: REPO_ROOT,
      env: composeEnvironment(contents),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || 'docker compose config failed');

    const configuration = JSON.parse(result.stdout);
    const services = configuration.services;
    assert.equal(services.orchestrator.build.context, path.join(REPO_ROOT, 'orchestrator'));
    assert.equal(services.connector.build.context, path.join(REPO_ROOT, 'orchestrator'));
    assert.deepEqual(services.orchestrator.ports.map((port) => port.target), [3000, 3001]);
    assert.equal(services.connector.ports, undefined);
    assert.equal(services.orchestrator.environment.ORCHESTRATOR_INTERNAL_PORT, '3002');
    assert.equal(services.orchestrator.environment.DU_ADMIN_WEB_DIST, '/app/admin-web');
    assert.equal(services.connector.environment.DATABASE_URL, 'postgresql://synthetic:synthetic@db.invalid:5432/connector');
    assert.equal(services.connector.environment.CONNECTOR_AUTO_MIGRATE, 'false');
    assert.equal(services.orchestrator.environment.NODE_ENV, 'production');
    assert.equal(services.connector.environment.NODE_ENV, 'production');
    assert.equal(services.orchestrator.environment.DU_ENCRYPTION_METADATA_ENABLED, 'true');
    assert.equal(services.orchestrator.environment.DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED, 'true');
    assert.equal(services.orchestrator.environment.DU_DATA_MODE, 'real');
    assert.equal(services.orchestrator.environment.DU_LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION, '');
    assert.equal(services.orchestrator.environment.DU_LOCAL_ENCRYPTION_KEYRING_JSON, '');
    assert.deepEqual(services['orchestrator-migrate'].profiles, ['migration']);
    assert.deepEqual(services['connector-migrate'].profiles, ['migration']);
    assert.equal(services.orchestrator.depends_on, undefined);
    assert.equal(services.connector.depends_on, undefined);
    assert.equal(services['orchestrator-migrate'].entrypoint.at(-1), '/app/dist/migrate-cli.js');
    assert.equal(services['connector-migrate'].entrypoint.at(-1), '/app/dist/migrate-cli.js');
    assert.doesNotMatch(contents[1], /^  (postgres|valkey):/m);
    assert.doesNotMatch(contents[2], /^  (postgres|valkey|connector-db-init):/m);

    const orchestratorDockerfile = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator/services/orchestrator/Dockerfile'), 'utf8');
    const connectorDockerfile = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator/services/connector/Dockerfile'), 'utf8');
    const orchestratorEntry = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator/scripts/docker-orchestrator-entrypoint.sh'), 'utf8');
    const connectorEntry = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator/scripts/docker-connector-entrypoint.sh'), 'utf8');
    const dockerIgnore = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator/.dockerignore'), 'utf8');
    assert.match(orchestratorDockerfile, /COPY tsconfig\.base\.json/);
    assert.match(connectorDockerfile, /COPY tsconfig\.base\.json/);
    assert.match(orchestratorDockerfile, /docker-build-runtime\.cjs orchestrator \/deploy/);
    assert.match(connectorDockerfile, /docker-build-runtime\.cjs connector \/deploy/);
    assert.ok(orchestratorEntry.indexOf('node /app/dist/migrate-cli.js verify') < orchestratorEntry.indexOf('exec node /app/dist/main.js'));
    assert.ok(connectorEntry.indexOf('node /app/dist/migrate-cli.js verify') < connectorEntry.indexOf('exec node /app/dist/entrypoint.js'));
    assert.match(dockerIgnore, /Keep vendor assets in this context/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('generated local Docker environment renders in development mode', () => {
  const generated = localEnvironment();
  assert.equal(generated.NODE_ENV, 'development');
  assert.equal(generated.DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST, undefined);
  assert.equal(generated.CONNECTOR_RUNTIME_IMAGE_DIGEST, undefined);

  const paths = COMPOSE_FILES.map((file) => path.join(REPO_ROOT, file));
  const contents = paths.map((file) => fs.readFileSync(file, 'utf8'));
  const environment = composeEnvironment(contents);
  Object.assign(environment, generated);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'du-local-compose-preflight-'));
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory).toLowerCase();
  const resolvedTemporaryRoot = path.resolve(os.tmpdir()).toLowerCase();

  try {
    assert.ok(resolvedTemporaryDirectory.startsWith(`${resolvedTemporaryRoot}${path.sep.toLowerCase()}`));
    const envFile = path.join(temporaryDirectory, 'synthetic.env');
    fs.writeFileSync(envFile, '# Synthetic Compose preflight; no deployment credentials.\n', { mode: 0o600 });
    const args = ['compose', '--profile', 'migration', '--env-file', envFile];
    for (const file of COMPOSE_FILES) args.push('-f', file);
    args.push('config', '--format', 'json');
    const result = spawnSync('docker', args, {
      cwd: REPO_ROOT,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || 'local docker compose config failed');

    const configuration = JSON.parse(result.stdout);
    assert.equal(configuration.services.orchestrator.environment.NODE_ENV, 'development');
    assert.equal(configuration.services.connector.environment.NODE_ENV, 'development');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('deployment preflight rejects non-production mode and non-immutable image references', () => {
  const generated = localEnvironment();
  const environment = {
    ...generated,
    NODE_ENV: 'production',
    DU_DATA_MODE: 'real',
    DOCUMENT_CORE_DOCKER_REDIS_URL: generated.REDIS_URL,
    DU_ENCRYPTION_METADATA_ENABLED: 'true',
    DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED: 'true',
    DU_ORCHESTRATOR_RUNTIME_IDENTITY: 'orchestrator-release',
    DU_ORCHESTRATOR_RUNTIME_SLOT: 'blue',
    DU_ORCHESTRATOR_RUNTIME_REVISION: 'release-20261014',
    DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST: `du-orchestrator@sha256:${'a'.repeat(64)}`,
    DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN: 'synthetic-orchestrator-control-token-distinct',
    CONNECTOR_RUNTIME_SLOT: 'blue',
    CONNECTOR_RUNTIME_IDENTITY: 'connector-release',
    CONNECTOR_REPLICA_ID: 'connector-release',
    CONNECTOR_RUNTIME_REVISION: 'release-20261014',
    CONNECTOR_RUNTIME_IMAGE_DIGEST: `du-connector@sha256:${'b'.repeat(64)}`,
    DOCUMENT_CORE_IMAGE_DIGEST: `du-document-core@sha256:${'c'.repeat(64)}`,
    LC_IMAGE_DIGEST: `du-lc-checker@sha256:${'d'.repeat(64)}`,
    EXAMPLE_REVIEW_IMAGE_DIGEST: `du-example-review@sha256:${'e'.repeat(64)}`,
  };
  const digestKeys = [
    'DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST', 'CONNECTOR_RUNTIME_IMAGE_DIGEST',
    'DOCUMENT_CORE_IMAGE_DIGEST', 'LC_IMAGE_DIGEST', 'EXAMPLE_REVIEW_IMAGE_DIGEST',
  ];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'du-deploy-env-preflight-'));
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory).toLowerCase();
  const resolvedTemporaryRoot = path.resolve(os.tmpdir()).toLowerCase();
  const envFile = path.join(temporaryDirectory, 'synthetic.env');
  const checker = path.join(REPO_ROOT, 'scripts/docker/check-env.cjs');
  const childEnvironment = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };

  function runCheck(candidate) {
    const serialized = Object.entries(candidate)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n');
    fs.writeFileSync(envFile, `${serialized}\n`, { mode: 0o600 });
    return spawnSync(process.execPath, [checker, envFile, '--deploy'], {
      cwd: REPO_ROOT,
      env: childEnvironment,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  try {
    assert.ok(resolvedTemporaryDirectory.startsWith(`${resolvedTemporaryRoot}${path.sep.toLowerCase()}`));
    const valid = runCheck(environment);
    if (valid.error) throw valid.error;
    assert.equal(valid.status, 0, valid.stderr || 'synthetic production deployment env should validate');

    const nonProduction = runCheck({ ...environment, NODE_ENV: 'development' });
    assert.notEqual(nonProduction.status, 0);
    assert.match(nonProduction.stderr, /NODE_ENV=production is required/);

    for (const key of digestKeys) {
      const invalidDigest = runCheck({ ...environment, [key]: 'local' });
      assert.notEqual(invalidDigest.status, 0, `${key} must reject mutable image references`);
      assert.match(invalidDigest.stderr, new RegExp(`${key} must be an immutable repository image digest`));
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('external deployment aggregate contains no database or Redis service', () => {
  const paths = DEPLOY_INPUTS.map((file) => path.join(REPO_ROOT, file));
  const contents = paths.map((file) => fs.readFileSync(file, 'utf8'));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'du-deploy-compose-preflight-'));
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory).toLowerCase();
  const resolvedTemporaryRoot = path.resolve(os.tmpdir()).toLowerCase();

  try {
    assert.ok(resolvedTemporaryDirectory.startsWith(`${resolvedTemporaryRoot}${path.sep.toLowerCase()}`));
    const envFile = path.join(temporaryDirectory, 'synthetic.env');
    fs.writeFileSync(envFile, '# Synthetic Compose preflight; no deployment credentials.\n', { mode: 0o600 });
    const result = spawnSync('docker', [
      'compose', '--profile', 'migration', '--env-file', envFile,
      '-f', 'docker-compose.deploy.yml', 'config', '--format', 'json',
    ], {
      cwd: REPO_ROOT,
      env: composeEnvironment(contents),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || 'deployment docker compose config failed');

    const configuration = JSON.parse(result.stdout);
    const services = configuration.services;
    assert.equal(services.postgres, undefined);
    assert.equal(services.valkey, undefined);
    assert.equal(services['connector-db-init'], undefined);
    assert.deepEqual(services['orchestrator-migrate'].profiles, ['migration']);
    assert.deepEqual(services['connector-migrate'].profiles, ['migration']);
    assert.equal(services.orchestrator.build.context, path.join(REPO_ROOT, 'orchestrator'));
    assert.equal(services.connector.build.context, path.join(REPO_ROOT, 'orchestrator'));
    assert.equal(services.orchestrator.depends_on, undefined);
    assert.equal(services.connector.depends_on, undefined);
    assert.equal(services['document-core'].ports, undefined);
    assert.equal(services['lc-checker'].ports, undefined);
    assert.equal(services['example-review'].ports, undefined);
    assert.equal(configuration.networks['du-platform-net'].external, true);
    assert.equal(configuration.networks['du-worker-net'].external, true);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
