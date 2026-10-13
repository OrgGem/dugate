#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEnv } = require('node:util');
const { localSecrets } = require('./runtime-env.cjs');
const { isWithin, resolveLocalPath } = require('./local-paths.cjs');

const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env.local');

function initLocalEnv({ mode = 'dev', output = file, databaseUrl, redisUrl } = {}) {
  const rootReal = fs.realpathSync(root);
  const targetCandidate = path.resolve(rootReal, output);
  if (!isWithin(rootReal, targetCandidate)) {
    throw new Error('Local profile output must stay inside the orchestrator directory.');
  }
  const targetParent = resolveLocalPath(rootReal, path.relative(rootReal, path.dirname(targetCandidate)), 'Local profile output directory');
  const target = path.join(targetParent, path.basename(targetCandidate));
  if (fs.existsSync(target)) return resolveLocalPath(rootReal, path.relative(rootReal, target), 'Local profile output');
  if (!['dev', 'docker'].includes(mode)) throw new Error('Profile mode must be dev or docker.');

  const externalDatabaseUrl = databaseUrl ?? process.env.DATABASE_URL;
  const externalRedisUrl = redisUrl ?? process.env.REDIS_URL;
  if (mode === 'dev' && (!externalDatabaseUrl || !externalRedisUrl)) {
    throw new Error('Set DATABASE_URL and REDIS_URL for your already running external services before generating a dev profile. This command does not create database credentials or start containers.');
  }
  const password = mode === 'docker' ? randomBytes(24).toString('hex') : undefined;
  const encryptedDevProfile = mode === 'dev';
  const values = {
    NODE_ENV: 'development',
    ...(mode === 'docker' ? {
      LOCAL_POSTGRES_PASSWORD: password,
      DATABASE_URL: `postgresql://du:${password}@127.0.0.1:15433/du_orchestrator_dev`,
      REDIS_URL: 'redis://127.0.0.1:16380',
    } : { DATABASE_URL: externalDatabaseUrl, REDIS_URL: externalRedisUrl }),
    ORCHESTRATOR_PORT: '3000',
    ORCHESTRATOR_HOST: '127.0.0.1',
    ORCHESTRATOR_INTERNAL_PORT: '3002',
    ORCHESTRATOR_INTERNAL_HOST: '127.0.0.1',
    ORCHESTRATOR_INTERNAL_BASE_URL: 'http://127.0.0.1:3002',
    ADMIN_SHELL_PORT: '3001',
    ADMIN_SHELL_HOST: '127.0.0.1',
    DU_ADMIN_WEB: '1',
    ...localSecrets(),
    AUTO_MIGRATE: 'false',
    ARTIFACT_STORAGE_BACKEND: 'postgres',
    CONNECTOR_PORT: '8088',
    HOST: '127.0.0.1',
    CONNECTOR_REDIS_PREFIX: 'du:connector:',
    CONNECTOR_MIGRATION_DIRECTORY: './services/connector/src/db/migrations',
    RUNTIME_URL: 'http://127.0.0.1:3002/api/runtime/v1',
    CONNECTOR_URL: 'http://127.0.0.1:8088',
    DU_DATA_MODE: encryptedDevProfile ? 'real' : 'synthetic',
    DU_SYNTHETIC_DATA_ACK: encryptedDevProfile ? '' : JSON.stringify({
      mode: 'synthetic-data-exempt',
      reason: 'Isolated development with generated synthetic fixtures only',
      approvedBy: 'local-developer',
      acknowledgedAt: new Date().toISOString(),
      isolatedFromRealData: true,
    }),
    DU_ENCRYPTION_METADATA_ENABLED: String(encryptedDevProfile),
    DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED: String(encryptedDevProfile),
    DU_METADATA_PLAINTEXT_READ_MODE: 'forbid',
    DU_VAULT_MOCK: String(encryptedDevProfile),
  };

  const content = `# Private ${mode === 'dev' ? 'external-service' : 'Docker'} local development profile\n`
    + Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`[init] Created ${path.relative(root, target)} with generated app credentials; secret values are not printed.`);
  return target;
}

const workerTokenKeys = {
  'document-core': 'DOCUMENT_CORE_RUNTIME_TOKEN',
  'lc-checker': 'LC_RUNTIME_TOKEN',
  'example-review': 'EXAMPLE_REVIEW_RUNTIME_TOKEN',
};

function ensureLocalWorkerIdentities() {
  if (!fs.existsSync(file)) initLocalEnv();

  const original = fs.readFileSync(file, 'utf8');
  const env = parseEnv(original);
  let workerMap;
  try {
    workerMap = JSON.parse(env.WORKER_IDENTITY_TOKENS_BY_BUSINESS || '{}');
  } catch {
    throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS is not valid JSON; profile was left unchanged.');
  }
  if (!workerMap || typeof workerMap !== 'object' || Array.isArray(workerMap)) {
    throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS must be a JSON object; profile was left unchanged.');
  }

  const seen = new Set([env.RUNTIME_TOKEN, env.ADMIN_TOKEN, env.USAGE_TOKEN].filter(Boolean));
  for (const [businessId, token] of Object.entries(workerMap)) {
    if (!businessId.trim() || typeof token !== 'string' || !token.trim() || seen.has(token)) {
      throw new Error('Existing worker identity entries are invalid or duplicated; profile was left unchanged.');
    }
    seen.add(token);
  }

  for (const [businessId, key] of Object.entries(workerTokenKeys)) {
    const mapped = workerMap[businessId];
    const configured = env[key];
    if (mapped && configured && mapped !== configured) {
      throw new Error(`${key} disagrees with the worker identity map; profile was left unchanged.`);
    }
    const token = mapped || configured || randomBytes(32).toString('hex');
    if (seen.has(token) && token !== mapped) {
      throw new Error(`${key} reuses a platform or worker identity token; profile was left unchanged.`);
    }
    seen.add(token);
    workerMap[businessId] = token;
  }

  const updates = {
    WORKER_IDENTITY_TOKENS_BY_BUSINESS: JSON.stringify(workerMap),
    ...Object.fromEntries(Object.entries(workerTokenKeys).map(([businessId, key]) => [key, workerMap[businessId]])),
  };
  let updated = original;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}=.*$`, 'gm');
    const matches = [...updated.matchAll(pattern)];
    if (matches.length > 1) {
      throw new Error(`Profile contains duplicate ${key} entries; profile was left unchanged.`);
    }
    updated = matches.length === 1
      ? updated.replace(pattern, () => line)
      : `${updated.replace(/\s*$/, '')}\n${line}\n`;
  }

  if (updated !== original) {
    const stat = fs.statSync(file);
    const temporaryFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, updated, { encoding: 'utf8', mode: stat.mode & 0o777 });
    fs.renameSync(temporaryFile, file);
    console.log('Added missing local worker identity entries; existing profile credentials were retained.');
  } else {
    console.log('Local worker identity map is already complete.');
  }
  return file;
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const envFileArg = args.find((arg) => arg.startsWith('--env-file='));
  const outputArg = args.find((arg) => arg.startsWith('--output='));
  for (const arg of args) {
    if (!['--docker', '--ensure-worker-identities', '--help'].includes(arg)
      && !arg.startsWith('--env-file=') && !arg.startsWith('--output=')) {
      throw new Error('Unknown option. Use --help for usage.');
    }
  }
  if (args.includes('--help')) {
    console.log('node scripts/init-local.cjs [--env-file=PATH] [--output=PATH] [--docker] [--ensure-worker-identities]');
  } else if (args.includes('--ensure-worker-identities')) {
    ensureLocalWorkerIdentities();
  } else {
    const inputPath = envFileArg ? resolveLocalPath(root, envFileArg.slice('--env-file='.length), '--env-file') : undefined;
    let input = {};
    if (inputPath) {
      input = parseEnv(fs.readFileSync(inputPath, 'utf8'));
    }
    const configured = { ...input, ...process.env };
    initLocalEnv({
      mode: args.includes('--docker') ? 'docker' : 'dev',
      output: outputArg?.slice('--output='.length) ?? '.env.local',
      databaseUrl: configured.DATABASE_URL,
      redisUrl: configured.REDIS_URL,
    });
  }
}

module.exports = { initLocalEnv, ensureLocalWorkerIdentities };
