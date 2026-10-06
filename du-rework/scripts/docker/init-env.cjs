/** Generates a new LOCAL Docker env; never overwrites an existing secret file. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHmac } = require('node:crypto');

function localEnvironment(now = Date.now()) {
  const rawGrant = randomBytes(16).toString('hex');
  const identityKey = randomBytes(32);
  const expires = Math.floor(now / 1000) + 24 * 60 * 60;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    sub: 'local-business-workers', aud: 'connector', scopes: ['connector:invoke'], exp: expires,
  })).toString('base64url');
  const signed = `${header}.${claims}`;
  const workers = Object.fromEntries(['document-core', 'lc-checker', 'example-review']
    .map(business => [business, randomBytes(32).toString('hex')]));
  return {
    POSTGRES_USER: 'du', POSTGRES_DB: 'du_orchestrator',
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    BIND_ADDRESS: '127.0.0.1', ORCHESTRATOR_PORT: '3000', ADMIN_SHELL_PORT: '3001', CONNECTOR_PORT: '8080',
    RUNTIME_TOKEN: randomBytes(32).toString('hex'), ADMIN_TOKEN: randomBytes(32).toString('hex'),
    DOCUMENT_CORE_RUNTIME_TOKEN: workers['document-core'], LC_RUNTIME_TOKEN: workers['lc-checker'],
    EXAMPLE_REVIEW_RUNTIME_TOKEN: workers['example-review'], WORKER_IDENTITY_TOKENS_BY_BUSINESS: JSON.stringify(workers),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'), ADMIN_SHELL_COOKIE_SECRET: randomBytes(32).toString('hex'),
    INVOCATION_GRANT_SECRET: rawGrant,
    CONNECTOR_INVOCATION_GRANT_SECRET: Buffer.from(rawGrant).toString('base64'),
    SERVICE_IDENTITY_SECRET: identityKey.toString('base64'),
    CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CONNECTOR_SERVICE_TOKEN: `${signed}.${createHmac('sha256', identityKey).update(signed).digest('base64url')}`,
    DU_ADMIN_WEB: '0', DU_ADMIN_TRUST_PROXY_PROTOCOL: 'false', ARTIFACT_STORAGE_BACKEND: 'postgres',
  };
}

module.exports = { localEnvironment };
if (require.main === module) {
  const filename = path.resolve(process.argv[2] ?? '.env.docker');
  const env = localEnvironment();
  fs.writeFileSync(filename,
    '# LOCAL only. Connector identity expires in 24 hours; use your issuer in production.\n' +
    Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(`Created ${filename}; secret values are not printed.`);
}
