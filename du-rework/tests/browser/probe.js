// Quick probe: boot harness, hit operations endpoint with auth, dump HTML.
const { createAdminShellServer } = require('../../orchestrator/services/orchestrator/dist/app/admin/index.js');
const { stubFetchers } = require('./compiled-stubs.js');

async function main() {
  const handle = createAdminShellServer({
    port: 0,
    host: '127.0.0.1',
    cookieSecret: 'harness-cookie-secret-32-bytes-or-more',
    adminToken: 'role:admin:harness-secret-token',
    sectionFetchers: stubFetchers,
  });
  const { url } = await handle.listen();
  console.log('URL:', url);
  const r1 = await fetch(url + '/admin/operations?operationId=op-running', { redirect: 'manual' });
  console.log('ANON STATUS:', r1.status);
  const html1 = await r1.text();
  console.log('---ANON HTML (first 2500)---');
  console.log(html1.substring(0, 2500));
  await handle.close();
}
main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });