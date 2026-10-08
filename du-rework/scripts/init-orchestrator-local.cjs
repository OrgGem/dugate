#!/usr/bin/env node
// Generate a private local profile; never replace existing secrets.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEnv } = require('node:util');
const { localSecrets } = require('./runtime-env.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
for (const arg of args) if (!['--workflow', '--help'].includes(arg) && !arg.startsWith('--output=') && !arg.startsWith('--env-file=') && !arg.startsWith('--vault-env=')) throw new Error('Unknown local profile option');
if (args.includes('--help')) {
  console.log('node scripts/init-orchestrator-local.cjs [--output=PATH] [--workflow] [--vault-env=PATH]');
  process.exit(0);
}
const file = path.resolve(root, args.find(a => a.startsWith('--output='))?.slice(9) || args.find(a => a.startsWith('--env-file='))?.slice(11) || '.env.orchestrator.local');
if (fs.existsSync(file)) {
  console.log('Existing profile retained. Choose a new --output to generate updated credentials.');
} else {
  const password = randomBytes(24).toString('hex');
  const workflow = args.includes('--workflow');
  const vaultArg = args.find(a => a.startsWith('--vault-env='));
  const vault = vaultArg ? parseEnv(fs.readFileSync(path.resolve(root, vaultArg.slice(12)), 'utf8')) : {};
  const cryptoVars = Object.fromEntries([
    'DU_VAULT_TRANSIT_OPTIONS', 'DU_VAULT_TRANSIT_ENC_TOKEN', 'DU_VAULT_TRANSIT_DEC_TOKEN',
    'DU_VAULT_KV_OPTIONS', 'DU_VAULT_KV_TOKEN', 'DU_CONNECTOR_INITIAL_BINDINGS',
  ].map(key => [key, vault[key] || '']));
  const values = {
    NODE_ENV: 'development', LOCAL_POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgresql://du:${password}@127.0.0.1:15433/du_orchestrator_dev`,
    REDIS_URL: 'redis://127.0.0.1:16380',
    ORCHESTRATOR_PORT: '3000', ORCHESTRATOR_HOST: '127.0.0.1',
    ORCHESTRATOR_INTERNAL_PORT: '3002', ORCHESTRATOR_INTERNAL_HOST: '127.0.0.1',
    ORCHESTRATOR_INTERNAL_BASE_URL: 'http://127.0.0.1:3002',
    ADMIN_SHELL_PORT: '3001', ADMIN_SHELL_HOST: '127.0.0.1', DU_ADMIN_WEB: '1',
    ...localSecrets(), AUTO_MIGRATE: 'false', ARTIFACT_STORAGE_BACKEND: 'postgres',
    CONNECTOR_PORT: '8088', HOST: '127.0.0.1', CONNECTOR_REDIS_PREFIX: 'du:connector:',
    CONNECTOR_MIGRATION_DIRECTORY: './orchestrator/services/connector/src/db/migrations',
    RUNTIME_URL: 'http://127.0.0.1:3002/api/runtime/v1', CONNECTOR_URL: 'http://127.0.0.1:8088',
    DU_CONNECTOR_BASE_URLS: vault.DU_CONNECTOR_BASE_URLS || '',
    DOCUMENT_CORE_CONCURRENCY: '1', LC_CONCURRENCY: '1', EXAMPLE_REVIEW_CONCURRENCY: '1',
    DU_DATA_MODE: workflow ? 'real' : 'synthetic',
    DU_SYNTHETIC_DATA_ACK: workflow ? '' : JSON.stringify({
      mode: 'synthetic-data-exempt', reason: 'Isolated development with generated synthetic fixtures only',
      approvedBy: 'local-developer', acknowledgedAt: new Date().toISOString(), isolatedFromRealData: true,
    }),
    DU_ENCRYPTION_METADATA_ENABLED: String(workflow), DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED: String(workflow),
    DU_METADATA_PLAINTEXT_READ_MODE: 'forbid', ...cryptoVars,
  };
  fs.writeFileSync(file, '# Private local profile. Provision business/profile/schema separately.\n'
    + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
  { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log('Created private local profile; secret values are not printed.');
  if (workflow) console.log('Workflow mode: configure Vault Transit tokens/options, then run dev.cjs --workflow --check.');
}
