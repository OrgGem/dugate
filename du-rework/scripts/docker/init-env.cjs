/** Generates a new LOCAL Docker env; never overwrites an existing secret file. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEnv } = require('node:util');
const { localSecrets, signedConnectorToken } = require('../runtime-env.cjs');

function localEnvironment(now = Date.now()) {
  return {
    POSTGRES_USER: 'du', POSTGRES_DB: 'du_orchestrator', POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    BIND_ADDRESS: '127.0.0.1', ORCHESTRATOR_PORT: '3000', ADMIN_SHELL_PORT: '3001',
    ...localSecrets(now),
    DU_ADMIN_WEB: '1', DU_ADMIN_TRUST_PROXY_PROTOCOL: 'false', ARTIFACT_STORAGE_BACKEND: 'postgres',
    DU_DATA_MODE: 'synthetic',
    DU_SYNTHETIC_DATA_ACK: JSON.stringify({ mode: 'synthetic-data-exempt', reason: 'Isolated local Docker synthetic fixtures only', approvedBy: 'local-developer', acknowledgedAt: new Date(now).toISOString(), isolatedFromRealData: true }),
    DU_ENCRYPTION_METADATA_ENABLED: 'false', DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED: 'false',
    DU_METADATA_PLAINTEXT_READ_MODE: 'forbid',
    ORCHESTRATOR_INTERNAL_BASE_URL: 'http://orchestrator:3002',
    RUNTIME_URL: 'http://orchestrator:3002/api/runtime/v1',
  };
}

module.exports = { localEnvironment };
if (require.main === module) {
  const args = process.argv.slice(2);
  for (const arg of args) if (arg.startsWith('--') && !['--workflow', '--refresh-identity'].includes(arg)) throw new Error('Unknown Docker profile option');
  const filename = path.resolve(args.find(a => !a.startsWith('--')) ?? '.env.docker');
  if (args.includes('--refresh-identity')) {
    const original = fs.readFileSync(filename, 'utf8');
    const existing = parseEnv(original);
    const token = signedConnectorToken(existing.SERVICE_IDENTITY_SECRET);
    const updated = original.replace(/^CONNECTOR_SERVICE_TOKEN=.*$/m, `CONNECTOR_SERVICE_TOKEN=${token}`);
    fs.writeFileSync(filename, existing.CONNECTOR_SERVICE_TOKEN !== undefined ? updated : original + `\nCONNECTOR_SERVICE_TOKEN=${token}\n`, { mode: 0o600 });
    console.log('Refreshed local Connector identity (24 hours); persistent keys retained. Recreate workers to load it.');
    process.exit(0);
  }
  const env = localEnvironment();
  if (args.includes('--workflow')) Object.assign(env, {
    DU_DATA_MODE: 'real', DU_SYNTHETIC_DATA_ACK: '', DU_ENCRYPTION_METADATA_ENABLED: 'true',
    DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED: 'true', DU_VAULT_TRANSIT_OPTIONS: '',
    DU_VAULT_TRANSIT_ENC_TOKEN: '', DU_VAULT_TRANSIT_DEC_TOKEN: '', DU_CONNECTOR_BASE_URLS: '',
  });
  fs.writeFileSync(filename,
    '# LOCAL only. Connector identity expires in 24 hours; use your issuer in production.\n' +
    Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(`Created ${filename}; secret values are not printed.`);
  if (args.includes('--workflow')) console.log('Configure Vault Transit options/tokens before deploying workflows.');
}
