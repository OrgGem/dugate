// Diagnostic only: reproduces the legacy redirect finding; this is not an acceptance test.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const serviceRequire = createRequire(path.join(root, 'services/orchestrator/package.json'));
const ts = serviceRequire('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};
const { handleLoginPost } = require(path.join(root, 'services/orchestrator/src/app/admin/auth-dispatch.ts'));
const result = handleLoginPost({
  method: 'POST', pathname: '/admin/login', cookies: {},
  body: { token: 'audit-fixture-only', redirect: 'https://example.invalid/phishing' },
  forwardedProto: 'https',
}, {
  adminToken: 'audit-fixture-only', cookieSecret: 'audit-fixture-cookie-secret-only',
  cookiePolicy: { requireSecure: true, trustProxyProtocol: true },
});
const reproduced = result.status === 302 && result.headers.location === 'https://example.invalid/phishing';
console.log(JSON.stringify({
  diagnostic: 'legacy-login-open-redirect', reproduced,
  status: result.status, location: result.headers.location,
  cookieIssued: Boolean(result.headers['set-cookie']),
  scope: 'legacy token login only; synthetic credential; no external request',
}, null, 2));
if (!reproduced) process.exitCode = 1;
