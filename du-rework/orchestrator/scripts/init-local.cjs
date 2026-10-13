#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEnv } = require('node:util');
const { localSecrets } = require('../../scripts/runtime-env.cjs');

const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env.local');

function initLocalEnv() {
  if (fs.existsSync(file)) {
    return file;
  }

  const password = randomBytes(24).toString('hex');
  const values = {
    NODE_ENV: 'development',
    LOCAL_POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgresql://du:${password}@127.0.0.1:15433/du_orchestrator_dev`,
    REDIS_URL: 'redis://127.0.0.1:16380',
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
    DU_DATA_MODE: 'synthetic',
    DU_SYNTHETIC_DATA_ACK: JSON.stringify({
      mode: 'synthetic-data-exempt',
      reason: 'Isolated development with generated synthetic fixtures only',
      approvedBy: 'local-developer',
      acknowledgedAt: new Date().toISOString(),
      isolatedFromRealData: true,
    }),
    DU_ENCRYPTION_METADATA_ENABLED: 'false',
    DU_METADATA_PLAINTEXT_READ_MODE: 'forbid',
  };

  const content = '# Local development profile generated automatically\n'
    + Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log('[init] Created .env.local with safe generated credentials.');
  return file;
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
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/init-local.cjs [--ensure-worker-identities]');
  } else if (args.includes('--ensure-worker-identities')) {
    ensureLocalWorkerIdentities();
  } else if (args.length) {
    throw new Error('Unknown option. Use --help for usage.');
  } else {
    initLocalEnv();
  }
}

module.exports = { initLocalEnv, ensureLocalWorkerIdentities };
