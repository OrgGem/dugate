#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { localSecrets } = require('./runtime-env.cjs');

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
  fs.writeFileSync(file, content, { encoding: 'utf8' });
  console.log('[init] Created .env.local with safe generated credentials.');
  return file;
}

if (require.main === module) {
  initLocalEnv();
}

module.exports = { initLocalEnv };
