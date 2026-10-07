#!/usr/bin/env node
// Dedicated synthetic-data local profile. Never overwrite an existing profile.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env.orchestrator.local');
if (fs.existsSync(file)) {
  console.log('Existing .env.orchestrator.local retained.');
} else {
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
    RUNTIME_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_SHELL_COOKIE_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AUTO_MIGRATE: 'false',
    ARTIFACT_STORAGE_BACKEND: 'postgres',
    CONNECTOR_PORT: '8088',
    HOST: '127.0.0.1',
    SERVICE_IDENTITY_SECRET: randomBytes(32).toString('base64'),
    INVOCATION_GRANT_SECRET: randomBytes(32).toString('base64'),
    CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CONNECTOR_MIGRATION_DIRECTORY: './orchestrator/services/connector/src/db/migrations',
    RUNTIME_URL: 'http://127.0.0.1:3002/api/runtime/v1',
    CONNECTOR_URL: 'http://127.0.0.1:8088',
    // Startup fixture only; provider calls require a valid signed service identity.
    CONNECTOR_SERVICE_TOKEN: randomBytes(32).toString('hex'),
    CONCURRENCY: '1',
    DU_DATA_MODE: 'synthetic',
    DU_SYNTHETIC_DATA_ACK: JSON.stringify({
      mode: 'synthetic-data-exempt',
      reason: 'Isolated local development with generated synthetic fixtures only',
      approvedBy: 'local-developer',
      acknowledgedAt: new Date().toISOString(),
      isolatedFromRealData: true,
    }),
  };
  fs.writeFileSync(file, '# Synthetic local fixtures only; never use real sensitive data.\n'
    + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
  { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log('Created private .env.orchestrator.local (secret values not printed).');
}
